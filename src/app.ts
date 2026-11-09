import { Hono } from "hono";
import { cors } from "hono/cors";
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
