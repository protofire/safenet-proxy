import {
	type Address,
	BaseError,
	createPublicClient,
	extractChain,
	type Hex,
	http,
	maxUint256,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { supportedChains } from "../config/chains.js";
import type { Config } from "../config/types.js";
import { proposeNow } from "../queue/consumer.js";
import { findOracleAllowanceShortfalls } from "../queue/funding.js";
import { multisigTransaction, transactionDetails } from "../safe/service.js";
import { type ChecksConfig, CONFIRMATIONS, MAX_PROPOSAL_ATTEMPTS } from "./config.js";
import { hasExecutionSuccess, hasUsdcTransfer } from "./payments.js";
import { authorizationSchema } from "./schemas.js";
import { type CheckStore, nowSeconds } from "./store.js";
import type { Check, CheckStatus, CheckUpdate } from "./types.js";
import { findAuthorizationTx, isAuthorizationUsed, originClient, settleAuthorization } from "./usdc.js";

export const WORKER_INTERVAL_MS = 5_000;

// Moves paid checks forward: settles/confirms payments on Arbitrum, then proposes on Gnosis.
// Jobs are processed one at a time; a tick is skipped while the previous one still runs.
export class CheckWorker {
	private timer: NodeJS.Timeout | undefined;
	private running: Promise<void> | undefined;
	private readonly client: PublicClient;

	constructor(
		private readonly store: CheckStore,
		private readonly checksConfig: ChecksConfig,
		private readonly proxyConfig: Config,
	) {
		this.client = originClient(checksConfig.rpcUrl);
	}

	start(): void {
		this.timer = setInterval(() => this.tick(), WORKER_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		clearInterval(this.timer);
		await this.running;
	}

	tick(): Promise<void> {
		this.running ??= this.processDueChecks().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	private async processDueChecks(): Promise<void> {
		for (const status of ["PENDING_PAYMENT", "PAID"] as const) {
			for (const check of this.store.getDueChecks(status)) {
				try {
					await this.process(check);
				} catch (e: unknown) {
					console.error(`Check ${check.id} (${check.status}) failed this round: ${errorMessage(e)}`);
				}
			}
		}
	}

	private process(check: Check): Promise<void> {
		if (check.status === "PAID") {
			return this.propose(check);
		}
		return check.payment_type === "eip3009" ? this.settleAuthorization(check) : this.confirmSafePayment(check);
	}

	private async settleAuthorization(check: Check): Promise<void> {
		const authorization = authorizationSchema.parse(JSON.parse(check.auth_json ?? "null"));
		let hash = check.payment_tx_hash ?? undefined;
		if (hash === undefined) {
			if (await isAuthorizationUsed(this.client, authorization.from, authorization.nonce)) {
				// Someone settled the authorization before us; find their transaction instead of sending.
				hash = await findAuthorizationTx(this.client, authorization, check.created_at);
				if (hash === undefined) {
					throw new Error("Authorization is used but its transaction was not found yet");
				}
			} else if (BigInt(nowSeconds()) >= authorization.validBefore) {
				this.transition(check, "EXPIRED", { last_error: "Authorization expired before it was settled" });
				return;
			} else {
				const account = privateKeyToAccount(this.proxyConfig.PRIVATE_KEY);
				hash = await settleAuthorization(this.checksConfig.rpcUrl, account, authorization, check.signature as Hex);
				// Saved before waiting, so a restart checks this transaction instead of settling twice.
				this.store.updateCheck(check.id, { payment_tx_hash: hash });
				console.info(JSON.stringify({ event: "check_settlement_sent", id: check.id, txHash: hash }));
			}
		}

		const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: CONFIRMATIONS });
		if (receipt.status !== "success") {
			// Retry next round: either we settle again or we find whoever consumed the authorization.
			this.store.updateCheck(check.id, { payment_tx_hash: null, last_error: `Settlement ${hash} reverted` });
			return;
		}
		const paid = hasUsdcTransfer(receipt.logs, {
			from: authorization.from,
			to: this.checksConfig.feeCollector,
			minValue: authorization.value,
		});
		if (!paid) {
			this.transition(check, "FAILED", { payment_tx_hash: hash, last_error: `No fee transfer found in ${hash}` });
			return;
		}
		this.transition(check, "PAID", { payment_tx_hash: hash });
	}

	private async confirmSafePayment(check: Check): Promise<void> {
		const paymentSafeTxHash = check.payment_safe_tx_hash as Hex;
		const { txServiceUrl, safeApiKey, feeCollector } = this.checksConfig;
		const payment = await multisigTransaction(txServiceUrl, safeApiKey, paymentSafeTxHash);

		if (payment?.isExecuted !== true || payment.transactionHash === null) {
			if (nowSeconds() >= check.expires_at) {
				this.transition(check, "EXPIRED", { last_error: "Payment transaction was not executed in time" });
			}
			return;
		}
		if (payment.isSuccessful === false) {
			this.transition(check, "FAILED", {
				payment_tx_hash: payment.transactionHash,
				last_error: "Payment transaction failed",
			});
			return;
		}

		const hash = payment.transactionHash;
		const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: CONFIRMATIONS });
		const paid =
			hasExecutionSuccess(receipt.logs, check.safe, paymentSafeTxHash) &&
			hasUsdcTransfer(receipt.logs, { from: check.safe, to: feeCollector, minValue: BigInt(check.amount) });
		if (!paid) {
			this.transition(check, "FAILED", { payment_tx_hash: hash, last_error: `No fee payment found in ${hash}` });
			return;
		}
		this.transition(check, "PAID", { payment_tx_hash: hash });
	}

	private async propose(check: Check): Promise<void> {
		try {
			const { txServiceUrl, safeApiKey } = this.checksConfig;
			const details = await transactionDetails(txServiceUrl, safeApiKey, BigInt(check.chain_id), check.safe_tx_hash);
			if (details === null) {
				throw new Error("Target transaction could not be loaded from the Transaction Service");
			}
			const hashes = await proposeNow(this.proxyConfig, details);
			this.transition(check, "PROPOSED", { proposal_tx_hash: hashes.join(","), last_error: null });
		} catch (e: unknown) {
			const attempts = check.attempts + 1;
			const update: CheckUpdate = { attempts, last_error: errorMessage(e) };
			if (attempts >= MAX_PROPOSAL_ATTEMPTS) {
				this.transition(check, "FAILED", update);
			} else {
				this.store.updateCheck(check.id, update);
				console.error(`Check ${check.id} proposal attempt ${attempts} failed: ${update.last_error}`);
			}
		}
	}

	private transition(check: Check, status: CheckStatus, update: CheckUpdate = {}): void {
		this.store.updateCheck(check.id, { ...update, status });
		console.info(
			JSON.stringify({
				event: "check_status",
				id: check.id,
				from: check.status,
				to: status,
				txHash: update.proposal_tx_hash ?? update.payment_tx_hash ?? null,
				error: update.last_error ?? null,
			}),
		);
	}
}

