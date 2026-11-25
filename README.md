## Safenet Proxy

A Node.js service that receives Safe Transaction Service webhooks and proposes the
corresponding Safe transactions to Safenet consensus contracts. It is built with Hono and
viem and ships as a container image.

### Development setup

- Install dependencies
```sh
npm install
```

- Create a local environment file and fill in the values (see [Configuration](#configuration))
```sh
cp .env.example .env
```

- Start the server with live reload on `http://localhost:8787`
```sh
npm run dev
```

- Run tests, linting and type checks
```sh
npm test
npm run check
```

### Configuration

All configuration is read from environment variables. They are validated on startup; the
process exits immediately with the validation error if anything is missing or malformed.

Secrets:

```sh
# Hex-encoded private key used to sign transactions on all chains
PRIVATE_KEY=0xabc...

# JSON object mapping chain ID → RPC URL
RPC_URLS={"100":"https://rpc.gnosischain.com"}

# Optional API key for the Safe Transaction Services
SAFE_API_KEY=

# Optional bearer token for /tx, /propose, /sampled. Without it, they close when FEE_COLLECTOR is set.
PROPOSAL_AUTH_TOKEN=
```

Non-secret settings:

```sh
# JSON object mapping chain ID → base URL of the Safe Transaction Service
TX_SERVICE_URLS={"1":"https://transaction-ethereum.safe.protofire.io","42161":"https://transaction-arbitrum.safe.protofire.io"}

# JSON object mapping chain ID → list of consensus configs (address + optional oracle +
# optional disableSampled). Each safe transaction is proposed individually to every address
# in the list, unless a config entry sets an oracle, in which case it is submitted via the
# oracle instead. Entries with disableSampled skip transactions received via /sampled.
CONSENSUS_CONFIGS={"11155111":[{"address":"0xAbc..."}],"100":[{"address":"0xDef..."},{"address":"0x123...","oracle":"0x456...","disableSampled":true}]}

# JSON object mapping chain ID → relaying Safe config (Safe address + its MultiSend
# contract address on that chain). When set for a chain, every proposal on that chain is
# routed through the Safe's execTransaction instead of calling the consensus contract
# directly, so the Safe (not PRIVATE_KEY's account) is the onchain proposer and fee payer.
# Each relaying Safe must have PRIVATE_KEY's account as an owner with threshold 1, and must
# be funded on its chain to cover oracle fees. A chain with no entry here falls back to
# calling the consensus contract directly. Proposals routed through a relaying Safe are
# batched into as few execTransaction calls as possible via the Safe's MultiSend contract,
# capped by MAX_BATCH_GAS.
RELAYING_SAFES={"11155111":{"safe":"0xAbc...","multiSend":"0x123..."}}

# Comma-separated list of chain IDs to submit attestations to
CHAIN_IDS=100

# Percentage of /sampled requests to process (defaults to 10)
SAMPLE_RATE=100

# Safe webhook type to react to: EXECUTED_MULTISIG_TRANSACTION (default) or PENDING_MULTISIG_TRANSACTION
WEBHOOK_TYPE=PENDING_MULTISIG_TRANSACTION

# Maximum gas for a single batched execTransaction submitted through a relaying Safe
# (defaults to 5000000), to stay clear of the chain's block gas limit
MAX_BATCH_GAS=5000000

# HTTP port (defaults to 8787)
PORT=8787
```

### Endpoints

- `POST /propose` — Safe Transaction Service webhook; looks up the transaction and queues it.
- `POST /sampled` — same as `/propose`, but only for enabled Safes and subject to `SAMPLE_RATE`.
- `POST /tx` — queues a fully specified Safe transaction directly.
- `GET /health` — liveness/readiness probe, returns `{"status":"ok"}`.

`/tx`, `/propose`, `/sampled` need `Authorization: Bearer $PROPOSAL_AUTH_TOKEN` when a token is set
or paid checks are on (else `401`). Webhooks must send the token.

Accepted proposals are collected in an in-process queue and submitted in batches (up to 10
proposals or 5 seconds, whichever comes first). Batches are processed one at a time.

### Container image

```sh
docker build -t safenet-proxy .
docker run --rm -p 8787:8787 --env-file .env safenet-proxy
```

The image runs `node dist/index.js` as the unprivileged `node` user and listens on `PORT`
(default `8787`).

### Deployment notes

- Run a **single replica**: proposals are signed by one account and nonces are assigned
  in-process, so concurrent instances would collide on nonces.
- Point liveness and readiness probes at `GET /health`.
- On `SIGTERM` the server stops accepting connections and drains the queue for up to 30
  seconds before exiting, so the termination grace period should be at least 40 seconds.
- Queued proposals live in memory only. Whatever has not been submitted when the process
  is killed hard is lost. This matches the previous behaviour, where failed submissions
  were never retried either.

You can test the service by triggering a request against it:

```sh
curl http://localhost:8787/propose \
    -H "Accept: application/json" \
    -H "content-type: application/json" \
    -d '{"type":"EXECUTED_MULTISIG_TRANSACTION","chainId":"1","address":"0x1280C3d641ad0517918e0E4C41F4AD25f6b39144","safeTxHash":"0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c"}'
```

## Phase 2 POC: user-paid checks

Owners pay 0.5 USDC on the Safe's chain; only after that payment is confirmed does the proxy
propose the transaction on Gnosis (paying the Safenet fee itself). POC scope: **Arbitrum One
(42161) only**, fee hardcoded in `src/checks/config.ts`. Code lives in `src/checks/`.

### Configuration

Enabled only when `FEE_COLLECTOR` is set (otherwise `/v1/*` returns 500 and no worker runs).

```sh
FEE_COLLECTOR=0x...                     # Arbitrum address receiving the fee (EOA or Safe)
CHECKS_DB_PATH=data/checks.sqlite       # SQLite job store (default shown; data/ is gitignored)
RPC_URLS={"100":"https://rpc.gnosischain.com","42161":"https://arb1.arbitrum.io/rpc"}
TX_SERVICE_URLS={"42161":"https://transaction-arbitrum.safe.protofire.io"}
CONSENSUS_CONFIGS={"100":[{"address":"0xc855761D619f6002923507cE68B84d7689C2aa96","oracle":"0x4F61B8832978e83b80D69551AEf07557DBE41d03"}]}
CHAIN_IDS=100
RELAYING_SAFES={}                       # the POC expects PRIVATE_KEY's account to propose directly
# scripts only
OWNER_PRIVATE_KEY=0x...                 # Safe owner signing the USDC authorization
PROXY_URL=http://localhost:8787
```

### Funding

| Account | Chain | Needs |
| --- | --- | --- |
| `PRIVATE_KEY` (settler + proposer) | Arbitrum | ETH for `transferWithAuthorization` gas |
| `PRIVATE_KEY` | Gnosis | xDAI for gas, the oracle fee token (USDC.e, `oracle.FEE_TOKEN()`) ≥ `oracle.fee()` per check |
| `PRIVATE_KEY` | Gnosis | one-off `approve(oracle, max)` on the fee token. On startup the proxy logs the exact `cast send` command if the allowance is too low; it never approves by itself |
| Owner wallet (wallet path) | Arbitrum | ≥ 0.5 USDC |
| Safe (Safe path) | Arbitrum | ≥ 0.5 USDC, plus a pending tx to check |

### Endpoints

- `GET /v1/quote/42161` → `{ token, fee, feeCollector, chainId }`
- `POST /v1/checks` `{ chainId, safe, safeTxHash, payment }` → `202 { id, status }`
  - `400` invalid, `402` payer lacks USDC, `409` a check exists (body is that check), `422` target tx missing/executed
- `GET /v1/checks/42161/:safeTxHash` → `{ id, status, paymentType, paymentTxHash, proposalTxHash, error }`

Statuses: `PENDING_PAYMENT → PAID → PROPOSED`, or `EXPIRED` / `FAILED` (with `error`). An
`EXPIRED` check, or a `FAILED` one that never took payment, can be requested again.

A worker runs every 5s, one job at a time, and logs each transition as JSON
(`{"event":"check_status","id":...,"from":...,"to":...,"txHash":...}`).

### Wallet path (EIP-3009)

1. The owner signs USDC `TransferWithAuthorization` to `FEE_COLLECTOR` with
   `nonce = keccak256(abi.encode(chainId, safe, safeTxHash))`, valid for ≥ 10 minutes.
2. `POST /v1/checks` with `payment = { type: "eip3009", authorization, signature }`.
3. The worker calls `transferWithAuthorization` on Arbitrum (or picks up the tx of whoever settled
   it first), checks the `Transfer` log → `PAID`, then proposes on Gnosis → `PROPOSED`. Unsettled
   past `validBefore` → `EXPIRED`.

Backend-only demo with the signing script (proxy must be running):

```sh
npm run dev
# in another shell; prints the request body, --send also posts it
OWNER_PRIVATE_KEY=0x... npm run sign-3009 -- <safe> <safeTxHash> --send
curl http://localhost:8787/v1/checks/42161/<safeTxHash>
```

### Safe path

1. The Safe proposes (and later executes) a separate tx `USDC.transfer(FEE_COLLECTOR, 0.5 USDC)`.
   Without UI support, build it with:
   ```sh
   npm run build-safe-payment            # or: npm run build-safe-payment -- <feeCollector>
   ```
   and enter it in the Safe app's Transaction Builder (contract = USDC, method `transfer`).
2. Register it once it has a `safeTxHash` (it does not need to be executed yet):
   ```sh
   curl http://localhost:8787/v1/checks -H 'content-type: application/json' \
     -d '{"chainId":42161,"safe":"<safe>","safeTxHash":"<target safeTxHash>","payment":{"type":"safeTx","paymentSafeTxHash":"<payment safeTxHash>"}}'
   ```
3. The worker polls the Transaction Service. Once the payment is executed it requires, in the
   Arbitrum receipt, the Safe's `ExecutionSuccess(paymentSafeTxHash)` and a USDC
   `Transfer(safe → FEE_COLLECTOR, ≥ fee)` → `PAID` → `PROPOSED`. Not executed within 24h → `EXPIRED`.

### POC limitations

- One chain, hardcoded fee, no refunds (`FAILED` just records the error).
- Gnosis proposals for checks are sent outside the batching queue from the same key; nonces come
  from the pending block, but a queue batch sent at the very same moment could still collide.
- If the proxy restarts while waiting for a Gnosis proposal receipt, that check may be proposed twice.
- The SQLite file is local; in the container it needs a writable volume.

## Planning Epics

When developing larger epics spanning over multiple PRs with an agent (for example a complex feature or big refactor), generate a plan to help guide the agent by outlining the separate phases in the development. It is recommended to use the `/plan-epic` feature from <https://github.com/safe-research/agents> for this.
