import { Hono } from "hono";
import { type Address, encodeFunctionData, type Hex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../config/types.js";
import type { MultisigTransaction } from "../safe/types.js";
import { USDC_FUNCTIONS } from "../utils/abis.js";
import { checkNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "./authorization.js";
import { CHECK_FEE, CHECKS_CHAIN_ID, USDC_ADDRESS } from "./config.js";
import { handleCreateCheck, handleGetCheck, handleQuote } from "./handler.js";
import { CheckStore, nowSeconds } from "./store.js";

const { usdc, multisigTransaction } = vi.hoisted(() => ({
	usdc: {
		originClient: vi.fn(() => ({})),
		readUsdcDomain: vi.fn(),
		isAuthorizationUsed: vi.fn(),
		usdcBalance: vi.fn(),
	},
	multisigTransaction: vi.fn(),
}));

vi.mock("./usdc.js", () => usdc);
vi.mock("../safe/service.js", () => ({ multisigTransaction }));

// ---- fixtures ---------------------------------------------------------------

const owner = privateKeyToAccount(generatePrivateKey());
const SAFE: Address = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";
const OTHER_SAFE: Address = "0x9999999999999999999999999999999999999999";
const FEE_COLLECTOR: Address = "0x00000000000000000000000000000000000FEE00";
const SAFE_TX_HASH: Hex = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";
const PAYMENT_SAFE_TX_HASH: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";
const USDC_NAME = "USD Coin";
const USDC_VERSION = "2";

const ENV = {
	FEE_COLLECTOR,
	RPC_URLS: JSON.stringify({ [CHECKS_CHAIN_ID]: "https://arbitrum.example.com" }),
	TX_SERVICE_URLS: JSON.stringify({ [CHECKS_CHAIN_ID]: "https://tx-arbitrum.example.com" }),
};

const multisigTx = (overrides: Partial<MultisigTransaction> = {}): MultisigTransaction => ({
	safe: SAFE,
	to: zeroAddress,
	value: 0n,
	data: "0x",
	operation: 0,
	safeTxGas: 0n,
	baseGas: 0n,
	gasPrice: 0n,
	gasToken: zeroAddress,
	refundReceiver: zeroAddress,
	nonce: 0n,
	isExecuted: false,
	isSuccessful: null,
	transactionHash: null,
	...overrides,
});

const feeTransfer = (to: Address = FEE_COLLECTOR, amount: bigint = CHECK_FEE): Hex =>
	encodeFunctionData({ abi: USDC_FUNCTIONS, functionName: "transfer", args: [to, amount] });

type AuthorizationInput = {
	from: Address;
	to: Address;
	value: bigint;
	validAfter: bigint;
	validBefore: bigint;
	nonce: Hex;
};

const authorization = (overrides: Partial<AuthorizationInput> = {}): AuthorizationInput => ({
	from: owner.address,
	to: FEE_COLLECTOR,
	value: CHECK_FEE,
	validAfter: 0n,
	validBefore: BigInt(nowSeconds() + 3600),
	nonce: checkNonce(CHECKS_CHAIN_ID, SAFE, SAFE_TX_HASH),
	...overrides,
});

const sign = (message: AuthorizationInput) =>
	owner.signTypedData({
		domain: usdcDomain(USDC_NAME, USDC_VERSION),
		types: TRANSFER_WITH_AUTHORIZATION_TYPES,
		primaryType: "TransferWithAuthorization",
		message,
	});

async function walletBody(auth = authorization(), signature?: Hex, chainId: number = CHECKS_CHAIN_ID) {
	return {
		chainId,
		safe: SAFE,
		safeTxHash: SAFE_TX_HASH,
		payment: {
			type: "eip3009",
			authorization: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, String(v)])),
			signature: signature ?? (await sign(auth)),
		},
	};
}

const safeBody = (paymentSafeTxHash: Hex = PAYMENT_SAFE_TX_HASH) => ({
	chainId: CHECKS_CHAIN_ID,
	safe: SAFE,
	safeTxHash: SAFE_TX_HASH,
	payment: { type: "safeTx", paymentSafeTxHash },
});

// ---- helpers ----------------------------------------------------------------

const app = new Hono<{ Bindings: AppBindings }>();
app.get("/v1/quote/:chainId", (c) => handleQuote(c));
app.post("/v1/checks", (c) => handleCreateCheck(c));
app.get("/v1/checks/:chainId/:safeTxHash", (c) => handleGetCheck(c));

let store: CheckStore;

const bindings = (): AppBindings => ({ ...ENV, PROPOSAL_QUEUE: { send: vi.fn() }, CHECKS_STORE: store });

