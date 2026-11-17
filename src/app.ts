import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleCreateCheck, handleGetCheck, handleQuote } from "./checks/handler.js";
import type { AppBindings } from "./config/types.js";
import { handleProposal, handleTx } from "./proposals/handler.js";

export const app = new Hono<{ Bindings: AppBindings }>();

app.use("/*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/tx", async (c) => {
	return handleTx(c);
});

app.post("/propose", async (c) => {
	return handleProposal(c);
});

app.post("/sampled", async (c) => {
	return handleProposal(c, true);
});

// Phase 2 POC: user-paid Safenet checks.
app.get("/v1/quote/:chainId", (c) => handleQuote(c));
app.post("/v1/checks", (c) => handleCreateCheck(c));
app.get("/v1/checks/:chainId/:safeTxHash", (c) => handleGetCheck(c));
