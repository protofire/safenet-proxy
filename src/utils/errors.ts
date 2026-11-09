import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

export class InsufficientBalanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InsufficientBalanceError";
	}
}

export const handleError = (error: unknown) => {
	// 402 rather than 5xx: an underfunded payer won't recover within a client's retry
	// window, so callers should fail immediately instead of retrying.
	if (error instanceof InsufficientBalanceError) {
		return {
			response: {
				success: false,
				message: error.message,
			},
			code: 402 as ContentfulStatusCode,
		};
	}
	if (error instanceof ZodError) {
		return {
			response: {
				success: false,
				message: "Validation failed",
				issues: error.issues,
			},
			code: 400 as ContentfulStatusCode,
		};
	}
	if (error instanceof Error) {
		return {
			response: {
				success: false,
				message: error.message,
			},
			code: 500 as ContentfulStatusCode,
		};
	}
	return {
		response: {
			success: false,
			message: "Unknown error",
		},
		code: 500 as ContentfulStatusCode,
	};
};
