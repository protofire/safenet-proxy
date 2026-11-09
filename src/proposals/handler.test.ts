import { Hono } from "hono";
import { type Address, zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../config/types.js";
import type { QueueMessage } from "../queue/types.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { InsufficientBalanceError } from "../utils/errors.js";
import { handleProposal, handleTx } from "./handler.js";

const { enabledSafes, transactionDetails, assertMessageAffordable } = vi.hoisted(() => ({
	enabledSafes: [] as Address[],
	transactionDetails: vi.fn(),
	assertMessageAffordable: vi.fn(),
}));

vi.mock("../config/safes.js", () => ({ enabledSafes }));
vi.mock("../safe/service.js", () => ({ transactionDetails }));
vi.mock("../queue/consumer.js", () => ({ assertMessageAffordable }));

// ---- fixtures ---------------------------------------------------------------

const SAFE_ADDRESS: Address = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";
const OTHER_SAFE_ADDRESS: Address = "0x9999999999999999999999999999999999999999";
const SAFE_TX_HASH = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";
const TX_SERVICE_URL = "https://tx-sepolia.example.com";

const SAFE_TX: SafeTransactionWithDomain = {
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
	safe: SAFE_ADDRESS,
	chainId: 11155111n,
};

const BASE_ENV = {
	PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	SAFE_API_KEY: "some_random_api_key",
	RPC_URLS: JSON.stringify({ "11155111": "https://sepolia.example.com" }),
	TX_SERVICE_URLS: JSON.stringify({ "11155111": TX_SERVICE_URL }),
	CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: zeroAddress }] }),
	CHAIN_IDS: "11155111",
};

const event = (type: string, address: Address = SAFE_ADDRESS, chainId = "11155111") => ({
	type,
	chainId,
	address,
	safeTxHash: SAFE_TX_HASH,
});

const serializeTx = (tx: SafeTransactionWithDomain) =>
	JSON.stringify(tx, (_, value) => (typeof value === "bigint" ? value.toString() : value));

// ---- helpers ----------------------------------------------------------------

const app = new Hono<{ Bindings: AppBindings }>();
app.post("/propose", (c) => handleProposal(c));
app.post("/sampled", (c) => handleProposal(c, true));
app.post("/tx", (c) => handleTx(c));
app.post("/tx-sampled", (c) => handleTx(c, true));

async function post(
	path: string,
	body: string,
	env: Record<string, string> = {},
	inheritBaseEnv = true,
): Promise<QueueMessage[]> {
	const { response, sent } = await request(path, body, env, inheritBaseEnv);
	expect(response.status).toBe(202);
	return sent;
}

async function request(
	path: string,
	body: string,
	env: Record<string, string> = {},
	inheritBaseEnv = true,
): Promise<{ response: Response; sent: QueueMessage[] }> {
	const sent: QueueMessage[] = [];
	const bindings: AppBindings = {
		...(inheritBaseEnv ? BASE_ENV : {}),
		...env,
		PROPOSAL_QUEUE: {
			send: async (message: QueueMessage) => {
				sent.push(message);
			},
		},
	};
	const response = await app.request(path, { method: "POST", body }, bindings);
	return { response, sent };
}

beforeEach(() => {
	enabledSafes.length = 0;
	transactionDetails.mockReset();
	transactionDetails.mockResolvedValue(SAFE_TX);
	assertMessageAffordable.mockReset();
	assertMessageAffordable.mockResolvedValue(undefined);
});

// ---- tests ------------------------------------------------------------------

