import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { checksEnabled } from "../checks/config.js";
import type { AppBindings } from "../config/types.js";

// Free proposals cost us the oracle fee. Token required if set or if paid checks are on.
export const guardFreeProposals: MiddlewareHandler<{ Bindings: AppBindings }> = async (c, next) => {
	const token = typeof c.env.PROPOSAL_AUTH_TOKEN === "string" ? c.env.PROPOSAL_AUTH_TOKEN : "";
	if (token === "" && !checksEnabled(c.env)) {
		return next();
	}
	if (token !== "" && isBearer(c.req.header("authorization"), token)) {
		return next();
	}
	return c.json({ success: false, message: "Free proposals require authorization" }, 401);
};

function isBearer(header: string | undefined, token: string): boolean {
	const [scheme, value] = header?.split(" ") ?? [];
	return scheme === "Bearer" && value !== undefined && timingSafeEqual(digest(value), digest(token));
}

// timingSafeEqual needs equal lengths.
function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}