// The oracle pulls its fee from the proposer, which needs a standing approval. We only warn:
// approving is a deliberate, one-off operator action.
export async function warnIfOracleAllowanceLow(config: Config): Promise<void> {
	const proposer = privateKeyToAccount(config.PRIVATE_KEY).address;
	for (const chainId of config.CHAIN_IDS) {
		const rpcUrl = config.RPC_URLS[String(chainId)];
		const client = createPublicClient({
			chain: extractChain({ chains: supportedChains, id: chainId }),
			transport: http(rpcUrl),
		});
		const oracles = config.CONSENSUS_CONFIGS[String(chainId)].flatMap((c) => (c.oracle ? [c.oracle] : []));
		for (const shortfall of await findOracleAllowanceShortfalls(client, proposer, oracles)) {
			console.warn(
				`WARNING: proposer ${proposer} has approved ${shortfall.allowance} of fee token ${shortfall.token} to oracle ${shortfall.oracle} on chain ${chainId}, below the fee of ${shortfall.fee}. Proposals will fail until you run:\n` +
					approveCommand(shortfall.token, shortfall.oracle, rpcUrl),
			);
		}
	}
}

function approveCommand(token: Address, spender: Address, rpcUrl: string): string {
	return `  cast send ${token} "approve(address,uint256)" ${spender} ${maxUint256} --rpc-url ${rpcUrl} --private-key $PRIVATE_KEY`;
}

function errorMessage(e: unknown): string {
	return e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
}
