import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { multisigTransactionUrl, transactionDetails } from "./service.js";

const TX_SERVICE_URL = "https://tx-sepolia.example.com";
const SAFE_TX_HASH = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";
const CHAIN_ID = 11155111n;

const TX_RESPONSE = {
	safe: "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144",
	to: zeroAddress,
	value: "0",
	data: null,
	operation: 0,
	safeTxGas: "0",
	baseGas: "0",
	gasPrice: "0",
	gasToken: zeroAddress,
	refundReceiver: zeroAddress,
	nonce: "7",
};

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("multisigTransactionUrl", () => {
	it("builds the v2 multisig transaction URL from the service base URL", () => {
		expect(multisigTransactionUrl(TX_SERVICE_URL, SAFE_TX_HASH)).toBe(
			`${TX_SERVICE_URL}/api/v2/multisig-transactions/${SAFE_TX_HASH}/`,
		);
	});

	it("tolerates a trailing slash on the base URL", () => {
		expect(multisigTransactionUrl(`${TX_SERVICE_URL}/`, SAFE_TX_HASH)).toBe(
			`${TX_SERVICE_URL}/api/v2/multisig-transactions/${SAFE_TX_HASH}/`,
		);
	});
});

describe("transactionDetails", () => {
	it("fetches from the configured service and returns the parsed transaction with the chain ID", async () => {
		fetchMock.mockResolvedValue(jsonResponse(TX_RESPONSE));

		const result = await transactionDetails(TX_SERVICE_URL, undefined, CHAIN_ID, SAFE_TX_HASH);

		expect(fetchMock).toHaveBeenCalledWith(
			`${TX_SERVICE_URL}/api/v2/multisig-transactions/${SAFE_TX_HASH}/`,
			expect.anything(),
		);
		expect(result).toEqual({
			chainId: CHAIN_ID,
			safe: TX_RESPONSE.safe,
			to: zeroAddress,
			value: 0n,
			data: "0x",
			operation: 0,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: zeroAddress,
			refundReceiver: zeroAddress,
			nonce: 7n,
		});
	});

	it("sends no Authorization header when no API key is configured", async () => {
		fetchMock.mockResolvedValue(jsonResponse(TX_RESPONSE));

		await transactionDetails(TX_SERVICE_URL, undefined, CHAIN_ID, SAFE_TX_HASH);

		const headers = new Headers(fetchMock.mock.calls[0][1].headers);
		expect(headers.has("Authorization")).toBe(false);
	});

	it("sends a bearer Authorization header when an API key is configured", async () => {
		fetchMock.mockResolvedValue(jsonResponse(TX_RESPONSE));

		await transactionDetails(TX_SERVICE_URL, "secret", CHAIN_ID, SAFE_TX_HASH);

		const headers = new Headers(fetchMock.mock.calls[0][1].headers);
		expect(headers.get("Authorization")).toBe("Bearer secret");
	});

	it("returns null when the service responds with an error status", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ detail: "Not found." }, 404));

		const result = await transactionDetails(TX_SERVICE_URL, undefined, CHAIN_ID, SAFE_TX_HASH);

		expect(result).toBeNull();
	});

	it("returns null when the response does not match the transaction schema", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ safe: TX_RESPONSE.safe, nonce: "7" }));

		const result = await transactionDetails(TX_SERVICE_URL, undefined, CHAIN_ID, SAFE_TX_HASH);

		expect(result).toBeNull();
	});
});
