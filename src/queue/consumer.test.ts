import { type Address, encodeFunctionData, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { configSchema } from "../config/schemas.js";
import { encodeMultiSendCall } from "../safe/multisend.js";
import { encodeSafeRelayTransaction } from "../safe/relay.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { BETA_CONSENSUS_FUNCTIONS, CONSENSUS_FUNCTIONS } from "../utils/abis.js";
import { InsufficientBalanceError } from "../utils/errors.js";
import { assertMessageAffordable, handleQueueBatch } from "./consumer.js";
import type { QueueMessage } from "./types.js";

// Partially mock viem: keep real utilities (BaseError, encodeFunctionData, etc.)
// but replace the network-connecting client factories with fakes.
vi.mock("viem", async (importOriginal) => {
	const actual = await importOriginal<typeof import("viem")>();
	return {
		...actual,
		createPublicClient: vi.fn(),
		createWalletClient: vi.fn(),
	};
});

// ---- fixtures ---------------------------------------------------------------

const VALID_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR: Address = privateKeyToAccount(VALID_PRIVATE_KEY).address;
const TEST_API_KEY = "some_random_api_key";
const SEPOLIA_RPC = "https://sepolia.example.com";
const SEPOLIA_ID = "11155111";
// Distinct from the consensus config address used below, so tests can tell a
// relayed call (targets the safe) apart from a direct call (targets the consensus config).
const SAFE_ADDRESS: Address = "0x9999999999999999999999999999999999999999";
const MULTI_SEND_ADDRESS: Address = "0x7777777777777777777777777777777777777777";
const RELAYING_SAFE_ENTRY = { safe: SAFE_ADDRESS, multiSend: MULTI_SEND_ADDRESS };
const ORACLE_ADDRESS: Address = "0x4444444444444444444444444444444444444444";
const FEE_TOKEN_ADDRESS: Address = "0x5555555555555555555555555555555555555555";
// 0.4 USDC (6 decimals)
const ORACLE_FEE = 400_000n;

const ENV = {
	PRIVATE_KEY: VALID_PRIVATE_KEY,
	SAFE_API_KEY: TEST_API_KEY,
	RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
	TX_SERVICE_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
	CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: zeroAddress }] }),
	RELAYING_SAFES: JSON.stringify({ [SEPOLIA_ID]: RELAYING_SAFE_ENTRY }),
	CHAIN_IDS: SEPOLIA_ID,
	SAMPLE_RATE: "0",
};

// A variant of ENV with no relaying Safe configured, exercising the fallback
// path where the consensus contract is called directly, one call per transaction.
const ENV_WITHOUT_RELAY = {
	...ENV,
	RELAYING_SAFES: JSON.stringify({}),
};

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
	safe: zeroAddress,
	chainId: 1n,
};

const VALID_BODY: QueueMessage = {
	type: "TRANSACTION",
	timestamp: Date.now(),
	sampled: false,
	data: SAFE_TX,
};

const INVALID_BODY = { not: "a valid queue message" };

// ---- mock client setup ------------------------------------------------------

let mockSendTransaction: Mock;
let mockEstimateFeesPerGas: Mock;
let mockGetTransactionCount: Mock;
let mockGetBalance: Mock;
let mockReadContract: Mock;

beforeEach(async () => {
	const viem = await import("viem");

	mockSendTransaction = vi.fn().mockResolvedValue("0xtxhash");
	mockEstimateFeesPerGas = vi.fn().mockResolvedValue({
		maxFeePerGas: 1_000_000_000n,
		maxPriorityFeePerGas: 1_000_000n,
	});
	mockGetTransactionCount = vi.fn().mockResolvedValue(5);
	mockGetBalance = vi.fn().mockResolvedValue(1_000_000_000_000_000_000_000n);
	mockReadContract = vi.fn(async ({ functionName }: { functionName: string }) => {
		switch (functionName) {
			case "FEE_TOKEN":
				return FEE_TOKEN_ADDRESS;
			case "fee":
				return ORACLE_FEE;
			case "balanceOf":
			case "allowance":
				return 1_000_000_000n;
			default:
				throw new Error(`Unexpected readContract call: ${functionName}`);
		}
	});

	(viem.createPublicClient as Mock).mockReturnValue({
		estimateFeesPerGas: mockEstimateFeesPerGas,
		getTransactionCount: mockGetTransactionCount,
		getBalance: mockGetBalance,
		readContract: mockReadContract,
	});

	(viem.createWalletClient as Mock).mockReturnValue({
		sendTransaction: mockSendTransaction,
	});
});

