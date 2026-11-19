import type { Address, Hex } from "viem";
import type z from "zod";
import type { checkRequestSchema, eip3009PaymentSchema, safeTxPaymentSchema } from "./schemas.js";

export type CheckStatus = "PENDING_PAYMENT" | "PAID" | "PROPOSED" | "EXPIRED" | "FAILED";
export type PaymentType = "eip3009" | "safeTx";

// One row of the `checks` table. Timestamps are unix seconds; amounts are decimal strings.
export type Check = {
	id: string;
	chain_id: number;
	safe: Address;
	safe_tx_hash: Hex;
	payment_type: PaymentType;
	payer: Address;
	amount: string;
	auth_json: string | null;
	signature: Hex | null;
	auth_nonce: Hex | null;
	payment_safe_tx_hash: Hex | null;
	payment_tx_hash: Hex | null;
	proposal_tx_hash: string | null;
	status: CheckStatus;
	attempts: number;
	last_error: string | null;
	expires_at: number;
	created_at: number;
	updated_at: number;
};

export type NewCheck = Pick<
	Check,
	| "chain_id"
	| "safe"
	| "safe_tx_hash"
	| "payment_type"
	| "payer"
	| "amount"
	| "auth_json"
	| "signature"
	| "auth_nonce"
	| "payment_safe_tx_hash"
	| "expires_at"
>;

export type CheckUpdate = Partial<
	Pick<Check, "status" | "payment_tx_hash" | "proposal_tx_hash" | "attempts" | "last_error">
>;

export type CheckRequest = z.output<typeof checkRequestSchema>;
export type Eip3009Payment = z.output<typeof eip3009PaymentSchema>;
export type SafeTxPayment = z.output<typeof safeTxPaymentSchema>;
export type Authorization = Eip3009Payment["authorization"];
