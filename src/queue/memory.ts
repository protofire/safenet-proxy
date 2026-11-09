import type { ProposalQueue, QueueMessage } from "./types.js";

export type BatchHandler = (messages: QueueMessage[]) => Promise<void>;

export type InMemoryQueueOptions = {
	maxBatchSize: number;
	maxBatchTimeoutMs: number;
};

// Batches are processed one at a time so consecutive batches never submit transactions
// concurrently. Messages live in memory only: whatever is still waiting when the process
// exits without awaiting `close()` is lost.
export class InMemoryQueue implements ProposalQueue {
	private waiting: QueueMessage[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private processing: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly handler: BatchHandler,
		private readonly options: InMemoryQueueOptions,
	) {}

	async send(message: QueueMessage): Promise<void> {
		if (this.closed) {
			throw new Error("Queue is closed");
		}
		this.waiting.push(message);
		if (this.waiting.length >= this.options.maxBatchSize) {
			this.flush();
		} else if (this.flushTimer === undefined) {
			this.flushTimer = setTimeout(() => this.flush(), this.options.maxBatchTimeoutMs);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.flush();
		await this.processing;
	}

	private flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.waiting.length === 0) {
			return;
		}
		const batch = this.waiting;
		this.waiting = [];
		this.processing = this.processing
			.then(() => this.handler(batch))
			.catch((e: unknown) => {
				console.error(`Failed to process batch of ${batch.length} message(s): ${String(e)}`);
			});
	}
}
