# Architecture

## Product invariant

The human or organization owns every treasury. An AI agent is a delegated actor,
never the legal owner, root administrator, or unrestricted signer. Product
behavior is chain-neutral; custody and execution are chain-specific.

## System context

```text
Human wallet/passkey
       |
       v
Web console ----> API/BFF ----> Postgres audit projection
       |              |
       |              +----> Policy engine (chain-neutral)
       |              +----> Execution router
       |                          |-- Solana adapter -> Squads -> Solana
       |                          |-- EVM adapter ----> Safe ----> EVM
       |                          `-- x402 adapter ---> EVM or Solana
       |
       `---- wallet signs chain-specific proposal/transaction

Agent runtime ---> scoped capability API ---> intent queue
                                            |
                         reject / propose / auto-execute
```

The database is an indexed projection and audit log. Each chain and smart-account
protocol remains authoritative for balances, membership, proposals, approvals,
allowances, and execution.

## Multichain model

The product does not expose one fictional omnichain balance. An organization owns
one or more `TreasuryAccount` records:

```text
Organization
  `-- TreasuryAccount[]
        |-- chain family: svm | evm
        |-- network: CAIP-2 identifier
        |-- smart account: Squads vault PDA | Safe address
        |-- governance adapter
        |-- execution adapter
        `-- assets and chain-native balances
```

Intent and policy schemas use CAIP identifiers, base-unit integer amounts, and
checksummed/native addresses. Chain-specific transaction bytes never enter the
common domain until an approved intent is compiled by an execution adapter.

There is no automatic bridge, synthetic consolidated balance, or cross-chain
atomicity in the MVP. Cross-chain movement is a future explicit intent type with
separate bridge risk policies.

## Trust boundaries

1. **Agent boundary:** accepts structured intents only. It cannot submit arbitrary
   serialized transactions or access treasury keys.
2. **Policy boundary:** pure, deterministic evaluation over normalized intent,
   current policy, exposure, and trusted price/asset metadata.
3. **Signing boundary:** human wallets sign approvals. Automated signing, if
   introduced later, uses a separately funded member key constrained by Squads
   permissions and spending limits.
4. **Chain boundary:** simulate, decode, and re-check every transaction immediately
   before signing. Reject unknown Solana programs and EVM targets/selectors unless
   explicitly allowed.
5. **Integration boundary:** adapters expose typed capabilities and are disabled
   unless their startup health check and end-to-end verification pass.

## Core domains

### Organization

Maps a product workspace to one or more chain-native treasury accounts: Squads
multisigs/vault PDAs and Safe smart-account addresses. Stores display metadata
and indexed chain state, never treasury secrets.

### Principal

A human, service, or AI agent identity. Humans authenticate with a wallet and,
later, passkeys. Agents authenticate through short-lived, audience-bound tokens.

### Intent

A chain-neutral request such as transfer, x402 purchase, swap, or subscription.
Every intent includes requester, organization, asset, maximum amount,
destination, source treasury, network, purpose, expiry, idempotency key, and
evidence. Network and asset identity use CAIP-compatible identifiers.

### Policy

Versioned rules evaluated without an LLM:

- per-transaction maximum
- rolling daily/weekly/monthly allowance
- asset and destination allowlists
- protocol/program allowlists
- time window and expiration
- minimum approval threshold
- velocity and concurrency limit
- human-presence requirement
- emergency freeze

### Proposal

The product representation of a chain-specific proposal: Squads transaction and
proposal on Solana, or Safe transaction and collected confirmations on EVM. It
stores the normalized decoded action, simulation result, policy decision,
signatures/votes, and chain identifiers.

### Ledger projection

Double-entry application records reconcile chain events without pretending to
be the asset custodian. Each projected entry points to its finalized transaction.

## Decision states

```text
received -> normalized -> simulated -> policy_evaluated
                                      |-> rejected
                                      |-> approval_required -> approved
                                      `-> auto_authorized
approved/auto_authorized -> submitted -> finalized -> reconciled
                                      |-> failed
                                      `-> expired
```

