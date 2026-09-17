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

## Not yet

x402, a frontend on the real API, invoicing/beneficiaries/recurring/statements,
HSM/KMS signing, devnet runs, CI. The web app in `apps/web` is still the earlier
fixture prototype.

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

Checks: `pnpm typecheck`, `pnpm test` (unit), `pnpm test:integration` (builds,
migrates, then runs database, EVM, Solana, worker, API, and Safe suites against
the local chains). `pnpm localnet:down` stops the services by recorded PID.

## Layout

`apps/api` (Fastify HTTP API), `apps/worker` (durable jobs: evaluate, expire,
execute, confirm), `apps/web` (Next.js prototype), `packages/auth` (sign-in and
key material), `packages/database` (PostgreSQL store, migrations, job queue,
ledger), `packages/domain` (schemas), `packages/policy` (pure policy engine),
`packages/chain-core` (adapter interfaces), `packages/evm-adapter`,
`packages/solana-adapter`, `packages/safe-adapter`, `packages/squads-adapter`,
`packages/signer` (AES-256-GCM envelope for development keys).

Design references: `docs/BACKEND-ARCHITECTURE.md`, `docs/THREAT-MODEL.md`,
`docs/PRODUCT-SUITE.md`, `DESIGN.md`.
