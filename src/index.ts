import { serve } from "@hono/node-server";
import { z } from "zod";
import { app } from "./app.js";
import { configSchema } from "./config/schemas.js";
import type { AppBindings } from "./config/types.js";
import { handleQueueBatch } from "./queue/consumer.js";
import { InMemoryQueue } from "./queue/memory.js";

const portSchema = z.coerce.number().int().positive().default(8787);
const QUEUE_MAX_BATCH_SIZE = 10;
const QUEUE_MAX_BATCH_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

// Fail fast on misconfiguration instead of serving errors.
configSchema.parse(process.env);
const port = portSchema.parse(process.env.PORT);

const queue = new InMemoryQueue((messages) => handleQueueBatch(messages, process.env), {
	maxBatchSize: QUEUE_MAX_BATCH_SIZE,
	maxBatchTimeoutMs: QUEUE_MAX_BATCH_TIMEOUT_MS,
});
const bindings: AppBindings = { ...process.env, PROPOSAL_QUEUE: queue };

const server = serve(
	{
		fetch: (request) => app.fetch(request, bindings),
		port,
	},
	(info) => console.info(`Safenet proxy listening on http://${info.address}:${info.port}`),
);

// Drain the queue before exiting so a rolling deploy does not drop proposals already accepted with a 202.
function shutdown(signal: NodeJS.Signals): void {
	console.info(`Received ${signal}, shutting down`);
	setTimeout(() => {
		console.error("Shutdown timed out, exiting");
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS).unref();

	server.close();
	queue
		.close()
		.then(() => process.exit(0))
		.catch((e: unknown) => {
			console.error(`Error while draining the queue: ${String(e)}`);
			process.exit(1);
		});
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