Transitions are append-only. Corrections create compensating events rather than
mutating history.

## MVP integrations

### Squads Protocol v4

Use the official `@sqds/multisig` TypeScript SDK for multisig creation,
transactions, proposals, voting, execution, roles, spending limits, and
timelocks. Because the v4 repository is AGPL-3.0, obtain legal review before
shipping a distribution that may be affected by its license.

### Safe Protocol

Use the MIT-licensed Safe Protocol Kit to create and configure EVM smart accounts,
build transactions, calculate Safe transaction hashes, collect owner signatures,
and execute. Use the Safe API Kit/Transaction Service only as an availability
optimization for off-chain proposal and signature exchange; persist our own audit
record and remain able to self-host or operate without that centralized service.

Start with conventional threshold execution. Treat ERC-4337, bundlers,
paymasters, and modules as optional adapters after the base Safe lifecycle passes
verification. Agent keys are not Safe owners by default.

### Solana

Use `@solana/kit` for new RPC and transaction utilities where compatible. Isolate
Squads SDK interoperability that still requires legacy `@solana/web3.js` types
inside its adapter.

### EVM

Use viem for typed RPC, simulation, log decoding, and wallet interoperability.
Base Sepolia is the reference test network; adapters must use the CAIP-2 chain ID
and never infer a network from an address. Contract calls require target address,
function selector, value, and decoded arguments to pass policy independently.

### x402

Start with x402 v2 and official test facilities on Solana devnet and Base Sepolia.
The x402 adapter must first return a normalized quote to the policy engine; it
must not automatically retry a `402 Payment Required` with an unrestricted
wallet. Smart-account signing compatibility is a verification gate, not an
assumption.

### Explicitly deferred

- Card issuing and browser checkout
- ACH, wires, RTP, SEPA, or fiat balances
- Centralized exchange funding and off-ramp
- Custodial recovery
- Yield, lending, leverage, and bridging
- Mainnet auto-execution
- Cross-chain bridges and swaps

These require separate regulatory, counterparty, and security approval. A vendor
claiming production cards without KYC is not an acceptable dependency.

## Proposed repository structure

```text
apps/
  web/                 Next.js console
  api/                 intent, policy, proposal, and webhook API
  worker/              chain indexing and reconciliation
packages/
  domain/              pure domain types and state machines
  policy/              deterministic policy compiler/evaluator
  ledger/              double-entry projection
  chain-core/          CAIP ids, normalized actions, adapter contracts
  squads-adapter/      @sqds/multisig governance integration
  solana-adapter/      SVM RPC, simulation, decoding, confirmation
  safe-adapter/        Safe proposal, signature, and execution integration
  evm-adapter/         EVM RPC, simulation, decoding, confirmation
  x402-adapter/        multichain quote and payment execution
  ui/                  design tokens and accessible components
  config/              validated environment configuration
tests/
  integration/         devnet and sandbox contract tests
  e2e/                 browser flows
```

## Technology decisions

- TypeScript monorepo with pnpm and Turborepo
- Next.js for the console and BFF-facing routes
- Fastify for explicit API/worker services
- PostgreSQL with an append-only event log plus query projections
- Redis only for ephemeral rate limits and job coordination, never authority
- OpenTelemetry traces with correlation IDs from intent through chain finality
- Vitest for units/contracts and Playwright for end-to-end flows
- Zod schemas at every external boundary

## Delivery sequence

1. Establish design system and static console shell.
2. Implement pure domains, intent state machine, and policy evaluator.
3. Define adapter conformance tests shared by SVM and EVM implementations.
4. Prove Squads local-validator/devnet lifecycle end to end.
5. Prove Safe local-chain/Base Sepolia lifecycle end to end.
6. Add multichain balances, proposals, approvals, and reconciliation.
7. Prove x402 purchases on both chain families with policy-denial tests.
8. Add agent capability API, rotation, revocation, and emergency freeze.
9. Threat model, adversarial prompt-injection tests, and external review.
10. Only then evaluate mainnet with capped funds per treasury/network.
