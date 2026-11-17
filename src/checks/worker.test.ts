import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../config/schemas.js";
import { SAFE_EVENTS, USDC_FUNCTIONS } from "../utils/abis.js";
import { CHECK_FEE, CHECKS_CHAIN_ID, type ChecksConfig, USDC_ADDRESS } from "./config.js";
import { CheckStore, nowSeconds } from "./store.js";
import type { NewCheck } from "./types.js";
import { CheckWorker } from "./worker.js";

const { usdc, client, service, proposeNow } = vi.hoisted(() => {
	const client = { waitForTransactionReceipt: vi.fn() };
	return {
		client,
		usdc: {
			originClient: vi.fn(() => client),
			isAuthorizationUsed: vi.fn(),
			settleAuthorization: vi.fn(),
			findAuthorizationTx: vi.fn(),
		},
		service: { multisigTransaction: vi.fn(), transactionDetails: vi.fn() },
		proposeNow: vi.fn(),
	};
});

vi.mock("./usdc.js", () => usdc);
vi.mock("../safe/service.js", () => service);
vi.mock("../queue/consumer.js", () => ({ proposeNow }));

// ---- fixtures ---------------------------------------------------------------

const OWNER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SAFE: Address = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";
const FEE_COLLECTOR: Address = "0x00000000000000000000000000000000000FEE00";
const SAFE_TX_HASH: Hex = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";
const PAYMENT_SAFE_TX_HASH: Hex = `0x${"11".repeat(32)}`;
const NONCE: Hex = `0x${"22".repeat(32)}`;
const PAYMENT_TX: Hex = `0x${"aa".repeat(32)}`;
const PROPOSAL_TX: Hex = `0x${"bb".repeat(32)}`;
const SIGNATURE: Hex = `0x${"33".repeat(65)}`;

const CHECKS_CONFIG: ChecksConfig = {
	feeCollector: FEE_COLLECTOR,
	dbPath: ":memory:",
	safeApiKey: undefined,
	rpcUrl: "https://arbitrum.example.com",
	txServiceUrl: "https://tx-arbitrum.example.com",
};
const PROXY_CONFIG = configSchema.parse({
	PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	RPC_URLS: JSON.stringify({ "100": "https://gnosis.example.com" }),
	TX_SERVICE_URLS: JSON.stringify({}),
	CONSENSUS_CONFIGS: JSON.stringify({ "100": [{ address: zeroAddress }] }),
	CHAIN_IDS: "100",
});

const walletCheck = (validBefore = nowSeconds() + 3600): NewCheck => ({
	chain_id: CHECKS_CHAIN_ID,
	safe: SAFE,
	safe_tx_hash: SAFE_TX_HASH,
	payment_type: "eip3009",
	payer: OWNER,
	amount: CHECK_FEE.toString(),
	auth_json: JSON.stringify({
		from: OWNER,
		to: FEE_COLLECTOR,
		value: CHECK_FEE.toString(),
		validAfter: "0",
		validBefore: String(validBefore),
		nonce: NONCE,
	}),
	signature: SIGNATURE,
	auth_nonce: NONCE,
	payment_safe_tx_hash: null,
	expires_at: validBefore,
});

const safeCheck = (expiresAt = nowSeconds() + 3600): NewCheck => ({
	...walletCheck(),
	payment_type: "safeTx",
	payer: SAFE,
	auth_json: null,
	signature: null,
	auth_nonce: null,
	payment_safe_tx_hash: PAYMENT_SAFE_TX_HASH,
	expires_at: expiresAt,
});

const log = (address: Address, topics: Hex[], data: Hex) =>
	({ address, topics, data, blockNumber: 1n, logIndex: 0, transactionIndex: 0, removed: false }) as unknown as Log;

const transferLog = (from: Address) =>
	log(
		USDC_ADDRESS,
		encodeEventTopics({ abi: USDC_FUNCTIONS, eventName: "Transfer", args: { from, to: FEE_COLLECTOR } }) as Hex[],
		encodeAbiParameters([{ type: "uint256" }], [CHECK_FEE]),
	);

const executionSuccessLog = () =>
	log(
		SAFE,
		encodeEventTopics({ abi: SAFE_EVENTS, eventName: "ExecutionSuccess" }) as Hex[],
		encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [PAYMENT_SAFE_TX_HASH, 0n]),
	);

const receipt = (logs: Log[], status = "success") => ({ status, logs });

const executedPayment = (overrides = {}) => ({
	safe: SAFE,
	isExecuted: true,
	isSuccessful: true,
	transactionHash: PAYMENT_TX,
	...overrides,
});

// ---- setup ------------------------------------------------------------------

let store: CheckStore;
let worker: CheckWorker;

const current = () => store.getCheckByTx(CHECKS_CHAIN_ID, SAFE_TX_HASH);