describe("handleProposal — webhook types", () => {
	it("queues executed transactions by default", async () => {
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("ignores pending transactions by default", async () => {
		const sent = await post("/propose", JSON.stringify(event("PENDING_MULTISIG_TRANSACTION")));
		expect(sent).toEqual([]);
	});

	it("queues pending transactions when configured", async () => {
		const sent = await post("/propose", JSON.stringify(event("PENDING_MULTISIG_TRANSACTION")), {
			WEBHOOK_TYPE: "PENDING_MULTISIG_TRANSACTION",
		});
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("ignores executed transactions when only pending transactions are configured", async () => {
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")), {
			WEBHOOK_TYPE: "PENDING_MULTISIG_TRANSACTION",
		});
		expect(sent).toEqual([]);
	});

	it("ignores unsupported webhook types", async () => {
		const sent = await post("/propose", JSON.stringify(event("INCOMING_ETHER")));
		expect(sent).toEqual([]);
	});
});

describe("handleProposal — Transaction Service lookup", () => {
	it("fetches the transaction from the Transaction Service configured for the event's chain", async () => {
		await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));
		expect(transactionDetails).toHaveBeenCalledWith(TX_SERVICE_URL, BASE_ENV.SAFE_API_KEY, 11155111n, SAFE_TX_HASH);
	});

	it("passes an undefined API key when none is configured", async () => {
		const { SAFE_API_KEY, ...envWithoutApiKey } = BASE_ENV;
		await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")), envWithoutApiKey, false);
		expect(transactionDetails).toHaveBeenCalledWith(TX_SERVICE_URL, undefined, 11155111n, SAFE_TX_HASH);
	});

	it("responds 422 and queues nothing for chains without a configured Transaction Service", async () => {
		const { response, sent } = await request(
			"/propose",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS, "1")),
		);
		expect(response.status).toBe(422);
		expect(transactionDetails).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("responds 404 and queues nothing when the transaction cannot be fetched", async () => {
		transactionDetails.mockResolvedValue(null);
		const { response, sent } = await request("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));
		expect(response.status).toBe(404);
		expect(sent).toEqual([]);
	});
});

describe("handleProposal — funding", () => {
	it("responds 402 and queues nothing when the transaction cannot be paid for", async () => {
		assertMessageAffordable.mockRejectedValue(new InsufficientBalanceError("sponsor is broke"));

		const { response, sent } = await request("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));

		expect(response.status).toBe(402);
		expect(await response.json()).toEqual({ success: false, message: "sponsor is broke" });
		expect(sent).toEqual([]);
	});
});

describe("handleProposal — enabled Safes", () => {
	// A sample rate of 100 ensures sampled requests are never dropped by sampling.
	const SAMPLED_ENV = { SAMPLE_RATE: "100" };

	it("queues transactions of an enabled Safe when sampled", async () => {
		enabledSafes.push(SAFE_ADDRESS);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toHaveLength(1);
	});

	it("matches enabled Safes regardless of address casing", async () => {
		enabledSafes.push(SAFE_ADDRESS.toLowerCase() as Address);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toHaveLength(1);
	});

	it("ignores transactions of a Safe that is not enabled when sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toEqual([]);
	});

	it("queues transactions of a Safe that is not enabled when not sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)));
		expect(sent).toHaveLength(1);
	});
});

describe("handleTx — enabled Safes", () => {
	// A sample rate of 0 ensures sampled requests are never dropped by sampling.
	const SAMPLED_ENV = { SAMPLE_RATE: "0" };

	it("queues transactions of any Safe when no Safes are enabled", async () => {
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("queues transactions of an enabled Safe when sampled", async () => {
		enabledSafes.push(SAFE_ADDRESS);
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toHaveLength(1);
	});

	it("ignores transactions of a Safe that is not enabled when sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toEqual([]);
	});

	it("queues transactions of a Safe that is not enabled when not sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/tx", serializeTx(SAFE_TX));
		expect(sent).toHaveLength(1);
	});
});

describe("handleTx — funding", () => {
	it("responds 402 and queues nothing when the transaction cannot be paid for", async () => {
		assertMessageAffordable.mockRejectedValue(new InsufficientBalanceError("sponsor is broke"));

		const { response, sent } = await request("/tx", serializeTx(SAFE_TX));

		expect(response.status).toBe(402);
		expect(await response.json()).toEqual({ success: false, message: "sponsor is broke" });
		expect(sent).toEqual([]);
	});
});

describe("sampled flag", () => {
	it("marks proposals from the sampled endpoint as sampled", async () => {
		const sent = await post("/sampled", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")), {
			SAMPLE_RATE: "100",
		});
		expect(sent).toEqual([expect.objectContaining({ sampled: true })]);
	});

	it("marks proposals from the regular endpoint as not sampled", async () => {
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));
		expect(sent).toEqual([expect.objectContaining({ sampled: false })]);
	});

	it("marks transactions from the sampled endpoint as sampled", async () => {
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), { SAMPLE_RATE: "0" });
		expect(sent).toEqual([expect.objectContaining({ sampled: true })]);
	});

	it("marks transactions from the regular endpoint as not sampled", async () => {
		const sent = await post("/tx", serializeTx(SAFE_TX));
		expect(sent).toEqual([expect.objectContaining({ sampled: false })]);
	});
});
