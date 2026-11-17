import type { Address } from "viem";
import { arbitrum } from "viem/chains";
import z from "zod";
import { checkedAddressSchema } from "../utils/schemas.js";

// Phase 2 POC: paid Safenet checks are only offered for Safes on Arbitrum One.
export const CHECKS_CHAIN = arbitrum;
export const CHECKS_CHAIN_ID = arbitrum.id;

// Native USDC on Arbitrum (supports EIP-3009).
export const USDC_ADDRESS: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// 0.5 USDC (6 decimals), covers the 0.4 USDC.e Safenet fee plus gas.
export const CHECK_FEE = 500_000n;

export const CONFIRMATIONS = 1;

// Authorizations must stay valid long enough for the worker to settle them.
export const MIN_AUTHORIZATION_VALIDITY_SECONDS = 10 * 60;

// How long a Safe-path payment may stay unexecuted before the check expires.
export const SAFE_PAYMENT_TTL_SECONDS = 24 * 60 * 60;

export const MAX_PROPOSAL_ATTEMPTS = 3;

const jsonRecord = z.preprocess(
	(val) => (typeof val === "string" ? JSON.parse(val) : val),
	z.record(z.string(), z.string()),
);

export const checksConfigSchema = z
	.object({
		FEE_COLLECTOR: checkedAddressSchema,
		CHECKS_DB_PATH: z.string().default("data/checks.sqlite"),
		SAFE_API_KEY: z.string().optional(),
		// Reuses the proxy's existing per-chain maps; both need an entry for 42161.
		RPC_URLS: jsonRecord,
		TX_SERVICE_URLS: jsonRecord,
	})
	.transform((env) => ({
		feeCollector: env.FEE_COLLECTOR,
		dbPath: env.CHECKS_DB_PATH,
		safeApiKey: env.SAFE_API_KEY,
		rpcUrl: z.url().parse(env.RPC_URLS[String(CHECKS_CHAIN_ID)]),
		txServiceUrl: z.url().parse(env.TX_SERVICE_URLS[String(CHECKS_CHAIN_ID)]),
	}));

export type ChecksConfig = z.output<typeof checksConfigSchema>;

// Paid checks are opt-in: they are enabled only when a fee collector is configured.
export function checksEnabled(env: Record<string, unknown>): boolean {
	return typeof env.FEE_COLLECTOR === "string" && env.FEE_COLLECTOR !== "";
}
