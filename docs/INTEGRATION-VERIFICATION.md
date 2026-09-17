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
| Safe Protocol | e2e-local | Deployment prepared for the owner's wallet; registration verifies owners/threshold on chain and refuses non-owner registrants and owner executors; intent compiled to a Safe transaction at intake; EIP-712 owner signatures verified against the session wallet and the owner set; non-owner executor executes; threshold and replay enforced by the Safe; moved nonce fails the intent; native and ERC-20 (`packages/safe-adapter`, `apps/worker/src/governance.test.ts`, `apps/api/src/governance.test.ts`). Still required: Base Sepolia with canonical deployments, rejection transactions, Transaction Service interop |
| Squads Protocol v4 | e2e-local | Real program bytes cloned from devnet; creation prepared for the member's wallet with a server-held create key; registration verifies vault, members, and that the executor has Initiate+Execute and no Vote; executor publishes vault transaction + proposal with the index recorded before broadcast; members vote with API-built transactions; on-chain votes mirrored to approvals; program-side threshold, executor vote refusal, premature execute refusal, and rejection proven; SOL and SPL (`packages/squads-adapter`, worker and API governance tests). Still required: devnet, time locks, spending limits, config changes |
| x402 EVM | e2e-local | x402 v2 `exact` with EIP-3009 against a local token that implements `transferWithAuthorization`; local facilitator verifies and settles; quote captured at intake and hashed as approval evidence; cap enforced; payload persisted before the paid request; crash injection between persistence and payment yields exactly one settlement; replay refused; ledger books the quoted price; reconciled from the token's Transfer log (`packages/x402-adapter`, `apps/worker/src/x402.test.ts`, `apps/api/src/x402.test.ts`). Still required: Base Sepolia with the hosted CDP facilitator and real USDC, Permit2 tokens, smart-account payers |
| x402 Solana | e2e-local | x402 v2 `exact` SPL transfer co-signed by a local facilitator fee payer; same intake, approval, persistence, and reconciliation path. The SDK accepts only the three public cluster ids, so the local validator is labelled as devnet on the wire while all RPC traffic stays local (`solanaWireNetwork` refuses to relabel a real public cluster). Still required: devnet with the hosted facilitator and real USDC |
| Web console on the real API | e2e-local | Signed in with a development EVM wallet, deployed a Safe from the console, funded it, requested a payment, approved it with an EIP-712 owner signature, and watched it finalize and reconcile; signed in with a Solana wallet, created a Squads vault, voted on chain from the browser, and the executor settled it; issued a 250 TUSD invoice, paid it from the public page with a browser wallet, and the indexer matched it; an agent key created in the console requested a payment over the agent API that policy authorized and the worker settled without a person. Playwright covers sign-in, treasury creation, funding, and settlement (`apps/web/e2e/console.spec.ts`, run with `RUN_WEB_E2E=1`). Still required: a browser extension wallet (only development wallets are exercised), devnet, and screen-reader passes |
| Envelope-encrypted software signer | e2e-local | Per-signer data key sealed by a versioned key-encryption key; local keyring and KMS providers; rotation re-wraps data keys without touching secret ciphertext and upgrades legacy envelopes; a worker holding only the new key executes transfers from both (`packages/signer/src/kms.test.ts`, `apps/worker/src/keys.test.ts`). Production refuses locally wrapped signers (`apps/api/src/keys.test.ts`) |
| KMS-held EVM signer | contract-tested | Address from SPKI public key; DER signatures with high-s normalisation and parity recovery; transactions, Safe typed data, and messages recover to the key; a KMS key executes a direct transfer and, after executor rotation, a Safe execution on Anvil. Driven through the AWS SDK's real command classes against an in-process KMS stand-in. Still required: a live AWS KMS key |
| Executor rotation | e2e-local | Safe: immediate swap, refused while payments are in flight. Squads: old executor publishes AddMember/RemoveMember config proposal, members approve on chain, executor executes it, Relay switches and the next vault payment is proposed and executed by the new executor (`apps/worker/src/keys.test.ts`) |
| PostgreSQL | e2e-local | Migrations 001-004, organisation-scoped composite foreign keys, transactional outbox, lease recovery for jobs left running by a crashed worker |
| Receivables (invoices) | e2e-local | EVM token invoice matched by unique amount; Solana SPL invoice matched by Solana Pay reference; manual allocation of an unmatched receipt; void; x402 payment of a public invoice through a local facilitator, applied once even when the indexer later sees the same transfer (`apps/worker/src/receivables.test.ts`, `apps/api/src/operations.test.ts`). Still required: devnet with CDP, partial-payment UX, refunds |
| Treasury indexer and reconciliation | e2e-local | Opening balance from chain; ERC-20 Transfer logs; top-level native EVM deposits; Solana SOL and SPL receipts at finalized commitment; idempotent re-sync; chain against ledger after each sync, including a detected break for a deposit made outside the indexer's view. Internal EVM value transfers into a treasury are not indexed and show as a difference |
| Beneficiaries and recurring payments | e2e-local | Owner wallet-signed approval over the exact address; `requireBeneficiary` policy; one intent per occurrence, idempotent enqueue, completion at the occurrence limit, skipped backlog recorded, schedules paused when a beneficiary is archived |
| Statements | e2e-local | Opening, inflows, outflows, fees, closing equal to the chain balance; JSON and CSV; month shorthand |
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
  and `packages/squads-adapter` (governance primitives), worker and API
  governance suites (Safe and Squads intents from agent submission to
  reconciliation).
- Boundary: executor keys are development software signers; nothing has run on
  a public test network.

## Public test networks

`pnpm --filter @ai-neobank/worker exec tsx src/devnet-preflight.ts` reads the
public networks without sending anything and reports what is ready. The devnet
lifecycle itself is `apps/worker/src/devnet.test.ts`, run with `RUN_DEVNET=1`.
Base Sepolia needs a funded key in `DEVNET_EVM_KEY`, because its faucets are
gated behind an account; Solana devnet funds a fresh treasury from the cluster
faucet during the run.
