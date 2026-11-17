import { type Address, encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from "viem";
import { CHECKS_CHAIN_ID, USDC_ADDRESS } from "./config.js";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

// Binds an authorization to one Safe transaction, so a signature can't be reused for another check.
export function checkNonce(chainId: number, safe: Address, safeTxHash: Hex): Hex {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("uint256, address, bytes32"), [BigInt(chainId), safe, safeTxHash]),
	);
}

// name and version come from the token contract (see readUsdcDomain) rather than being hardcoded.
export function usdcDomain(name: string, version: string) {
	return { name, version, chainId: CHECKS_CHAIN_ID, verifyingContract: USDC_ADDRESS } as const;
}
