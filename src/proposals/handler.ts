import type { Context } from "hono";
import { type Address, isAddressEqual } from "viem";
import { enabledSafes } from "../config/safes.js";
import { configSchema } from "../config/schemas.js";
import type { Config } from "../config/types.js";
import { assertMessageAffordable } from "../queue/consumer.js";
import type { QueueMessage } from "../queue/types.js";
import { safeTransactionWithDomain, type TransactionEvent, transactionEventSchema } from "../safe/schemas.js";
import { transactionDetails } from "../safe/service.js";
import { handleError } from "../utils/errors.js";

export const handleProposal = async (
	c: Context<{
		Bindings: CloudflareBindings;
	}>,
	sampled = false,
) => {
	try {
		const config = configSchema.parse(c.env);
		if (sampled && config.SAMPLE_RATE < Math.random() * 100) {
			return c.body(null, 202);
		}

		const request = transactionEventSchema.safeParse(await c.req.json());
		if (!request.success) {
			console.error(`Could not parse proposal request: ${request.error.message}`);
			return c.body(null, 202);
		}

		if (!isWebhookTypeEnabled(config, request.data.type)) {
			console.info(`Ignoring disabled event type ${request.data.type} for ${request.data.address}`);
			return c.body(null, 202);
		}

		if (sampled && !isSafeEnabled(request.data.address)) {
			console.info(`Ignoring disabled Safe ${request.data.address}`);
			return c.body(null, 202);
		}

		console.info(`Handling ${request.data.type} for ${request.data.address}`);

		const txServiceUrl = config.TX_SERVICE_URLS[String(request.data.chainId)];
		if (txServiceUrl === undefined) {
			return c.json(
				{ success: false, message: `No Transaction Service configured for chain ${request.data.chainId}` },
				422,
			);
		}

		// Resolved synchronously so the caller learns whether the transaction exists and can be paid for.
		const details = await transactionDetails(
			txServiceUrl,
			config.SAFE_API_KEY,
			request.data.chainId,
			request.data.safeTxHash,
		);
		if (details === null) {
			return c.json({ success: false, message: "Transaction not found" }, 404);
		}

		const message: QueueMessage = {
			type: "TRANSACTION",
			timestamp: Date.now(),
			sampled,
			data: details,
		};

		await assertMessageAffordable(config, message);
		await c.env.PROPOSAL_QUEUE.send(message, { contentType: "v8" });

		return c.body(null, 202);
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

export const handleTx = async (
	c: Context<{
		Bindings: CloudflareBindings;
	}>,
	sampled = false,
) => {
	try {
		const config = configSchema.parse(c.env);
		if (sampled && config.SAMPLE_RATE >= Math.random() * 100) {
			return c.body(null, 202);
		}

		const request = safeTransactionWithDomain.safeParse(await c.req.json());
		if (!request.success || (sampled && !isSafeEnabled(request.data.safe))) {
			return c.body(null, 202);
		}

		const message: QueueMessage = {
			type: "TRANSACTION",
			timestamp: Date.now(),
			sampled,
			data: request.data,
		};

		await assertMessageAffordable(config, message);
		await c.env.PROPOSAL_QUEUE.send(message, { contentType: "v8" });

		return c.body(null, 202);
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

function isWebhookTypeEnabled(config: Config, type: TransactionEvent["type"]): boolean {
	return config.WEBHOOK_TYPE === type;
}

function isSafeEnabled(safe: Address): boolean {
	return enabledSafes.length === 0 || enabledSafes.some((enabledSafe) => isAddressEqual(enabledSafe, safe));
}
