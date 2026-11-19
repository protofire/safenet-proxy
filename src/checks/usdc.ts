import {
	type Account,
	type Address,
	createPublicClient,
	createWalletClient,
	type Hex,
	http,
	type PublicClient,
	parseSignature,
} from "viem";
import { USDC_FUNCTIONS } from "../utils/abis.js";
import { CHECKS_CHAIN, USDC_ADDRESS } from "./config.js";
import type { Authorization } from "./types.js";

// All on-chain reads and writes for the origin chain (Arbitrum) go through this module.

export function originClient(rpcUrl: string): PublicClient {
	return createPublicClient({ chain: CHECKS_CHAIN, transport: http(rpcUrl) });
}

let cachedDomain: Promise<{ name: string; version: string }> | undefined;

export function readUsdcDomain(client: PublicClient): Promise<{ name: string; version: string }> {
	cachedDomain ??= Promise.all([
		client.readContract({ address: USDC_ADDRESS, abi: USDC_FUNCTIONS, functionName: "name" }),
		client.readContract({ address: USDC_ADDRESS, abi: USDC_FUNCTIONS, functionName: "version" }),
	])
		.then(([name, version]) => ({ name, version }))
		.catch((e: unknown) => {
			cachedDomain = undefined;
			throw e;
		});
	return cachedDomain;
}

export function isAuthorizationUsed(client: PublicClient, from: Address, nonce: Hex): Promise<boolean> {
	return client.readContract({
		address: USDC_ADDRESS,
		abi: USDC_FUNCTIONS,
		functionName: "authorizationState",
		args: [from, nonce],
	});
}

export function usdcBalance(client: PublicClient, owner: Address): Promise<bigint> {
	return client.readContract({ address: USDC_ADDRESS, abi: USDC_FUNCTIONS, functionName: "balanceOf", args: [owner] });
}

export async function settleAuthorization(
	rpcUrl: string,
	account: Account,
	authorization: Authorization,
	signature: Hex,
): Promise<Hex> {
	const client = createWalletClient({ chain: CHECKS_CHAIN, account, transport: http(rpcUrl) });
	const { r, s, v, yParity } = parseSignature(signature);
	const { from, to, value, validAfter, validBefore, nonce } = authorization;
	return client.writeContract({
		address: USDC_ADDRESS,
		abi: USDC_FUNCTIONS,
		functionName: "transferWithAuthorization",
		args: [from, to, value, validAfter, validBefore, nonce, Number(v ?? BigInt(yParity + 27)), r, s],
	});
}

// Arbitrum produces ~4 blocks per second; look back a little further than the check's age.
const BLOCKS_PER_SECOND = 5n;

// Finds the transaction that consumed an authorization someone else settled before us.
export async function findAuthorizationTx(
	client: PublicClient,
	authorization: Authorization,
	sinceSeconds: number,
): Promise<Hex | undefined> {
	const latest = await client.getBlockNumber();
	const ageSeconds = BigInt(Math.max(0, Math.floor(Date.now() / 1000) - sinceSeconds) + 600);
	const lookback = ageSeconds * BLOCKS_PER_SECOND;
	const logs = await client.getContractEvents({
		address: USDC_ADDRESS,
		abi: USDC_FUNCTIONS,
		eventName: "AuthorizationUsed",
		args: { authorizer: authorization.from, nonce: authorization.nonce },
		fromBlock: latest > lookback ? latest - lookback : 0n,
		toBlock: latest,
	});
	return logs[0]?.transactionHash ?? undefined;
}
