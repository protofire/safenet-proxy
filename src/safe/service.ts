import type { Hex } from "viem";
import { safeTransactionWithAccount } from "./schemas.js";
import type { SafeTransactionWithDomain } from "./types.js";

export const multisigTransactionUrl = (txServiceUrl: string, safeTxHash: Hex): string => {
	const baseUrl = txServiceUrl.replace(/\/+$/, "");
	return `${baseUrl}/api/v2/multisig-transactions/${safeTxHash}/`;
};

const authorizationHeaders = (apiKey: string | undefined): HeadersInit =>
	apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` };

export const transactionDetails = async (
	txServiceUrl: string,
	apiKey: string | undefined,
	chainId: bigint,
	safeTxHash: Hex,
): Promise<SafeTransactionWithDomain | null> => {
	const response = await fetch(multisigTransactionUrl(txServiceUrl, safeTxHash), {
		headers: authorizationHeaders(apiKey),
	});
	if (!response.ok) {
		console.error(
			`Could not fetch transaction details for eip155:${chainId}:${safeTxHash} (status ${response.status})`,
		);
		return null;
	}
	const parsed = safeTransactionWithAccount.safeParse(await response.json());
	if (!parsed.success) {
		console.error(`Could not parse transaction details for eip155:${chainId}:${safeTxHash} (${parsed.error.message})`);
		return null;
	}
	return {
		chainId,
		...parsed.data,
	};
};