// ---- tests ------------------------------------------------------------------

describe("handleQueueBatch", () => {
	it("submits one transaction per message (no relaying Safe configured)", async () => {
		const messages = [VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, ENV_WITHOUT_RELAY);

		expect(mockSendTransaction).toHaveBeenCalledTimes(2);
	});

	it("skips messages that fail to parse", async () => {
		await handleQueueBatch([VALID_BODY, INVALID_BODY], ENV);

		// Only the valid message produces a submission
		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
	});

	it("resolves even when sendTransaction rejects", async () => {
		mockSendTransaction.mockRejectedValue(new Error("nonce too low"));

		await expect(handleQueueBatch([VALID_BODY], ENV)).resolves.toBeUndefined();
	});

	it("resolves even when fee estimation fails for the chain", async () => {
		mockEstimateFeesPerGas.mockRejectedValue(new Error("RPC unreachable"));

		await expect(handleQueueBatch([VALID_BODY], ENV)).resolves.toBeUndefined();
	});

	it("submits to all configured chains", async () => {
		const viem = await import("viem");

		const sepoliaSend = vi.fn().mockResolvedValue("0xsepolia");
		const mainnetSend = vi.fn().mockResolvedValue("0xmainnet");

		// Return distinct wallet clients per call so we can track per-chain sends
		(viem.createWalletClient as Mock)
			.mockReturnValueOnce({ sendTransaction: sepoliaSend })
			.mockReturnValueOnce({ sendTransaction: mainnetSend });

		const multiChainEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,1",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "1": "https://mainnet.example.com" }),
			TX_SERVICE_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "1": "https://mainnet.example.com" }),
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: zeroAddress }],
				"1": [{ address: zeroAddress }],
			}),
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY, "1": RELAYING_SAFE_ENTRY }),
			SAMPLE_RATE: "0",
		};

		const messages = [VALID_BODY];
		await handleQueueBatch(messages, multiChainEnv);

		// Each chain should receive exactly one submission
		expect(sepoliaSend).toHaveBeenCalledOnce();
		expect(mainnetSend).toHaveBeenCalledOnce();
	});

	it("passes sequential nonces within a batch (no relaying Safe configured)", async () => {
		mockGetTransactionCount.mockResolvedValue(7);

		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, ENV_WITHOUT_RELAY);

		const nonces = mockSendTransaction.mock.calls.map((args) => (args[0] as { nonce: number }).nonce);
		expect(nonces).toEqual([7, 8, 9]);
	});

	it("submits one transaction per consensus config for each message, with sequential nonces (no relaying Safe configured)", async () => {
		const addr1 = "0x1111111111111111111111111111111111111111";
		const addr2 = "0x2222222222222222222222222222222222222222";

		const multiAddressEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			TX_SERVICE_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: addr1 }, { address: addr2 }] }),
			RELAYING_SAFES: JSON.stringify({}),
			SAMPLE_RATE: "0",
		};

		mockGetTransactionCount.mockResolvedValue(7);

		// 2 queue messages x 2 consensus configs = 4 sends
		const messages = [VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, multiAddressEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(4);
		const calls = mockSendTransaction.mock.calls.map((args) => args[0] as { to: string; nonce: number });
		expect(calls.map((c) => c.to)).toEqual([addr1, addr2, addr1, addr2]);
		expect(calls.map((c) => c.nonce)).toEqual([7, 8, 9, 10]);
	});

	it("falls back to sending directly to the consensus address when no relaying Safe is configured for the chain", async () => {
		const messages = [VALID_BODY];
		await handleQueueBatch(messages, ENV_WITHOUT_RELAY);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(zeroAddress);
	});

	it("submits via the oracle variant of proposeTransaction when the single consensus entry has an oracle configured (no relaying Safe configured)", async () => {
		const consensusAddr = "0x3333333333333333333333333333333333333333";
		const oracleAddr = "0x4444444444444444444444444444444444444444";

		const oracleEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			TX_SERVICE_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: consensusAddr, oracle: oracleAddr }] }),
			RELAYING_SAFES: JSON.stringify({}),
			SAMPLE_RATE: "0",
		};

		const expectedData = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [oracleAddr, "0x", SAFE_TX],
		});

		const messages = [VALID_BODY];
		await handleQueueBatch(messages, oracleEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(consensusAddr);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
	});

	it("uses a higher gas limit for oracle-configured targets to cover their extra on-chain logic", async () => {
		await handleQueueBatch([VALID_BODY], ENV);
		const plainGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		mockSendTransaction.mockClear();

		const oracleEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			TX_SERVICE_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({
				[SEPOLIA_ID]: [{ address: zeroAddress, oracle: zeroAddress }],
			}),
			RELAYING_SAFES: JSON.stringify({ [SEPOLIA_ID]: RELAYING_SAFE_ENTRY }),
			SAMPLE_RATE: "0",
		};

		await handleQueueBatch([VALID_BODY], oracleEnv);
		const oracleGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		expect(oracleGas).toBeGreaterThan(plainGas);
	});

	it("encodes each consensus config's transaction individually when only some entries have an oracle configured (no relaying Safe configured)", async () => {
		const addr1 = "0x1111111111111111111111111111111111111111";
		const addr2 = "0x2222222222222222222222222222222222222222";
		const oracleAddr = "0x4444444444444444444444444444444444444444";

		const mixedEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			TX_SERVICE_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({
				[SEPOLIA_ID]: [{ address: addr1 }, { address: addr2, oracle: oracleAddr }],
			}),
			RELAYING_SAFES: JSON.stringify({}),
			SAMPLE_RATE: "0",
		};

		const plainCallData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const oracleCallData = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [oracleAddr, "0x", SAFE_TX],
		});

		const messages = [VALID_BODY];
		await handleQueueBatch(messages, mixedEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(2);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(addr1);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(plainCallData);
		expect(mockSendTransaction.mock.calls[1][0].to).toBe(addr2);
		expect(mockSendTransaction.mock.calls[1][0].data).toBe(oracleCallData);
	});
});

