import type z from "zod";
import type { queueMessageSchema } from "./schemas.js";

export type QueueMessage = z.output<typeof queueMessageSchema>;

export interface ProposalQueue {
	send(message: QueueMessage): Promise<void>;
}
