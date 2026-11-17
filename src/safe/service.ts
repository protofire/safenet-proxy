import type { Hex } from "viem";
import { multisigTransactionSchema, safeTransactionWithAccount } from "./schemas.js";
import type { MultisigTransaction, SafeTransactionWithDomain } from "./types.js";

export const multisigTransactionUrl = (txServiceUrl: string, safeTxHash: Hex): string => {
	const baseUrl = txServiceUrl.replace(/\/+$/, "");
	return `${baseUrl}/api/v2/multisig-transactions/${safeTxHash}/`;
};

const authorizationHeaders = (apiKey: string | undefined): Record<string, string> =>
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

// Unlike transactionDetails, also returns the execution status. Returns null when the
// transaction does not exist and throws on any other failure so callers can retry.
export const multisigTransaction = async (
	txServiceUrl: string,
	apiKey: string | undefined,
	safeTxHash: Hex,
): Promise<MultisigTransaction | null> => {
	const response = await fetch(multisigTransactionUrl(txServiceUrl, safeTxHash), {
		headers: authorizationHeaders(apiKey),
	});
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`Transaction Service returned ${response.status} for ${safeTxHash}`);
	}
	return multisigTransactionSchema.parse(await response.json());
};
