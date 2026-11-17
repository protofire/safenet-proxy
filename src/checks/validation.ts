import { type Hex, isAddressEqual, type PublicClient, recoverTypedDataAddress } from "viem";
import { multisigTransaction } from "../safe/service.js";
import { checkNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "./authorization.js";
import {
	CHECK_FEE,
	type ChecksConfig,
	MIN_AUTHORIZATION_VALIDITY_SECONDS,
	SAFE_PAYMENT_TTL_SECONDS,
} from "./config.js";
import { decodeUsdcTransfer, invalidSafePaymentReason } from "./payments.js";
import { type CheckStore, nowSeconds } from "./store.js";
import type { Check, CheckRequest, Eip3009Payment, NewCheck, SafeTxPayment } from "./types.js";
import { isAuthorizationUsed, readUsdcDomain, usdcBalance } from "./usdc.js";

export type CheckRequestErrorStatus = 400 | 402 | 409 | 422;

export class CheckRequestError extends Error {
	constructor(
		readonly status: CheckRequestErrorStatus,
		message: string,
		// Set for 409: the check that already exists for the transaction.
		readonly existing?: Check,
	) {
		super(message);
		this.name = "CheckRequestError";
	}
}

export type ValidationContext = {
	config: ChecksConfig;
	client: PublicClient;
	store: CheckStore;
};

// Validates a check request and returns the row to insert. Throws CheckRequestError when invalid.
export async function validateCheckRequest(ctx: ValidationContext, request: CheckRequest): Promise<NewCheck> {
	assertNoActiveCheck(ctx.store, request);
	return request.payment.type === "eip3009"
		? validateEip3009(ctx, request, request.payment)
		: validateSafeTx(ctx, request, request.payment);
}

// A check can be requested again only if the previous attempt never took the user's money.
export function isReopenable(check: Check): boolean {
	return check.status === "EXPIRED" || (check.status === "FAILED" && check.payment_tx_hash === null);
}

function assertNoActiveCheck(store: CheckStore, request: CheckRequest): void {
	const existing = store.getCheckByTx(request.chainId, request.safeTxHash);
	if (existing !== undefined && !isReopenable(existing)) {
		throw new CheckRequestError(409, "A check already exists for this transaction", existing);
	}
}

async function validateEip3009(ctx: ValidationContext, request: CheckRequest, payment: Eip3009Payment) {
	const { authorization, signature } = payment;
	assertAuthorizationTerms(ctx.config, request, payment);
	await assertSignedBy(ctx.client, payment);

	if (await isAuthorizationUsed(ctx.client, authorization.from, authorization.nonce)) {
		throw new CheckRequestError(400, "Authorization has already been used");
	}
	await assertBalance(ctx.client, authorization.from, authorization.value);
	await assertTargetPending(ctx.config, request);

	return {
		chain_id: request.chainId,
		safe: request.safe,
		safe_tx_hash: request.safeTxHash,
		payment_type: "eip3009",
		payer: authorization.from,
		amount: authorization.value.toString(),
		auth_json: JSON.stringify(authorization, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
		signature,
		auth_nonce: authorization.nonce,
		payment_safe_tx_hash: null,
		expires_at: Number(authorization.validBefore),
	} satisfies NewCheck;
}

function assertAuthorizationTerms(config: ChecksConfig, request: CheckRequest, { authorization }: Eip3009Payment) {
	if (!isAddressEqual(authorization.to, config.feeCollector)) {
		throw new CheckRequestError(400, "Authorization must pay the fee collector");
	}
	if (authorization.value < CHECK_FEE) {
		throw new CheckRequestError(400, `Authorization value must be at least ${CHECK_FEE}`);
	}
	if (authorization.nonce.toLowerCase() !== checkNonce(request.chainId, request.safe, request.safeTxHash)) {
		throw new CheckRequestError(400, "Authorization nonce does not match the transaction");
	}
	const now = BigInt(nowSeconds());
	if (authorization.validAfter > now) {
		throw new CheckRequestError(400, "Authorization is not valid yet");
	}
	if (authorization.validBefore <= now + BigInt(MIN_AUTHORIZATION_VALIDITY_SECONDS)) {
		throw new CheckRequestError(400, "Authorization expires too soon");
	}
}

async function assertSignedBy(client: PublicClient, { authorization, signature }: Eip3009Payment) {
	const { name, version } = await readUsdcDomain(client);
	let signer: Hex;
	try {
		signer = await recoverTypedDataAddress({
			domain: usdcDomain(name, version),
			types: TRANSFER_WITH_AUTHORIZATION_TYPES,
			primaryType: "TransferWithAuthorization",
			message: authorization,
			signature,
		});
	} catch {
		throw new CheckRequestError(400, "Invalid authorization signature");
	}
	if (!isAddressEqual(signer, authorization.from)) {
		throw new CheckRequestError(400, "Authorization is not signed by its sender");
	}
}

async function validateSafeTx(ctx: ValidationContext, request: CheckRequest, payment: SafeTxPayment) {
	const { config, store } = ctx;
	const used = store.getCheckByPaymentSafeTxHash(payment.paymentSafeTxHash);
	if (used !== undefined && !isReopenable(used)) {
		throw new CheckRequestError(409, "Payment transaction is already used by another check", used);
	}

	const paymentTx = await multisigTransaction(config.txServiceUrl, config.safeApiKey, payment.paymentSafeTxHash);
	if (paymentTx === null || !isAddressEqual(paymentTx.safe, request.safe)) {
		throw new CheckRequestError(400, "Payment transaction not found for this Safe");
	}
	const reason = invalidSafePaymentReason(paymentTx, config.feeCollector);
	if (reason !== undefined) {
		throw new CheckRequestError(400, reason);
	}
	if (paymentTx.isExecuted && paymentTx.isSuccessful === false) {
		throw new CheckRequestError(400, "Payment transaction failed");
	}
	const amount = decodeUsdcTransfer(paymentTx.data)?.amount ?? CHECK_FEE;
	if (!paymentTx.isExecuted) {
		await assertBalance(ctx.client, request.safe, amount);
	}
	await assertTargetPending(config, request);

	return {
		chain_id: request.chainId,
		safe: request.safe,
		safe_tx_hash: request.safeTxHash,
		payment_type: "safeTx",
		payer: request.safe,
		amount: amount.toString(),
		auth_json: null,
		signature: null,
		auth_nonce: null,
		payment_safe_tx_hash: payment.paymentSafeTxHash,
		expires_at: nowSeconds() + SAFE_PAYMENT_TTL_SECONDS,
	} satisfies NewCheck;
}

async function assertBalance(client: PublicClient, owner: Hex, required: bigint) {
	const balance = await usdcBalance(client, owner);
	if (balance < required) {
		throw new CheckRequestError(402, `${owner} holds ${balance} USDC units but needs ${required}`);
	}
}

async function assertTargetPending(config: ChecksConfig, request: CheckRequest) {
	const target = await multisigTransaction(config.txServiceUrl, config.safeApiKey, request.safeTxHash);
	if (target === null || !isAddressEqual(target.safe, request.safe)) {
		throw new CheckRequestError(422, "Target transaction not found for this Safe");
	}
	if (target.isExecuted) {
		throw new CheckRequestError(422, "Target transaction is already executed");
	}
}