async function postCheck(body: unknown) {
	const response = await app.request(
		"/v1/checks",
		{ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
		bindings(),
	);
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

// Target and payment transactions as returned by the Transaction Service.
function serviceReturns(txs: Record<Hex, MultisigTransaction | null>) {
	multisigTransaction.mockImplementation(async (_url: string, _key: string, hash: Hex) => txs[hash] ?? null);
}

beforeEach(() => {
	store = new CheckStore(":memory:");
	usdc.readUsdcDomain.mockResolvedValue({ name: USDC_NAME, version: USDC_VERSION });
	usdc.isAuthorizationUsed.mockResolvedValue(false);
	usdc.usdcBalance.mockResolvedValue(10_000_000n);
	serviceReturns({
		[SAFE_TX_HASH]: multisigTx(),
		[PAYMENT_SAFE_TX_HASH]: multisigTx({ to: USDC_ADDRESS, data: feeTransfer() }),
	});
	vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
});

// ---- tests ------------------------------------------------------------------

describe("GET /v1/quote/:chainId", () => {
	it("returns the fee for Arbitrum", async () => {
		const response = await app.request(`/v1/quote/${CHECKS_CHAIN_ID}`, {}, bindings());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			token: USDC_ADDRESS,
			fee: "500000",
			feeCollector: FEE_COLLECTOR,
			chainId: CHECKS_CHAIN_ID,
		});
	});

	it("rejects other chains", async () => {
		const response = await app.request("/v1/quote/1", {}, bindings());
		expect(response.status).toBe(400);
	});
});

describe("POST /v1/checks with a wallet payment", () => {
	it("accepts a valid authorization and stores a pending check", async () => {
		const { status, json } = await postCheck(await walletBody());

		expect(status).toBe(202);
		expect(json.status).toBe("PENDING_PAYMENT");
		const stored = store.getCheckByTx(CHECKS_CHAIN_ID, SAFE_TX_HASH);
		expect(stored).toMatchObject({ id: json.id, payment_type: "eip3009", payer: owner.address, amount: "500000" });
	});

	it("rejects unsupported chains", async () => {
		const { status } = await postCheck(await walletBody(authorization(), undefined, 1));
		expect(status).toBe(400);
	});

	it("rejects malformed bodies", async () => {
		const { status } = await postCheck({ chainId: CHECKS_CHAIN_ID, safe: SAFE });
		expect(status).toBe(400);
	});

	it.each([
		["a different recipient", { to: OTHER_SAFE }],
		["a value below the fee", { value: CHECK_FEE - 1n }],
		["a nonce for another transaction", { nonce: checkNonce(CHECKS_CHAIN_ID, OTHER_SAFE, SAFE_TX_HASH) }],
		["an authorization expiring within 10 minutes", { validBefore: BigInt(nowSeconds() + 300) }],
		["an authorization not valid yet", { validAfter: BigInt(nowSeconds() + 300) }],
	])("rejects %s", async (_, overrides) => {
		const { status } = await postCheck(await walletBody(authorization(overrides)));
		expect(status).toBe(400);
	});

	it("rejects a signature from someone other than the sender", async () => {
		const auth = authorization();
		const otherSigner = privateKeyToAccount(generatePrivateKey());
		const signature = await otherSigner.signTypedData({
			domain: usdcDomain(USDC_NAME, USDC_VERSION),
			types: TRANSFER_WITH_AUTHORIZATION_TYPES,
			primaryType: "TransferWithAuthorization",
			message: auth,
		});
		const { status } = await postCheck(await walletBody(auth, signature));
		expect(status).toBe(400);
	});

	it("rejects a signature over a different token domain", async () => {
		usdc.readUsdcDomain.mockResolvedValue({ name: USDC_NAME, version: "1" });
		const { status } = await postCheck(await walletBody());
		expect(status).toBe(400);
	});

	it("rejects an authorization that was already used", async () => {
		usdc.isAuthorizationUsed.mockResolvedValue(true);
		const { status } = await postCheck(await walletBody());
		expect(status).toBe(400);
	});

	it("returns 402 when the sender lacks USDC", async () => {
		usdc.usdcBalance.mockResolvedValue(CHECK_FEE - 1n);
		const { status } = await postCheck(await walletBody());
		expect(status).toBe(402);
	});

	it.each([
		["missing", null],
		["executed", multisigTx({ isExecuted: true })],
		["owned by another Safe", multisigTx({ safe: OTHER_SAFE })],
	])("returns 422 when the target transaction is %s", async (_, target) => {
		serviceReturns({ [SAFE_TX_HASH]: target });
		const { status } = await postCheck(await walletBody());
		expect(status).toBe(422);
	});

	it("returns 409 with the existing check when one is active", async () => {
		const first = await postCheck(await walletBody());
		const second = await postCheck(await walletBody());

		expect(second.status).toBe(409);
		expect(second.json).toMatchObject({ id: first.json.id, status: "PENDING_PAYMENT" });
	});

	it("replaces an expired check", async () => {
		const first = await postCheck(await walletBody());
		store.updateCheck(first.json.id as string, { status: "EXPIRED" });

		const second = await postCheck(await walletBody());

		expect(second.status).toBe(202);
		expect(store.getCheckByTx(CHECKS_CHAIN_ID, SAFE_TX_HASH)?.id).toBe(second.json.id);
	});
});

