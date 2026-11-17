import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Hex } from "viem";
import type { Check, CheckStatus, CheckUpdate, NewCheck } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	safe TEXT NOT NULL,
	safe_tx_hash TEXT NOT NULL,
	payment_type TEXT NOT NULL,
	payer TEXT NOT NULL,
	amount TEXT NOT NULL,
	auth_json TEXT,
	signature TEXT,
	auth_nonce TEXT UNIQUE,
	payment_safe_tx_hash TEXT UNIQUE,
	payment_tx_hash TEXT,
	proposal_tx_hash TEXT,
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_by_tx ON checks (chain_id, safe_tx_hash);
CREATE INDEX IF NOT EXISTS checks_by_status ON checks (status);
`;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export class CheckStore {
	private readonly db: Database.Database;

	// Pass ":memory:" for an ephemeral store (tests).
	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(SCHEMA);
	}

	insertCheck(check: NewCheck): Check {
		const now = nowSeconds();
		const row: Check = {
			...check,
			id: randomUUID(),
			payment_tx_hash: null,
			proposal_tx_hash: null,
			status: "PENDING_PAYMENT",
			attempts: 0,
			last_error: null,
			created_at: now,
			updated_at: now,
		};
		const columns = Object.keys(row);
		this.db
			.prepare(`INSERT INTO checks (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`)
			.run(row);
		return row;
	}

	// Most recent check for a target transaction.
	getCheckByTx(chainId: number, safeTxHash: Hex): Check | undefined {
		return this.db
			.prepare("SELECT * FROM checks WHERE chain_id = ? AND lower(safe_tx_hash) = lower(?) ORDER BY created_at DESC")
			.get(chainId, safeTxHash) as Check | undefined;
	}

	getCheckByAuthNonce(nonce: Hex): Check | undefined {
		return this.db.prepare("SELECT * FROM checks WHERE lower(auth_nonce) = lower(?)").get(nonce) as Check | undefined;
	}

	getCheckByPaymentSafeTxHash(hash: Hex): Check | undefined {
		return this.db.prepare("SELECT * FROM checks WHERE lower(payment_safe_tx_hash) = lower(?)").get(hash) as
			| Check
			| undefined;
	}

	getDueChecks(status: CheckStatus): Check[] {
		return this.db.prepare("SELECT * FROM checks WHERE status = ? ORDER BY created_at").all(status) as Check[];
	}

	updateCheck(id: string, update: CheckUpdate): Check {
		const fields = { ...update, updated_at: nowSeconds() };
		const assignments = Object.keys(fields).map((key) => `${key} = @${key}`);
		this.db.prepare(`UPDATE checks SET ${assignments.join(", ")} WHERE id = @id`).run({ ...fields, id });
		return this.db.prepare("SELECT * FROM checks WHERE id = ?").get(id) as Check;
	}

	deleteCheck(id: string): void {
		this.db.prepare("DELETE FROM checks WHERE id = ?").run(id);
	}

	close(): void {
		this.db.close();
	}
}
