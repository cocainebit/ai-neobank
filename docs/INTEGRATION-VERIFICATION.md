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
| Squads Protocol v4 | researched | Create multisig; deposit; create transaction and proposal; approve; execute; reject; expire; spending-limit transfer; timelock; reconcile chain events |
| Solana RPC | e2e-local | Local validator health, balance, fee simulation, signed transfer, confirmation, fee capture, and destination reconciliation passed. Still required: two-provider devnet, reorg/fork handling, rate-limit and timeout failover |
| Safe Protocol | e2e-local | Official Safe 1.4.1 singleton/factory/multisend/handler deployed on Anvil; 2-of-3 Safe predicted and deployed; owner/threshold/modules observed; funded; transaction hash built; one-signature execution rejected; two distinct owner signatures aggregated; transfer executed; receipt, destination balance, and nonce independently verified. Still required: Base Sepolia, rejection/replacement, reorg/provider outage, worker/ledger integration, hosted Transaction Service outage |
| EVM RPC | e2e-local | Anvil health/chain-ID check, balance, gas simulation, signed transfer, receipt, fee capture, and destination reconciliation passed. Still required: Base Sepolia, nonce conflicts, replacement, reorg handling, provider failover |
| x402 Solana | researched | Devnet 402 challenge; quote normalization; policy denial; exact payment; duplicate retry/idempotency; seller failure; external refund; reconciliation |
| x402 EVM | researched | Base Sepolia 402 challenge; EIP-712 authorization; Safe/smart-account signature verification; policy denial; exact payment; duplicate retry/idempotency; refund; reconciliation |
| Wallet connection | unselected | Connect, sign-in proof, network mismatch, transaction signing, rejection, disconnect, mobile path |
| Encrypted software signer | contract-tested | EVM/Solana address generation, AES-256-GCM round trip, encrypted persistence, secret-free list API, agent binding, and default-off API gate passed. Still required: rotation, HSM migration, execution-worker isolation, backup recovery |
| PostgreSQL | e2e-local | Initial migration, durable organization/agent persistence, transactional audit writes, intent idempotency, event/outbox creation, and real HTTP read-after-write passed. Still required: rollback, concurrency stress, backup and point-in-time restore exercise |
| Durable worker | e2e-local | API-created intent, transactional outbox, deduplicated job creation, SKIP LOCKED lease, optimistic transition, and durable approval request passed. Still required: crash injection, lease recovery, concurrency stress, dead-letter operator flow |
| Approval state machine | e2e-local | Human-role eligibility, quorum snapshot, intent-version binding, compiled/simulation hash binding, evidence mismatch denial, duplicate replay, durable audit/event records, scheduled expiry, rejection, and execution outbox gate implemented; PostgreSQL approve lifecycle passed. Wallet-authenticated approval proof remains gated on wallet authentication milestone |
| Direct execution pipeline | e2e-local | Approved intent -> encrypted signer isolation -> compilation hash check -> fee simulation -> EVM/Solana signature -> broadcast -> confirmation -> receipt persistence -> balanced ledger entries -> reconciled state passed on Anvil and local Solana validator. Production execution remains disabled pending Safe/Squads and HSM gates |
| Card issuing | disabled | Regulated program approval, KYC/KYB flow, sandbox authorization/decline/reversal/refund/dispute, signed production contract |
| Banking rails | disabled | Regulated partner approval, account ownership checks, sanctions controls, sandbox payment lifecycle, signed production contract |

## Automated verification rules

- Integration tests run against Solana local validator on every pull request.
- EVM integration tests run against Anvil on every pull request.
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