describe("POST /v1/checks with a Safe payment", () => {
	it("accepts a valid payment transaction", async () => {
		const { status, json } = await postCheck(safeBody());

		expect(status).toBe(202);
		const stored = store.getCheckByTx(CHECKS_CHAIN_ID, SAFE_TX_HASH);
		expect(stored).toMatchObject({
			id: json.id,
			payment_type: "safeTx",
			payer: SAFE,
			payment_safe_tx_hash: PAYMENT_SAFE_TX_HASH,
		});
		expect(stored?.expires_at).toBeGreaterThan(nowSeconds() + 23 * 3600);
	});

	it.each([
		["missing", null],
		["from another Safe", multisigTx({ safe: OTHER_SAFE, to: USDC_ADDRESS, data: feeTransfer() })],
		["not calling USDC", multisigTx({ to: OTHER_SAFE, data: feeTransfer() })],
		["sending value", multisigTx({ to: USDC_ADDRESS, data: feeTransfer(), value: 1n })],
		["a delegatecall", multisigTx({ to: USDC_ADDRESS, data: feeTransfer(), operation: 1 })],
		["not a transfer", multisigTx({ to: USDC_ADDRESS, data: "0x12345678" })],
		["paying someone else", multisigTx({ to: USDC_ADDRESS, data: feeTransfer(OTHER_SAFE) })],
		["paying less than the fee", multisigTx({ to: USDC_ADDRESS, data: feeTransfer(FEE_COLLECTOR, CHECK_FEE - 1n) })],
		[
			"executed but failed",
			multisigTx({ to: USDC_ADDRESS, data: feeTransfer(), isExecuted: true, isSuccessful: false }),
		],
	])("rejects a payment transaction %s", async (_, payment) => {
		serviceReturns({ [SAFE_TX_HASH]: multisigTx(), [PAYMENT_SAFE_TX_HASH]: payment });
		const { status } = await postCheck(safeBody());
		expect(status).toBe(400);
	});

	it("returns 402 when the Safe lacks USDC for an unexecuted payment", async () => {
		usdc.usdcBalance.mockResolvedValue(0n);
		const { status } = await postCheck(safeBody());
		expect(status).toBe(402);
	});

	it("returns 422 when the target transaction is executed", async () => {
		serviceReturns({
			[SAFE_TX_HASH]: multisigTx({ isExecuted: true }),
			[PAYMENT_SAFE_TX_HASH]: multisigTx({ to: USDC_ADDRESS, data: feeTransfer() }),
		});
		const { status } = await postCheck(safeBody());
		expect(status).toBe(422);
	});

	it("returns 409 when the payment transaction is used by another check", async () => {
		const otherTarget: Hex = "0x2222222222222222222222222222222222222222222222222222222222222222";
		serviceReturns({
			[SAFE_TX_HASH]: multisigTx(),
			[otherTarget]: multisigTx(),
			[PAYMENT_SAFE_TX_HASH]: multisigTx({ to: USDC_ADDRESS, data: feeTransfer() }),
		});
		expect((await postCheck({ ...safeBody(), safeTxHash: otherTarget })).status).toBe(202);

		const { status } = await postCheck(safeBody());
		expect(status).toBe(409);
	});
});

describe("GET /v1/checks/:chainId/:safeTxHash", () => {
	it("returns the check", async () => {
		const created = await postCheck(await walletBody());
		const response = await app.request(`/v1/checks/${CHECKS_CHAIN_ID}/${SAFE_TX_HASH}`, {}, bindings());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: created.json.id,
			status: "PENDING_PAYMENT",
			paymentType: "eip3009",
			paymentTxHash: null,
			proposalTxHash: null,
			error: null,
		});
	});

	it("returns 404 for unknown checks", async () => {
		const response = await app.request(`/v1/checks/${CHECKS_CHAIN_ID}/${SAFE_TX_HASH}`, {}, bindings());
		expect(response.status).toBe(404);
	});
});
