import { type Address, decodeFunctionData, type Hex, isAddressEqual, type Log, parseEventLogs } from "viem";
import type { MultisigTransaction } from "../safe/types.js";
import { SAFE_EVENTS, USDC_FUNCTIONS } from "../utils/abis.js";
import { CHECK_FEE, USDC_ADDRESS } from "./config.js";

// Pure checks on payment transactions and receipts, kept free of I/O so they are easy to test.

type TransferQuery = { from: Address; to: Address; minValue: bigint };

export function hasUsdcTransfer(logs: Log[], { from, to, minValue }: TransferQuery): boolean {
	return parseEventLogs({ abi: USDC_FUNCTIONS, eventName: "Transfer", logs }).some(
		(log) =>
			isAddressEqual(log.address, USDC_ADDRESS) &&
			isAddressEqual(log.args.from, from) &&
			isAddressEqual(log.args.to, to) &&
			log.args.value >= minValue,
	);
}

export function hasExecutionSuccess(logs: Log[], safe: Address, safeTxHash: Hex): boolean {
	return parseEventLogs({ abi: SAFE_EVENTS, eventName: "ExecutionSuccess", logs }).some(
		(log) => isAddressEqual(log.address, safe) && log.args.txHash.toLowerCase() === safeTxHash.toLowerCase(),
	);
}

// Returns why a Safe transaction is not a valid fee payment, or undefined if it is one.
// A valid payment is a plain call USDC.transfer(feeCollector, amount >= fee).
export function invalidSafePaymentReason(tx: MultisigTransaction, feeCollector: Address): string | undefined {
	if (!isAddressEqual(tx.to, USDC_ADDRESS)) {
		return "Payment transaction must call USDC";
	}
	if (tx.value !== 0n || tx.operation !== 0) {
		return "Payment transaction must be a call with no value";
	}
	const transfer = decodeUsdcTransfer(tx.data);
	if (transfer === undefined) {
		return "Payment transaction must be a USDC transfer";
	}
	if (!isAddressEqual(transfer.to, feeCollector)) {
		return "Payment transaction must transfer to the fee collector";
	}
	if (transfer.amount < CHECK_FEE) {
		return `Payment transaction must transfer at least ${CHECK_FEE}`;
	}
	return undefined;
}

export function decodeUsdcTransfer(data: Hex): { to: Address; amount: bigint } | undefined {
	try {
		const decoded = decodeFunctionData({ abi: USDC_FUNCTIONS, data });
		if (decoded.functionName !== "transfer") {
			return undefined;
		}
		const [to, amount] = decoded.args;
		return { to, amount };
	} catch {
		return undefined;
	}
}
