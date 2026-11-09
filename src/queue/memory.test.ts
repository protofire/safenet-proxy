import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryQueue } from "./memory.js";
import type { QueueMessage } from "./types.js";

const MESSAGE: QueueMessage = {
	type: "TRANSACTION",
	timestamp: 0,
	sampled: false,
	data: {
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
	},
};

const OPTIONS = { maxBatchSize: 3, maxBatchTimeoutMs: 5_000 };

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("InMemoryQueue", () => {
	it("flushes a batch as soon as maxBatchSize messages are waiting", async () => {
		const handler = vi.fn().mockResolvedValue(undefined);
		const queue = new InMemoryQueue(handler, OPTIONS);

		await queue.send(MESSAGE);
		await queue.send(MESSAGE);
		expect(handler).not.toHaveBeenCalled();

		await queue.send(MESSAGE);
		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledExactlyOnceWith([MESSAGE, MESSAGE, MESSAGE]);
	});

	it("flushes a partial batch once maxBatchTimeoutMs has passed since the first message", async () => {
		const handler = vi.fn().mockResolvedValue(undefined);
		const queue = new InMemoryQueue(handler, OPTIONS);

		await queue.send(MESSAGE);
		await vi.advanceTimersByTimeAsync(OPTIONS.maxBatchTimeoutMs - 1);
		expect(handler).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(handler).toHaveBeenCalledExactlyOnceWith([MESSAGE]);
	});

	it("processes batches one at a time, in order", async () => {
		const first = Promise.withResolvers<void>();
		const handler = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
		const queue = new InMemoryQueue(handler, { ...OPTIONS, maxBatchSize: 1 });

		await queue.send(MESSAGE);
		await queue.send({ ...MESSAGE, timestamp: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(1);

		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(2);
		expect(handler).toHaveBeenLastCalledWith([{ ...MESSAGE, timestamp: 1 }]);
	});

	it("keeps processing later batches when the handler rejects", async () => {
		const handler = vi.fn().mockRejectedValueOnce(new Error("RPC unreachable")).mockResolvedValue(undefined);
		const queue = new InMemoryQueue(handler, { ...OPTIONS, maxBatchSize: 1 });

		await queue.send(MESSAGE);
		await vi.advanceTimersByTimeAsync(0);
		await queue.send(MESSAGE);
		await vi.advanceTimersByTimeAsync(0);

		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("flushes waiting messages and waits for them on close", async () => {
		const handled: QueueMessage[][] = [];
		const handler = vi.fn(async (messages: QueueMessage[]) => {
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			handled.push(messages);
		});
		const queue = new InMemoryQueue(handler, OPTIONS);

		await queue.send(MESSAGE);
		const closing = queue.close();
		await vi.advanceTimersByTimeAsync(100);
		await closing;

		expect(handled).toEqual([[MESSAGE]]);
	});

	it("rejects messages sent after close", async () => {
		const queue = new InMemoryQueue(vi.fn().mockResolvedValue(undefined), OPTIONS);
		await queue.close();
		await expect(queue.send(MESSAGE)).rejects.toThrow("Queue is closed");
	});
});
