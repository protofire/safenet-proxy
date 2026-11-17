// Signs an EIP-3009 fee authorization as a Safe owner and builds the POST /v1/checks body,
// so the wallet payment path can be demoed without the web app.
//
// Usage: OWNER_PRIVATE_KEY=0x... npm run sign-3009 -- <safe> <safeTxHash> [--send]
import { type Address, getAddress, type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "../src/checks/authorization.js";
import { CHECKS_CHAIN_ID } from "../src/checks/config.js";
import { originClient, readUsdcDomain } from "../src/checks/usdc.js";

const VALIDITY_SECONDS = 60 * 60;

type Quote = { token: Address; fee: string; feeCollector: Address; chainId: number };

async function main(): Promise<void> {
	const [safeArg, safeTxHash, flag] = process.argv.slice(2);
	const ownerKey = process.env.OWNER_PRIVATE_KEY;
	if (safeArg === undefined || safeTxHash === undefined || !isHex(safeTxHash) || !isHex(ownerKey)) {
		throw new Error("Usage: OWNER_PRIVATE_KEY=0x... npm run sign-3009 -- <safe> <safeTxHash> [--send]");
	}
	const proxyUrl = (process.env.PROXY_URL ?? "http://localhost:8787").replace(/\/+$/, "");
	const rpcUrl = JSON.parse(process.env.RPC_URLS ?? "{}")[CHECKS_CHAIN_ID];
	if (typeof rpcUrl !== "string") {
		throw new Error(`RPC_URLS must contain an entry for ${CHECKS_CHAIN_ID}`);
	}

	const safe = getAddress(safeArg);
	const owner = privateKeyToAccount(ownerKey);
	const quote = (await (await fetch(`${proxyUrl}/v1/quote/${CHECKS_CHAIN_ID}`)).json()) as Quote;
	const { name, version } = await readUsdcDomain(originClient(rpcUrl));

	const authorization = {
		from: owner.address,
		to: quote.feeCollector,
		value: BigInt(quote.fee),
		validAfter: 0n,
		validBefore: BigInt(Math.floor(Date.now() / 1000) + VALIDITY_SECONDS),
		nonce: checkNonce(CHECKS_CHAIN_ID, safe, safeTxHash as Hex),
	};
	const signature = await owner.signTypedData({
		domain: usdcDomain(name, version),
		types: TRANSFER_WITH_AUTHORIZATION_TYPES,
		primaryType: "TransferWithAuthorization",
		message: authorization,
	});

	const body = {
		chainId: CHECKS_CHAIN_ID,
		safe,
		safeTxHash,
		payment: {
			type: "eip3009",
			authorization: Object.fromEntries(Object.entries(authorization).map(([key, value]) => [key, String(value)])),
			signature,
		},
	};
	console.log(JSON.stringify(body, null, 2));

	if (flag === "--send") {
		const response = await fetch(`${proxyUrl}/v1/checks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		console.log(`\nPOST /v1/checks → ${response.status}`);
		console.log(await response.text());
	}
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