describe("handleQueueBatch — relaying Safe routing", () => {
	it("wraps a lone proposeTransaction call directly in execTransaction, without a MultiSend batch", async () => {
		const innerData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const expectedData = encodeSafeRelayTransaction(OPERATOR, { to: zeroAddress, value: 0n, data: innerData });

		const messages = [VALID_BODY];
		await handleQueueBatch(messages, ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
	});

	it("uses a higher gas limit for a relayed call than a direct call, to cover execTransaction's overhead", async () => {
		await handleQueueBatch([VALID_BODY], ENV_WITHOUT_RELAY);
		const directGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		mockSendTransaction.mockClear();

		await handleQueueBatch([VALID_BODY], ENV);
		const relayedGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		expect(relayedGas).toBeGreaterThan(directGas);
	});

	it("relays for chains with a configured Safe while falling back to a direct call for chains without one", async () => {
		const viem = await import("viem");

		const relayedSend = vi.fn().mockResolvedValue("0xrelayed");
		const directSend = vi.fn().mockResolvedValue("0xdirect");

		(viem.createWalletClient as Mock)
			.mockReturnValueOnce({ sendTransaction: relayedSend })
			.mockReturnValueOnce({ sendTransaction: directSend });

		const mixedChainEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,1",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "1": "https://mainnet.example.com" }),
			TX_SERVICE_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "1": "https://mainnet.example.com" }),
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: zeroAddress }],
				"1": [{ address: zeroAddress }],
			}),
			// Only chain 11155111 has a relaying Safe configured.
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY }),
			SAMPLE_RATE: "0",
		};

		const messages = [VALID_BODY];
		await handleQueueBatch(messages, mixedChainEnv);

		expect(relayedSend).toHaveBeenCalledOnce();
		expect(relayedSend.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(directSend).toHaveBeenCalledOnce();
		expect(directSend.mock.calls[0][0].to).toBe(zeroAddress);
	});
});

