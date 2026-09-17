# AI Neobank (product name "Relay")

A crypto-only financial control plane for humans and their AI agents. Humans own
the treasuries; agents submit structured payment intents; deterministic policy,
real simulation, and human approval decide what gets signed.

## What works today (verified locally, see `docs/INTEGRATION-VERIFICATION.md`)

- Wallet sign-in (EIP-4361 for EVM, Sign-In With Solana) with server sessions;
  the first sign-in from a wallet creates its organisation as owner. Members are
  pre-registered by wallet address and roles (owner, approver, operator,
  auditor, developer) gate every route.
- Agent runtimes authenticate with hashed API keys that can be revoked; agents
  can only submit intents and read their own.
- Intake runs freezes (organisation, treasury, agent), the bound spending policy
  (per-transaction, daily, network, asset, destination, kind), and a real chain
  simulation before an approval request exists. Quorum comes from the policy.
- Approvals are wallet-signed and bound to the intent version and evidence
  hashes. Execution re-runs freezes and policy immediately before signing.
- Execution signs first and records the signed bytes and hash before broadcast,
  so a crash between signing and sending is resolved from chain state: an
  unsent transaction is resent, a sent one is never sent twice, a dead one
  fails the intent.
- Finality is real: EVM confirmation depth, Solana `finalized` commitment. The
  ledger books pending, settlement, and network fees as balanced entries, and an
  intent is `reconciled` only when the chain shows the destination received the
  intended amount.
- Native and token transfers (ERC-20 and SPL) on EVM and Solana direct
  treasuries whose keys are held as encrypted software signers (local
  development custody only).
- Safe treasuries: Relay prepares the deployment for the owner's wallet,
  verifies owners and threshold on chain at registration, compiles the Safe
  transaction at intake, collects EIP-712 owner signatures as approvals, and an
  executor that is never an owner submits `execTransaction`. Quorum is the
  Safe's threshold. A nonce that moved before execution fails the intent
  instead of executing something else.
- Squads v4 treasuries: the executor is a member with Initiate and Execute
  only (registration refuses one that can vote). It publishes the vault
  transaction and proposal; members vote on chain with transactions the API
  builds for their wallets; the worker mirrors on-chain votes and executes once
  the program marks the proposal approved.

- x402 (v2, `exact` scheme) machine payments from direct treasuries: an agent
  submits an intent whose destination is the resource URL and whose amount is
  the most it may pay; intake fetches the 402, selects the option on the
  treasury's network and asset, rejects anything above the cap, and the quote
  itself becomes the compiled hash the approver signs over. After approval the
  worker signs the EIP-3009 authorization (EVM) or the payer-side transaction
  (Solana), persists it, sends the paid request, and books the settlement the
  seller returns. A retry re-sends the same payload, which the network can only
  honour once. Agents can dry-run quotes with `POST /v1/agent/x402/quote`.

- Receivables and payables. Invoices are matched automatically: Solana through
  a Solana Pay reference key, EVM tokens through a sub-cent identifier in the
  amount, or paid over x402 at a public invoice URL through a facilitator.
  Beneficiaries become payable only with an owner's wallet signature over the
  exact address, and a policy can require them. Recurring payments create
  ordinary intents once per occurrence (missed occurrences are skipped and
  recorded, not paid in a burst).
- A chain indexer books every receipt into each treasury, opening from the
  chain balance the first time it looks, and reconciles chain against ledger
  after each sync (matched, in flight, or break). Execution costs are booked
  where they were paid, including Solana rent for recipient token accounts.
  Statements per treasury and asset come from the ledger, in JSON or CSV.

- Key custody. Software signers are sealed under per-signer data keys wrapped
  by a versioned key-encryption key: a local keyring in development, AWS KMS in
  production (the API refuses locally wrapped software signers in production).
  EVM signers can instead live entirely in KMS (ECC_SECG_P256K1): transactions,
  Safe typed data, and messages are signed by KMS and the key never enters the
  process. `pnpm --filter @ai-neobank/worker rotate-keys` re-wraps every data
  key under the active key and upgrades legacy envelopes. A governed treasury's
  executor can be rotated: Safe swaps immediately; Squads goes through an
  on-chain config proposal the members approve.

- A web console (`apps/web`, Next.js) on the real API: wallet sign-in, treasury
  creation (Safe deployment, Squads vault, development account), payments with
  wallet approval, invoices with a public payment page (QR, wallet payment, and
  the x402 endpoint), receipts and allocation, recurring payments, statements
  with CSV, agents and API keys, policies, beneficiaries, members, an asset
  registry, and the activity log. Development wallets in the browser
  (`NEXT_PUBLIC_DEV_WALLET=1`) sign on local chains, so the whole product can be
  driven end to end without a browser extension.

## Not yet

Devnet runs and CI. KMS signing covers EVM keys;
Solana signers use KMS-wrapped envelopes. The KMS integration is verified
against the AWS SDK's own command objects and an in-process KMS stand-in,
not yet against a live AWS account. x402 from Safe or Squads treasuries is not
supported yet. An EVM invoice must be in a token: a native transfer into a Safe
cannot be attributed to an invoice.

## Run it locally

Requires Node 22, pnpm 10, Foundry (`anvil`), `solana-test-validator`, and a
Homebrew PostgreSQL (`postgres` on PATH). Everything binds to this repo's port
block (see `CLAUDE.md`), nothing to Docker.

```sh
pnpm install
pnpm localnet            # postgres :8723, anvil :8722, solana validator :8724 (Squads program cloned from devnet)
pnpm migrate
cp .env.example .env     # set SIGNER_MASTER_KEY=$(openssl rand -hex 32) and ALLOW_SOFTWARE_SIGNERS=true for development
pnpm dev:api             # http://127.0.0.1:8720
pnpm dev:worker
```

Or run the whole stack (API, worker, and console on http://localhost:8721)
against a `relay_dev` database, with development wallets enabled:

```sh
scripts/localnet.sh up   # also deploys Safe 1.4.1 singletons and a test token to Anvil
# write .local/dev.env (see .env.example; it must set SIGNER_KEYRING)
scripts/dev.sh up        # scripts/dev.sh logs | down
```

Checks: `pnpm typecheck`, `pnpm test` (unit), `pnpm --filter @ai-neobank/web
test:e2e` (Playwright against the running stack), `pnpm test:integration` (builds,
migrates, then runs database, EVM, Solana, worker, API, and Safe suites against
the local chains). `pnpm localnet:down` stops the services by recorded PID.

## Layout

`apps/api` (Fastify HTTP API), `apps/worker` (durable jobs: evaluate, expire,
execute, confirm), `apps/web` (Next.js console), `packages/auth` (sign-in and
key material), `packages/database` (PostgreSQL store, migrations, job queue,
ledger), `packages/domain` (schemas), `packages/policy` (pure policy engine),
`packages/chain-core` (adapter interfaces), `packages/evm-adapter`,
`packages/solana-adapter`, `packages/safe-adapter`, `packages/squads-adapter`,
`packages/x402-adapter` (client plus a local facilitator and seller for tests),
`packages/signer` (AES-256-GCM envelope for development keys).

Design references: `docs/BACKEND-ARCHITECTURE.md`, `docs/THREAT-MODEL.md`,
`docs/PRODUCT-SUITE.md`, `DESIGN.md`.
