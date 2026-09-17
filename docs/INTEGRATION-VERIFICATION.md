# Integration verification gates

No external service is labelled supported merely because an SDK installs or an
API returns `200`. Each integration must pass its complete money-flow lifecycle.

## Status vocabulary

- `researched`: authoritative current documentation located
- `contract-tested`: SDK/API behavior tested against local or hosted sandbox
- `e2e-local`: complete lifecycle confirmed against a disposable local network
- `e2e-devnet`: complete user-visible lifecycle confirmed on devnet
- `production-candidate`: security, legal, operational, and failure review passed
- `production`: deliberately enabled with monitoring and rollback procedures

## Matrix

| Integration | Current status | Required proof |
| --- | --- | --- |
| Wallet sign-in (EVM, Solana) | e2e-local | EIP-4361 and Sign-In With Solana challenge, signature verification, single-use nonce, session issue/revoke, cookie origin check passed in `apps/api/src/app.test.ts` and `packages/auth`. Still required: ERC-1271 smart-account owners, passkey step-up, browser wallet path |
| Agent credentials | e2e-local | Hashed key issue, use, revoke, lock-out on organisation freeze and agent freeze passed. Still required: DPoP-style proof, rotation reminders |
| Policy engine on the durable path | e2e-local | Bound policy evaluated at intake and again before signing; per-transaction, daily, asset, network, destination, kind; quorum from policy; freezes at intake, approval, and execution; unknown asset rejected (`packages/database/src/integration.test.ts`) |
| Simulation evidence | e2e-local | Real chain simulation and source balance snapshot hashed into the approval request; insufficient balance rejected before any approval exists (`apps/worker/src/integration.test.ts`) |
| Direct execution pipeline | e2e-local | Sign -> persist signed bytes and hash -> broadcast -> confirm at finality -> ledger (pending, settlement, fee) -> reconcile against observed destination delta, for native, ERC-20, SOL, and SPL. Crash injection between signing and broadcast: unsent transaction resent, already-sent transaction not sent twice, nonce reuse detected as dead |
| EVM RPC | e2e-local | Anvil health, balances, gas and fee estimate, sign-before-broadcast, receipt with confirmation depth, destination delta from value or Transfer log. Still required: Base Sepolia, provider failover, reorg handling |
| Solana RPC | e2e-local | Local validator health, balances, fee and simulation, sign-before-broadcast, `finalized` commitment, pre/post balance deltas for SOL and SPL, blockhash expiry detection. Still required: devnet, provider failover |
| Safe Protocol | e2e-local (standalone) | 2-of-3 deploy, observe, hash, signature aggregation, execute on Anvil. Not wired into intents, approvals, or the ledger |
| Squads Protocol v4 | researched | Program cloned into the local validator at genesis; no adapter yet |
| x402 | researched | No implementation |
| Encrypted software signer | contract-tested | Development custody only; refused in production and secret export refused outside development. Still required: KMS/HSM backend, key rotation |
| PostgreSQL | e2e-local | Migrations 001-004, organisation-scoped composite foreign keys, transactional outbox, lease recovery for jobs left running by a crashed worker |
| Card issuing, banking rails | disabled | Out of scope for the non-custodial launch |

## Automated verification rules

- `pnpm test:integration` runs every suite against `scripts/localnet.sh` services. There is no CI workflow yet; that is part of the devnet certification milestone.
- A shared adapter conformance suite must pass unchanged for Squads/Solana and
  Safe/EVM wherever their capabilities overlap.
- Hosted devnet tests run on a schedule and before release, never from forks with
  secrets.
- Tests use dedicated low-value wallets and must never reference a founder or
  production treasury.
- Every mutating request has an idempotency key and duplicate-delivery test.
- Every adapter has recorded fixtures for success, rejection, timeout, malformed
  payload, stale quote, insufficient balance, and provider outage.
- Health checks test capability, not just connectivity.

## Evidence record

For each promotion, store:

- dependency and API versions
- network and program addresses
- test command and immutable CI run
- transaction signatures or sandbox event IDs
- expected and actual ledger entries
- failure/recovery observations
- reviewer and date

## Verified local execution — 2026-09-16

### EVM

- Runtime: Anvil, chain ID `31337`, CAIP-2 `eip155:31337`
- Command: `pnpm test:integration:evm`
- Result: one integration test passed
- Lifecycle: RPC health -> source/destination balance -> gas estimate -> signed
  native transfer -> receipt -> fee calculation -> destination balance assertion

### Solana

- Runtime: `solana-test-validator`/Agave `3.1.12`, CAIP-2 development ID
  `solana:localnet`