describe("handleQueueBatch — batching via MultiSend", () => {
	it("batches multiple proposals into a single execTransaction via MultiSend when they fit under MAX_BATCH_GAS", async () => {
		const innerData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const innerCall = { to: zeroAddress, value: 0n, data: innerData };
		const expectedData = encodeSafeRelayTransaction(
			OPERATOR,
			encodeMultiSendCall(MULTI_SEND_ADDRESS, [innerCall, innerCall, innerCall]),
		);

		// 3 messages against a single consensus config comfortably fit under the
		// default 5,000,000 gas cap, so they should collapse into one MultiSend batch.
		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
	});

	it("uses a single sequential nonce for a batched MultiSend transaction, regardless of how many calls it contains", async () => {
		mockGetTransactionCount.mockResolvedValue(9);

		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].nonce).toBe(9);
	});

	it("splits proposals into separate execTransaction submissions when MAX_BATCH_GAS is too small to combine them", async () => {
		const tightGasEnv = { ...ENV, MAX_BATCH_GAS: "1" };
		mockGetTransactionCount.mockResolvedValue(9);

		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, tightGasEnv);

		// Each call alone already exceeds the configured limit, so none are combined -
		// but each is still sent (an over-limit call can't be dropped, only isolated).
		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
		for (const call of mockSendTransaction.mock.calls) {
			expect((call[0] as { to: string }).to).toBe(SAFE_ADDRESS);
		}
		const nonces = mockSendTransaction.mock.calls.map((args) => (args[0] as { nonce: number }).nonce);
		expect(nonces).toEqual([9, 10, 11]);
	});

	it("does not batch direct (non-relayed) calls, regardless of MAX_BATCH_GAS", async () => {
		const largeBatchGasEnv = { ...ENV_WITHOUT_RELAY, MAX_BATCH_GAS: "50000000" };

		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, largeBatchGasEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
	});
});

describe("handleQueueBatch — consensus contracts disabled for sampled transactions", () => {
	const ENABLED_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
	const DISABLED_ADDRESS: Address = "0x2222222222222222222222222222222222222222";

	const env = {
		...ENV_WITHOUT_RELAY,
		CONSENSUS_CONFIGS: JSON.stringify({
			[SEPOLIA_ID]: [{ address: ENABLED_ADDRESS }, { address: DISABLED_ADDRESS, disableSampled: true }],
		}),
	};

	const submittedTargets = () => mockSendTransaction.mock.calls.map((args) => (args[0] as { to: Address }).to);

	it("skips disabled consensus contracts for sampled transactions", async () => {
		await handleQueueBatch([{ ...VALID_BODY, sampled: true }], env);

		expect(submittedTargets()).toEqual([ENABLED_ADDRESS]);
	});

	it("submits to all consensus contracts for transactions that are not sampled", async () => {
		await handleQueueBatch([{ ...VALID_BODY, sampled: false }], env);

		expect(submittedTargets()).toEqual([ENABLED_ADDRESS, DISABLED_ADDRESS]);
	});

	it("treats messages without a sampled flag as not sampled", async () => {
		const { sampled: _, ...legacyBody } = VALID_BODY;
		await handleQueueBatch([legacyBody], env);

		expect(submittedTargets()).toEqual([ENABLED_ADDRESS, DISABLED_ADDRESS]);
	});

	it("submits nothing for sampled transactions when all consensus contracts are disabled", async () => {
		const allDisabledEnv = {
			...ENV_WITHOUT_RELAY,
			CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: DISABLED_ADDRESS, disableSampled: true }] }),
		};
		await expect(handleQueueBatch([{ ...VALID_BODY, sampled: true }], allDisabledEnv)).resolves.toBeUndefined();

		expect(mockSendTransaction).not.toHaveBeenCalled();
	});
});

