import type { Context } from "hono";
import type { AppBindings } from "../config/types.js";
import { handleError } from "../utils/errors.js";
import { CHECK_FEE, CHECKS_CHAIN_ID, checksConfigSchema, USDC_ADDRESS } from "./config.js";
import { checkParamsSchema, checkRequestSchema } from "./schemas.js";
import type { CheckStore } from "./store.js";
import type { Check } from "./types.js";
import { originClient } from "./usdc.js";
import { CheckRequestError, isReopenable, validateCheckRequest } from "./validation.js";

type AppContext = Context<{ Bindings: AppBindings }>;

export const handleQuote = (c: AppContext) => {
	try {
		const chainId = Number(c.req.param("chainId"));
		if (chainId !== CHECKS_CHAIN_ID) {
			return c.json({ success: false, message: `Paid checks are only supported on chain ${CHECKS_CHAIN_ID}` }, 400);
		}
		requireStore(c);
		const config = checksConfigSchema.parse(c.env);
		return c.json({ token: USDC_ADDRESS, fee: CHECK_FEE.toString(), feeCollector: config.feeCollector, chainId });
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

export const handleCreateCheck = async (c: AppContext) => {
	try {
		const store = requireStore(c);
		const request = checkRequestSchema.parse(await c.req.json());
		if (request.chainId !== CHECKS_CHAIN_ID) {
			return c.json({ success: false, message: `Paid checks are only supported on chain ${CHECKS_CHAIN_ID}` }, 400);
		}
		const config = checksConfigSchema.parse(c.env);
		const newCheck = await validateCheckRequest({ config, client: originClient(config.rpcUrl), store }, request);

		// A previous expired or unpaid attempt holds the same unique nonce / payment hash; replace it.
		const previous = store.getCheckByTx(request.chainId, request.safeTxHash);
		if (previous !== undefined && isReopenable(previous)) {
			store.deleteCheck(previous.id);
		}
		const check = store.insertCheck(newCheck);
		console.info(
			JSON.stringify({ event: "check_created", id: check.id, status: check.status, type: check.payment_type }),
		);
		return c.json({ id: check.id, status: check.status }, 202);
	} catch (e: unknown) {
		if (e instanceof CheckRequestError) {
			const body = e.existing
				? { ...checkView(e.existing), message: e.message }
				: { success: false, message: e.message };
			return c.json(body, e.status);
		}
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

export const handleGetCheck = (c: AppContext) => {
	try {
		const store = requireStore(c);
		const params = checkParamsSchema.parse(c.req.param());
		const check = store.getCheckByTx(params.chainId, params.safeTxHash);
		if (check === undefined) {
			return c.json({ success: false, message: "Check not found" }, 404);
		}
		return c.json(checkView(check));
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

function requireStore(c: AppContext): CheckStore {
	if (c.env.CHECKS_STORE === undefined) {
		throw new Error("Paid checks are not enabled (FEE_COLLECTOR is not configured)");
	}
	return c.env.CHECKS_STORE;
}

export function checkView(check: Check) {
	return {
		id: check.id,
		status: check.status,
		paymentType: check.payment_type,
		paymentTxHash: check.payment_tx_hash,
		proposalTxHash: check.proposal_tx_hash,
		error: check.last_error,
	};
}