beforeEach(() => {
	store = new CheckStore(":memory:");
	worker = new CheckWorker(store, CHECKS_CONFIG, PROXY_CONFIG);
	usdc.isAuthorizationUsed.mockResolvedValue(false);
	usdc.settleAuthorization.mockResolvedValue(PAYMENT_TX);
	service.transactionDetails.mockResolvedValue({ safe: SAFE, to: zeroAddress });
	proposeNow.mockResolvedValue([PROPOSAL_TX]);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

// ---- tests ------------------------------------------------------------------

// A single tick moves a check as far as it can: a payment confirmed in this tick is proposed right away.
describe("wallet payments", () => {
	it("settles the authorization, then proposes", async () => {
		client.waitForTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER)]));
		store.insertCheck(walletCheck());

		await worker.tick();

		expect(current()).toMatchObject({
			status: "PROPOSED",
			payment_tx_hash: PAYMENT_TX,
			proposal_tx_hash: PROPOSAL_TX,
		});
	});

	it("uses the front-runner's transaction when the authorization is already used", async () => {
		usdc.isAuthorizationUsed.mockResolvedValue(true);
		usdc.findAuthorizationTx.mockResolvedValue(PAYMENT_TX);
		client.waitForTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER)]));
		store.insertCheck(walletCheck());

		await worker.tick();

		expect(usdc.settleAuthorization).not.toHaveBeenCalled();
		expect(current()).toMatchObject({ status: "PROPOSED", payment_tx_hash: PAYMENT_TX });
	});

	it("does not settle again when a settlement was already sent", async () => {
		client.waitForTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER)]));
		const { id } = store.insertCheck(walletCheck());
		store.updateCheck(id, { payment_tx_hash: PAYMENT_TX });

		await worker.tick();

		expect(usdc.settleAuthorization).not.toHaveBeenCalled();
		expect(current()?.status).toBe("PROPOSED");
	});

	it("expires authorizations that were never settled", async () => {
		store.insertCheck(walletCheck(nowSeconds() - 1));

		await worker.tick();

		expect(current()?.status).toBe("EXPIRED");
	});

	it("fails when the settlement has no fee transfer", async () => {
		client.waitForTransactionReceipt.mockResolvedValue(receipt([]));
		store.insertCheck(walletCheck());

		await worker.tick();

		expect(current()).toMatchObject({ status: "FAILED", payment_tx_hash: PAYMENT_TX });
	});

	it("retries when the settlement reverts", async () => {
		client.waitForTransactionReceipt.mockResolvedValue(receipt([], "reverted"));
		store.insertCheck(walletCheck());

		await worker.tick();

		expect(current()).toMatchObject({ status: "PENDING_PAYMENT", payment_tx_hash: null });
	});
});

describe("Safe payments", () => {
	it("proposes once the payment is executed with the expected logs", async () => {
		service.multisigTransaction.mockResolvedValue(executedPayment());
		client.waitForTransactionReceipt.mockResolvedValue(receipt([executionSuccessLog(), transferLog(SAFE)]));
		store.insertCheck(safeCheck());

		await worker.tick();

		expect(current()).toMatchObject({ status: "PROPOSED", payment_tx_hash: PAYMENT_TX });
	});

	it("waits while the payment is not executed", async () => {
		service.multisigTransaction.mockResolvedValue(executedPayment({ isExecuted: false, transactionHash: null }));
		store.insertCheck(safeCheck());

		await worker.tick();

		expect(current()?.status).toBe("PENDING_PAYMENT");
	});

	it("expires when the payment is not executed in time", async () => {
		service.multisigTransaction.mockResolvedValue(executedPayment({ isExecuted: false, transactionHash: null }));
		store.insertCheck(safeCheck(nowSeconds() - 1));

		await worker.tick();

		expect(current()?.status).toBe("EXPIRED");
	});

	it.each([
		["the Safe's ExecutionSuccess", [transferLog(SAFE)]],
		["the fee transfer", [executionSuccessLog()]],
	])("fails when the receipt lacks %s", async (_, logs) => {
		service.multisigTransaction.mockResolvedValue(executedPayment());
		client.waitForTransactionReceipt.mockResolvedValue(receipt(logs));
		store.insertCheck(safeCheck());

		await worker.tick();

		expect(current()?.status).toBe("FAILED");
	});
});

describe("proposals", () => {
	it("fails after three unsuccessful attempts", async () => {
		proposeNow.mockRejectedValue(new Error("out of gas"));
		const { id } = store.insertCheck(walletCheck());
		store.updateCheck(id, { status: "PAID", payment_tx_hash: PAYMENT_TX });

		await worker.tick();
		await worker.tick();
		expect(current()).toMatchObject({ status: "PAID", attempts: 2 });

		await worker.tick();
		expect(current()).toMatchObject({ status: "FAILED", attempts: 3, last_error: "out of gas" });
	});
});