describe("handleQueueBatch — funding checks", () => {
	const oracleEnv = {
		...ENV_WITHOUT_RELAY,
		CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: zeroAddress, oracle: ORACLE_ADDRESS }] }),
	};
	const relayedOracleEnv = { ...oracleEnv, RELAYING_SAFES: JSON.stringify({ [SEPOLIA_ID]: RELAYING_SAFE_ENTRY }) };

	function mockTokenBalances(balances: Record<Address, bigint>) {
		const fallback = mockReadContract.getMockImplementation();
		mockReadContract.mockImplementation(async (call: { functionName: string; args?: [Address] }) =>
			call.functionName === "balanceOf" ? (balances[call.args?.[0] as Address] ?? 0n) : fallback?.(call),
		);
	}

	let consoleError: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		consoleError.mockRestore();
	});

	it("fails the chain batch without sending anything when the sponsor cannot cover the gas", async () => {
		mockGetBalance.mockResolvedValue(0n);

		const messages = [VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, ENV_WITHOUT_RELAY);

		expect(mockSendTransaction).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(`${OPERATOR} on chain ${SEPOLIA_ID} holds 0 ETH`),
		);
	});

	it("requires one oracle fee per proposal routed through the oracle, failing the batch otherwise", async () => {
		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];

		mockTokenBalances({ [OPERATOR]: ORACLE_FEE * 2n });
		await handleQueueBatch(messages, oracleEnv);
		expect(mockSendTransaction).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(`${OPERATOR} on chain ${SEPOLIA_ID} holds 800000 of token ${FEE_TOKEN_ADDRESS}`),
		);

		mockTokenBalances({ [OPERATOR]: ORACLE_FEE * 3n });
		await handleQueueBatch(messages, oracleEnv);
		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
	});

	it("requires the proposer to have approved the oracle fees to each oracle", async () => {
		const fallback = mockReadContract.getMockImplementation();
		mockReadContract.mockImplementation(async (call: { functionName: string; args?: [Address, Address] }) =>
			call.functionName === "allowance" ? ORACLE_FEE * 2n : fallback?.(call),
		);

		const messages = [VALID_BODY, VALID_BODY, VALID_BODY];
		await handleQueueBatch(messages, oracleEnv);

		expect(mockSendTransaction).not.toHaveBeenCalled();
		expect(mockReadContract).toHaveBeenCalledWith(
			expect.objectContaining({ functionName: "allowance", args: [OPERATOR, ORACLE_ADDRESS] }),
		);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining(`${OPERATOR} on chain ${SEPOLIA_ID} has approved 800000 of token ${FEE_TOKEN_ADDRESS}`),
		);
	});

	it("reads each oracle's fee once per batch regardless of how many proposals it receives", async () => {
		await handleQueueBatch([VALID_BODY, VALID_BODY, VALID_BODY], oracleEnv);

		const readsOf = (functionName: string) =>
			mockReadContract.mock.calls.filter(([call]) => call.functionName === functionName).length;
		expect(readsOf("fee")).toBe(1);
		expect(readsOf("FEE_TOKEN")).toBe(1);
		expect(readsOf("allowance")).toBe(1);
		expect(readsOf("balanceOf")).toBe(1);
		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
	});

	it("charges oracle fees to the relaying Safe rather than the sponsor when relaying", async () => {
		mockTokenBalances({ [OPERATOR]: 0n, [SAFE_ADDRESS]: ORACLE_FEE });
		await handleQueueBatch([VALID_BODY], relayedOracleEnv);
		expect(mockSendTransaction).toHaveBeenCalledTimes(1);

		mockSendTransaction.mockClear();
		mockTokenBalances({ [OPERATOR]: ORACLE_FEE, [SAFE_ADDRESS]: 0n });
		await handleQueueBatch([VALID_BODY], relayedOracleEnv);
		expect(mockSendTransaction).not.toHaveBeenCalled();
	});

	it("rejects a single message upfront when its payers cannot cover it, without submitting", async () => {
		mockTokenBalances({ [OPERATOR]: ORACLE_FEE - 1n });

		await expect(assertMessageAffordable(configSchema.parse(oracleEnv), VALID_BODY)).rejects.toBeInstanceOf(
			InsufficientBalanceError,
		);
		expect(mockSendTransaction).not.toHaveBeenCalled();
	});

	it("accepts a single message upfront when its payers can cover it", async () => {
		await expect(assertMessageAffordable(configSchema.parse(oracleEnv), VALID_BODY)).resolves.toBeUndefined();
	});

	it("does not fail unfunded payers when there is nothing to submit", async () => {
		mockGetBalance.mockResolvedValue(0n);
		mockTokenBalances({});
		const noSubmissionsEnv = {
			...oracleEnv,
			CONSENSUS_CONFIGS: JSON.stringify({
				[SEPOLIA_ID]: [{ address: zeroAddress, oracle: ORACLE_ADDRESS, disableSampled: true }],
			}),
		};

		await handleQueueBatch([{ ...VALID_BODY, sampled: true }], noSubmissionsEnv);

		expect(consoleError).not.toHaveBeenCalled();
	});
});
