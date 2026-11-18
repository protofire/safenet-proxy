import { type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { SAFE_EVENTS, SAFE_V141_EVENTS, USDC_FUNCTIONS } from "../utils/abis.js";
import { CHECK_FEE, USDC_ADDRESS } from "./config.js";
import { decodeUsdcTransfer, hasExecutionSuccess, hasUsdcTransfer } from "./payments.js";

const SAFE: Address = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";
const FEE_COLLECTOR: Address = "0x00000000000000000000000000000000000FEE00";
const OTHER: Address = "0x9999999999999999999999999999999999999999";
const SAFE_TX_HASH: Hex = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";

const log = (address: Address, topics: Hex[], data: Hex): Log =>
	({ address, topics, data, blockNumber: 1n, logIndex: 0, transactionIndex: 0, removed: false }) as unknown as Log;

const transferLog = (from: Address, to: Address, value: bigint, token: Address = USDC_ADDRESS) =>
	log(
		token,
		encodeEventTopics({ abi: USDC_FUNCTIONS, eventName: "Transfer", args: { from, to } }) as Hex[],
		encodeAbiParameters([{ type: "uint256" }], [value]),
	);

const executionSuccessLog = (safe: Address, txHash: Hex) =>
	log(
		safe,
		encodeEventTopics({ abi: SAFE_EVENTS, eventName: "ExecutionSuccess" }) as Hex[],
		encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [txHash, 0n]),
	);

const executionSuccessV141Log = (safe: Address, txHash: Hex) =>
	log(
		safe,
		encodeEventTopics({ abi: SAFE_V141_EVENTS, eventName: "ExecutionSuccess", args: { txHash } }) as Hex[],
		encodeAbiParameters([{ type: "uint256" }], [0n]),
	);

const query = { from: SAFE, to: FEE_COLLECTOR, minValue: CHECK_FEE };

describe("hasUsdcTransfer", () => {
	it("finds a USDC transfer of at least the fee", () => {
		expect(hasUsdcTransfer([transferLog(SAFE, FEE_COLLECTOR, CHECK_FEE)], query)).toBe(true);
		expect(hasUsdcTransfer([transferLog(SAFE, FEE_COLLECTOR, CHECK_FEE + 1n)], query)).toBe(true);
	});

	it.each([
		["too small", transferLog(SAFE, FEE_COLLECTOR, CHECK_FEE - 1n)],
		["from someone else", transferLog(OTHER, FEE_COLLECTOR, CHECK_FEE)],
		["to someone else", transferLog(SAFE, OTHER, CHECK_FEE)],
		["of another token", transferLog(SAFE, FEE_COLLECTOR, CHECK_FEE, OTHER)],
	])("ignores a transfer %s", (_, transfer) => {
		expect(hasUsdcTransfer([transfer], query)).toBe(false);
	});

	it("ignores unrelated logs", () => {
		expect(hasUsdcTransfer([executionSuccessLog(SAFE, SAFE_TX_HASH)], query)).toBe(false);
	});
});

describe("hasExecutionSuccess", () => {
	it("finds the Safe's ExecutionSuccess for the transaction", () => {
		expect(hasExecutionSuccess([executionSuccessLog(SAFE, SAFE_TX_HASH)], SAFE, SAFE_TX_HASH)).toBe(true);
	});

	it("finds the ExecutionSuccess of a Safe v1.4.1, which indexes txHash", () => {
		expect(hasExecutionSuccess([executionSuccessV141Log(SAFE, SAFE_TX_HASH)], SAFE, SAFE_TX_HASH)).toBe(true);
	});

	it("ignores a v1.4.1 event for another transaction", () => {
		const otherHash: Hex = `0x${"11".repeat(32)}`;
		expect(hasExecutionSuccess([executionSuccessV141Log(SAFE, otherHash)], SAFE, SAFE_TX_HASH)).toBe(false);
	});

	it("ignores events from another contract", () => {
		expect(hasExecutionSuccess([executionSuccessLog(OTHER, SAFE_TX_HASH)], SAFE, SAFE_TX_HASH)).toBe(false);
	});

	it("ignores events for another transaction", () => {
		const otherHash: Hex = `0x${"11".repeat(32)}`;
		expect(hasExecutionSuccess([executionSuccessLog(SAFE, otherHash)], SAFE, SAFE_TX_HASH)).toBe(false);
	});
});

describe("decodeUsdcTransfer", () => {
	it("decodes transfer calldata", () => {
		const data = encodeFunctionData({
			abi: USDC_FUNCTIONS,
			functionName: "transfer",
			args: [FEE_COLLECTOR, CHECK_FEE],
		});
		expect(decodeUsdcTransfer(data)).toEqual({ to: FEE_COLLECTOR, amount: CHECK_FEE });
	});

	it.each([
		["empty", "0x"],
		["unknown", "0xdeadbeef"],
		["truncated transfer", "0xa9059cbb"],
	] as const)("returns undefined for %s calldata", (_, data) => {
		expect(decodeUsdcTransfer(data)).toBeUndefined();
	});
});
