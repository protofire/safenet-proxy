import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../config/types.js";
import type { ProposalQueue } from "../queue/types.js";
import { guardFreeProposals } from "./auth.js";

const TOKEN = "webhook-secret";
const FEE_COLLECTOR = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";

const app = new Hono<{ Bindings: AppBindings }>();
app.post("/propose", guardFreeProposals, (c) => c.body(null, 202));

async function status(env: Record<string, string>, authorization?: string): Promise<number> {
	const bindings: AppBindings = { ...env, PROPOSAL_QUEUE: {} as ProposalQueue };
	const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
	const response = await app.request("/propose", { method: "POST", headers }, bindings);
	return response.status;
}

describe("guardFreeProposals — paid checks disabled", () => {
	it("lets requests through when no token is configured", async () => {
		expect(await status({})).toBe(202);
	});

	it("requires the token once one is configured", async () => {
		expect(await status({ PROPOSAL_AUTH_TOKEN: TOKEN })).toBe(401);
		expect(await status({ PROPOSAL_AUTH_TOKEN: TOKEN }, `Bearer ${TOKEN}`)).toBe(202);
	});
});

describe("guardFreeProposals — paid checks enabled", () => {
	it("closes free proposals when no token is configured", async () => {
		expect(await status({ FEE_COLLECTOR })).toBe(401);
		expect(await status({ FEE_COLLECTOR }, "Bearer ")).toBe(401);
	});

	it("lets requests with the configured token through", async () => {
		expect(await status({ FEE_COLLECTOR, PROPOSAL_AUTH_TOKEN: TOKEN }, `Bearer ${TOKEN}`)).toBe(202);
	});

	it("rejects a missing, wrong or malformed token", async () => {
		const env = { FEE_COLLECTOR, PROPOSAL_AUTH_TOKEN: TOKEN };
		expect(await status(env)).toBe(401);
		expect(await status(env, "Bearer wrong")).toBe(401);
		expect(await status(env, TOKEN)).toBe(401);
		expect(await status(env, `Basic ${TOKEN}`)).toBe(401);
	});
});