- Command: `pnpm test:integration:solana`
- Result: one integration test passed
- Lifecycle: RPC health -> faucet funding -> fee calculation -> signed System
  Program transfer -> confirmed transaction -> fee capture -> destination balance
  assertion

These results verify the chain adapters, not Safe or Squads governance. Those
remain disabled until their proposal/approval/execution suites pass.

### PostgreSQL control plane

- Runtime: PostgreSQL 16 in Docker on isolated local port `54339`
- Commands: `pnpm --filter @ai-neobank/database migrate` and
  `pnpm test:integration:database`
- Result: migration and persistence/idempotency integration test passed
- HTTP lifecycle: production-built API health -> create organization -> create
  agent/principal/audit event transaction -> list agent from PostgreSQL
- Safety boundary: Safe, Squads, and x402 execution remains explicitly disabled
  by the API health contract until their full lifecycle gates pass

### Durable intent worker — 2026-09-17

- Runtime: separately built Node worker with PostgreSQL-backed queue
- Lifecycle: API accepted intent -> outbox event -> deduplicated job -> leased
  handler -> optimistic `received` to `approval_required` transition -> persisted
  approval request -> API read-back
- Evidence intent: `f012bf32-c33f-4a82-bc50-0d34b4015020`, version advanced
  from `1` to `2`
- Failure controls: exponential retry, lease expiry, maximum attempts, dead-letter
  state, unknown-handler failure, and idempotent state handling

### Sign, broadcast, confirmation, and reconciliation — 2026-09-17

- EVM: a generated encrypted signer was funded on Anvil, approved through the
  state machine, simulated, signed only inside the worker, broadcast, confirmed,
  projected into balanced ledger entries, and independently balance-checked at
  the destination.
- Solana: the equivalent lifecycle passed against `solana-test-validator`,
  including faucet funding, fee calculation, signature, confirmation, ledger
  projection, reconciliation, and independent destination balance verification.
- Commands: `pnpm test:integration:worker` with the relevant local RPC variable.
- Boundary: these tests prove direct development accounts. They do not prove
  Safe or Squads governance, which remain separately gated.

### Safe 2-of-3 governance — 2026-09-17

- SDK: official `@safe-global/protocol-kit` `6.1.2`
- Contracts: official Safe smart-account `1.4.1` artifacts, deployed into a
  disposable Anvil network through Protocol Kit custom-network configuration
- Lifecycle: deploy singleton dependencies -> predict Safe -> deploy 2-of-3
  proxy -> fund -> observe owners/threshold/modules -> build transfer -> compute
  Safe transaction hash -> collect owner 1 signature -> verify execution denial
  -> collect owner 2 signature -> execute -> receipt -> destination balance and
  Safe nonce verification
- Command: `EVM_RPC_URL=http://127.0.0.1:<port> pnpm test:integration:safe`
- No Transaction Service was used, proving direct signature collection works
  during a hosted-service outage.

## Sources verified during architecture

- Squads quickstart: https://docs.squads.so/main/development/introduction/quickstart
- Squads v4 repository: https://github.com/squads-protocol/v4
- Safe Protocol Kit: https://docs.safe.global/sdk/protocol-kit
- Safe transaction signatures: https://docs.safe.global/sdk/protocol-kit/guides/signatures/transactions
- x402 seller quickstart: https://github.com/coinbase/x402/blob/main/docs/getting-started/quickstart-for-sellers.mdx
- CDP x402 facilitator: https://docs.cdp.coinbase.com/x402/seller/facilitator
- Solana TypeScript SDK guidance: https://solana.com/docs/clients/official/javascript

## Verified local execution after the takeover: 2026-09-17

- Runtime: Homebrew PostgreSQL 16 on :8723, Anvil 1.7.1 on :8722, Agave
  `solana-test-validator` 3.1.12 on :8724 with the Squads v4 program cloned from
  devnet.
- Command: `pnpm test:integration`.
- Suites: `packages/auth` (5 unit), `packages/database` (identity, policy,
  quorum, freezes, execution gating, autonomous gate), `packages/evm-adapter`
  (native + ERC-20, nonce-dead detection), `packages/solana-adapter` (SOL +
  SPL at finalized commitment), `apps/worker` (EVM native + ERC-20 to
  reconciled; two crash-injection recoveries; Solana SOL + SPL to reconciled),
  `apps/api` (wallet sign-in through execution over HTTP), `packages/safe-adapter`
  (standalone 2-of-3).
- Boundary: direct treasuries with development software signers only. Safe and
  Squads governance are not yet on the intent path; nothing has run on a public
  test network.
