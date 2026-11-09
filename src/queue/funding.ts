import type { Address, Chain, PublicClient } from "viem";
import { ERC20_FUNCTIONS, ORACLE_FUNCTIONS } from "../utils/abis.js";
import { InsufficientBalanceError } from "../utils/errors.js";

export async function assertCanPayGas(
	client: PublicClient,
	chain: Chain,
	sponsor: Address,
	submissions: { gas: bigint }[],
	maxFeePerGas: bigint,
): Promise<void> {
	const required = submissions.reduce((sum, submission) => sum + submission.gas, 0n) * maxFeePerGas;
	if (required === 0n) {
		return;
	}
	const balance = await client.getBalance({ address: sponsor });
	if (balance < required) {
		throw new InsufficientBalanceError(
			`${sponsor} on chain ${chain.id} holds ${balance} ${chain.nativeCurrency.symbol} but needs at least ${required} ${chain.nativeCurrency.symbol} to pay for the batch`,
		);
	}
}

// Each oracle pulls its fee from the proposer via transferFrom once per proposal, so the
// proposer needs both the balance and an allowance to each oracle.
export async function assertCanPayOracleFees(
	client: PublicClient,
	chain: Chain,
	proposer: Address,
	oracles: Address[],
): Promise<void> {
	const proposalsByOracle = countOccurrences(oracles);
	const requiredByToken = new Map<Address, bigint>();
	await Promise.all(
		[...proposalsByOracle].map(async ([oracle, proposals]) => {
			const { token, fee } = await readOracleFee(client, oracle);
			const required = fee * proposals;
			const allowance = await client.readContract({
				address: token,
				abi: ERC20_FUNCTIONS,
				functionName: "allowance",
				args: [proposer, oracle],
			});
			if (allowance < required) {
				throw new InsufficientBalanceError(
					`${proposer} on chain ${chain.id} has approved ${allowance} of token ${token} to oracle ${oracle} but needs at least ${required} to pay for the batch`,
				);
			}
			requiredByToken.set(token, (requiredByToken.get(token) ?? 0n) + required);
		}),
	);
	await Promise.all(
		[...requiredByToken].map(async ([token, required]) => {
			const balance = await client.readContract({
				address: token,
				abi: ERC20_FUNCTIONS,
				functionName: "balanceOf",
				args: [proposer],
			});
			if (balance < required) {
				throw new InsufficientBalanceError(
					`${proposer} on chain ${chain.id} holds ${balance} of token ${token} but needs at least ${required} of token ${token} to pay for the batch`,
				);
			}
		}),
	);
}

async function readOracleFee(client: PublicClient, oracle: Address): Promise<{ token: Address; fee: bigint }> {
	const [token, fee] = await Promise.all([
		client.readContract({ address: oracle, abi: ORACLE_FUNCTIONS, functionName: "FEE_TOKEN" }),
		client.readContract({ address: oracle, abi: ORACLE_FUNCTIONS, functionName: "fee" }),
	]);
	return { token, fee };
}

function countOccurrences<T>(items: T[]): Map<T, bigint> {
	const counts = new Map<T, bigint>();
	for (const item of items) {
		counts.set(item, (counts.get(item) ?? 0n) + 1n);
	}
	return counts;
}
