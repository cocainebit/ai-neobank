# Backend architecture

Status: implementation blueprint  
Scope: non-custodial, multichain agent treasury on EVM and Solana  
Explicitly excluded: fiat custody, cards, bank accounts, bridges, yield, and
anonymous conversion between crypto and fiat

## 1. What the product is

Relay is a control plane over user-owned smart accounts. Humans and businesses
own Safe accounts on EVM and Squads vaults on Solana. AI agents submit structured
payment intents. Relay evaluates deterministic policies, simulates the resulting
chain action, coordinates human approvals, and records the complete audit trail.

Relay is not the asset custodian and does not store unrestricted treasury keys.
The blockchain and smart-account programs are authoritative for ownership and
execution. Relay's database is authoritative for product identity, policy
versions, agent capabilities, intent history, notification state, and its
double-entry projection.

## 2. Non-negotiable invariants

1. An LLM never receives a private key, reusable wallet session, raw signing
   capability, database credential, or unrestricted RPC method.
2. Agents submit normalized intents, never arbitrary serialized transactions.
3. The policy engine is deterministic and runs again immediately before signing
   and execution.
4. A transaction is decoded and simulated before any approval request is shown.
5. Approval UI displays semantic actions, not only hashes or calldata.
6. Every mutation is idempotent and every state transition is append-only.
7. Each treasury stays native to its chain. Aggregated values are explicitly
   marked as projections and never presented as one spendable balance.
8. Safe/Squads state wins when it conflicts with the database.
9. Mainnet and automatic execution are disabled by configuration until their
   individual release gates pass.
10. No integration is considered operational because its health endpoint returns
    `200`; its complete money lifecycle must pass.

## 3. Deployment shape

Start as a modular monolith with separately scalable processes. Do not begin with
microservices; the correctness burden of distributed transactions would slow the
first safe release.

```text
                         Internet
                            |
                  CDN / WAF / rate limits
                            |
                 +----------+----------+
                 |                     |
              Next.js                Fastify API
             web console        public + agent API
                 |                     |
                 +----------+----------+
                            |
                  application modules
        +-------------------+--------------------+
        | identity | treasury | intent | policy  |
        | approval | execution | ledger | audit  |
        +-------------------+--------------------+
                            |
          +-----------------+------------------+
          |                 |                  |
      PostgreSQL       durable worker      object storage
   state/events/outbox  workflows/indexers receipts/exports
          |                 |
          |        +--------+---------+
          |        |                  |
          |    EVM/Safe          Solana/Squads
          |        |                  |
          +---- reconciliation and finality ----+
```

Deployables:

- `apps/web`: user console and wallet interactions.
- `apps/api`: stateless HTTP API, authentication, validation, commands/queries.
- `apps/worker`: durable jobs, chain indexers, execution, reconciliation,
  notifications, and retry handling.
- PostgreSQL: system of record, append-only event log, transactional outbox, and
  job queue for the first release.
- S3-compatible object storage: receipt files, exported audit bundles, signed
  evidence, and large provider payloads.

Redis is not required initially. Add it only for distributed rate limiting or
high-volume ephemeral caching. It must never hold authoritative workflow state.

## 4. Module boundaries

### 4.1 Identity and authentication

Responsibilities:

- organizations, humans, agents, service accounts, and memberships
- wallet challenge generation and verification
- sessions, passkeys, recovery factors, and device records
- agent capability credentials and revocation
- roles: owner, approver, operator, auditor, developer, agent

Human authentication:

- EVM: SIWE-compatible nonce, domain, URI, chain ID, issued-at, and expiration
  signed by an EOA or verified through ERC-1271 for smart-account owners.
- Solana: domain-bound Sign-In With Solana message with nonce and expiration.
- After wallet proof, issue an opaque, rotated, HTTP-only session cookie.
- Require WebAuthn/passkey step-up for policy changes, new agent credentials,
  treasury changes, emergency unfreeze, and mainnet approvals.

Agent authentication:

- An owner creates an `AgentPrincipal` and a scoped capability grant.
- Store only a keyed hash of the agent secret.
- Exchange the bootstrap secret for short-lived, audience-bound access tokens.
- Tokens identify organization, agent, environment, allowed intent kinds, and
  capability version. Revocation increments the version.
- Prefer asymmetric DPoP-style proof for production agent clients so a stolen
  bearer token cannot be replayed from another runtime.

### 4.2 Organization and membership

Responsibilities:

- organization metadata and environment separation
- membership invitations and role bindings
- human approval eligibility
- organization-wide freeze state
- quorum policies that sit above chain-native thresholds

An organization can own multiple treasury accounts on multiple networks. The
same address on a different chain is never assumed to be the same principal.

### 4.3 Treasury registry

Responsibilities:

- registry of Safe and Squads accounts
- chain/network identity through CAIP-2
- account identity through CAIP-10 where applicable
- governance adapter configuration
- observed owners/members, threshold, modules, guards, and spending limits
- supported assets and valuation metadata
- last reconciled block/slot and health state

Treasury onboarding is proof-based:

1. User connects a wallet.
2. Relay reads the Safe/Squads configuration from chain.
3. User signs an ownership challenge.
4. Relay verifies the signer is an authorized owner/member.
5. Indexer backfills account configuration and recent activity.
6. Treasury becomes usable only after reconciliation reaches the chain head.

### 4.4 Agent registry

Responsibilities:

- agent identity, owner, purpose, runtime metadata, and status
- attached policy and capability versions
- emergency freeze/revoke
- rate and concurrency ceilings
- last-seen and suspicious-use signals

An agent is not added as a Safe owner or Squads member by default. Initial agent
actions produce proposals for humans. Later autonomous execution uses a distinct,
low-value executor identity constrained independently on-chain and off-chain.

### 4.5 Intent service

Accepts the only write primitive available to an agent: `PaymentIntent`.

Required envelope:

```json
{
  "idempotencyKey": "agent-generated-unique-key",
  "treasuryAccountId": "trsy_...",
  "kind": "transfer | contract_call | x402",
  "network": "eip155:84532",
  "assetId": "caip-19-or-native-id",
  "amountBaseUnits": "25000000",
  "destination": "chain-native-address-or-service-origin",
  "purpose": "Purchase market data for job 1842",
  "expiresAt": "2026-09-17T03:00:00Z",
  "evidence": {
    "quoteHash": "...",
    "sourceUrl": "https://vendor.example/report"
  }
}
```

The service validates syntax and ownership, normalizes addresses, resolves asset
decimals from trusted metadata, writes the intent and initial event in one
transaction, then writes an outbox message for asynchronous evaluation.

### 4.6 Policy engine

Pure package with no network or database access. Inputs are a canonical intent,
an immutable policy version, and a trusted context snapshot.

Rules:

- organization/treasury/agent freeze
- allowed chain and account
- allowed intent kind
- native/contract/token allowlist
- EVM target and function-selector allowlist
- Solana program and instruction allowlist
- destination/origin allowlist
- per-transaction maximum
- rolling daily, weekly, and monthly exposure
- velocity, concurrency, and retry ceilings
- operating schedule and expiry
- minimum owner approval count
- human-presence requirement
- allowed x402 facilitator, scheme, asset, and payee
- risk-score ceiling and manual-review override

Output:

```text
rejected | approval_required | auto_authorized
+ rule-by-rule decision trace
+ policy version and context hash
```

Never allow an unknown field or unknown instruction to fall through as allowed.

### 4.7 Transaction compiler

Converts an approved normalized intent into chain-specific unsigned material.

EVM compiler:

- resolves chain ID from the treasury, never user input alone
- builds native/ERC-20 transfer or allowlisted contract call
- decodes target, value, selector, and arguments back to a semantic action
- calculates the Safe transaction hash
- rejects delegate calls unless explicitly enabled for an audited module

Solana compiler:

- builds a versioned transaction/message for the Squads vault
- decodes every program ID, account meta, signer/writable flag, and instruction
- rejects unknown programs and unexpected writable accounts
- resolves address lookup tables before policy evaluation

Compilation is deterministic. Store compiler version and canonical compiled hash.

### 4.8 Simulation and risk service

Runs after initial policy evaluation and again before execution.

Checks:

- current balance and spendable amount
- gas/fee estimate and fee-payer balance
- EVM `eth_call`, revert decoding, token balance delta, approval changes, emitted
  log expectations, and suspicious unlimited approvals
- Solana simulation logs, compute usage, account balance changes, token-owner
  changes, program errors, and unexpected account writes
- quote expiry and slippage where relevant
- malicious or changed destination metadata

Simulation produces a signed/hash-addressed snapshot. Approval is invalidated if
compiled transaction, policy version, quote, membership, or relevant chain state
changes materially.

### 4.9 Governance orchestrator

Unified interface:

```ts
interface GovernanceAdapter {
  observeAccount(): Promise<AccountConfiguration>;
  buildProposal(compiled: CompiledTransaction): Promise<UnsignedProposal>;
  publishProposal(proposal: SignedProposal): Promise<ExternalProposalRef>;
  observeApprovals(ref: ExternalProposalRef): Promise<ApprovalState>;
  execute(ref: ExternalProposalRef): Promise<SubmittedTransaction>;
  cancelOrReject(ref: ExternalProposalRef): Promise<void>;
}
```

Safe adapter:

- Protocol Kit for account and transaction primitives
- API Kit/Transaction Service only for exchanging proposals/signatures
- Relay persists its own proposal/evidence state
- support operating with a self-hosted Transaction Service or direct signature
  collection if the hosted service is unavailable
- no module, guard, fallback handler, or delegate call is assumed safe merely
  because the Safe accepted it

Squads adapter:

- official `@sqds/multisig` SDK behind a version-pinned package boundary
- create vault transaction, proposal, approve/reject, execute, and cancel
- explicitly verify vault PDA, transaction index, member permissions, spending
  limits, time lock, and instruction set
- reconcile from program accounts and finalized transaction logs

### 4.10 Approval service

Responsibilities:

- approval requests and eligibility
- required quorum snapshots
- WebAuthn step-up challenge
- binding signature to intent, compiled hash, simulation hash, policy version,
  amount, destination, expiry, and organization
- rejection reasons and expiry
- approval invalidation after material change

An application approval is evidence, not a substitute for the required
chain-native signature. Chain signatures remain in the wallet/provider flow.

### 4.11 Execution service

Runs only in the worker process.

Responsibilities:

- acquire an advisory lock on intent/treasury/nonce
- reload authoritative state
- re-run policy and simulation
- check approval validity and chain quorum
- execute or submit through the governance adapter
- record provider request/response hashes
- move to `submitted`, never directly to `completed`
- schedule confirmation and reconciliation jobs

Automatic execution is a separate capability with independent per-network caps.
It cannot reuse the API process identity or a human wallet session.

### 4.12 x402 adapter

Flow:

1. Agent requests a protected resource without automatic wallet middleware.
2. Relay captures the `402` requirements and normalizes network, asset, maximum
   amount, facilitator, payee, resource origin, and expiry.
3. Policy engine evaluates the quote.
4. Governance/execution creates the scoped payment authorization.
5. Relay retries once with idempotency binding.
6. Receipt and resource response hashes enter reconciliation.

The generic HTTP client must never transparently pay arbitrary `402` responses.
Allowed origins and redirect behavior are explicit policy inputs. Refunds are
separate transactions because stablecoin settlement may be irreversible.

### 4.13 Chain indexers

EVM indexer:

- one cursor per chain and watched address set
- Safe configuration and execution events
- token transfers, native balance snapshots, and transaction receipts
- confirmation policy per chain, finalized checkpoint, and reorg rollback
- RPC provider quorum/failover for critical reads

Solana indexer:

- one finalized signature/slot cursor per program/account partition
- Squads program account changes and transaction logs
- token accounts and native balances
- confirmed state for UI speed, finalized state for ledger finality
- fork rollback to last finalized checkpoint

Indexing is idempotent using network + transaction/signature + event/instruction
index as the natural uniqueness key.

### 4.14 Ledger and reconciliation

Maintain a double-entry projection per organization, treasury, asset, and network.
The ledger does not create or custody assets; it explains observed movement.

Account classes:

- treasury asset
- pending outbound
- settled expense
- pending inbound
- fee expense
- external counterparty
- reconciliation suspense

Example outbound lifecycle:

```text
submission:  debit pending_outbound / credit treasury_asset
finalized:   debit settled_expense  / credit pending_outbound
fee:         debit fee_expense      / credit treasury_asset
reorg/fail:  compensating entries; never delete history
```

Reconciliation continuously compares:

- indexed chain balances
- sum of finalized ledger entries
- pending transactions and nonce/signature state
- provider proposal status

Any unexplained difference freezes automatic execution for that treasury and
creates an incident.

### 4.15 Audit and evidence

Every security-relevant action writes an immutable audit event containing:

- event ID, organization, actor and actor type
- request ID, trace ID, IP/device metadata where appropriate
- previous and next state
- canonical payload hash
- policy/compiler/simulator versions
- external network and transaction reference
- timestamp from the server and observed chain time

Daily audit roots can be hashed and anchored externally later. Do not put private
user or intent data on-chain merely for auditability.

### 4.16 Notifications

Channels: in-app first, then email/webhook. Notifications are driven from outbox
events and are never part of the transaction that changes financial state.

Notify on:

- approval requested, approved, rejected, or expired
- policy denial and repeated denial
- transaction submitted, finalized, failed, or replaced
- new device/wallet/agent credential
- freeze/unfreeze and policy changes
- reconciliation mismatch or integration degradation

Webhook delivery uses signatures, timestamps, replay protection, exponential
backoff, and a dead-letter view.

## 5. Database model

All primary keys are opaque UUIDv7/ULID-style identifiers. Monetary values are
`numeric(78,0)` base-unit integers plus an explicit asset ID; never floating
point. All timestamps use UTC `timestamptz`.

Core tables:

```text
organizations
organization_members
principals
human_wallets
sessions
webauthn_credentials
agent_credentials
capability_grants

treasury_accounts
treasury_membership_snapshots
treasury_asset_balances
network_configs
asset_registry

policies
policy_versions
policy_bindings
spend_counters

intents
intent_events
intent_evidence
compiled_transactions
simulation_runs

proposals
approval_requests
approvals
external_proposal_refs
submitted_transactions
chain_receipts

ledger_accounts
ledger_transactions
ledger_entries
reconciliation_runs
reconciliation_breaks

chain_cursors
chain_events
integration_health

audit_events
outbox_events
jobs
webhook_endpoints
webhook_deliveries
notifications
```

Critical uniqueness constraints:

- `(organization_id, agent_id, idempotency_key)` on intents
- `(network, transaction_hash, event_index)` on EVM events
- `(network, signature, instruction_index, inner_index)` on Solana events
- `(intent_id, compiled_hash)` on compiled transactions
- `(proposal_id, principal_id, approval_version)` on approvals
- `(ledger_transaction_id, ledger_account_id, direction, sequence)` on entries
- `(outbox_event_id, consumer)` on processed messages

Use row-level organization predicates in every repository method. PostgreSQL RLS
can provide defense in depth, but application authorization remains mandatory.

## 6. Intent state machine

```text
received
  -> validating
  -> policy_evaluated
       -> rejected
       -> compiling
            -> simulation_failed
            -> approval_required
                 -> rejected
                 -> expired
                 -> approved
            -> auto_authorized
approved / auto_authorized
  -> executing
  -> submitted
       -> finalized
       -> failed
       -> replaced
       -> dropped
finalized
  -> reconciled
  -> reconciliation_break
```

Only the state-transition module may mutate intent status. Each transition
requires an expected prior version to prevent concurrent double execution.

## 7. HTTP API

Human API:

```text
POST   /v1/auth/challenges
POST   /v1/auth/wallet/verify
POST   /v1/auth/passkey/options
POST   /v1/auth/passkey/verify
POST   /v1/auth/logout

GET    /v1/organizations/:id
GET    /v1/organizations/:id/treasuries
POST   /v1/organizations/:id/treasuries/onboard
GET    /v1/treasuries/:id/balances

GET    /v1/agents
POST   /v1/agents
PATCH  /v1/agents/:id
POST   /v1/agents/:id/freeze
POST   /v1/agents/:id/credentials/rotate

GET    /v1/policies
POST   /v1/policies
POST   /v1/policies/:id/versions

GET    /v1/intents
GET    /v1/intents/:id
POST   /v1/intents/:id/approve
POST   /v1/intents/:id/reject
POST   /v1/intents/:id/retry

GET    /v1/transactions
GET    /v1/ledger
GET    /v1/audit/export
```

Agent API:

```text
POST   /v1/agent/token
POST   /v1/agent/intents
GET    /v1/agent/intents/:id
POST   /v1/agent/intents/:id/cancel
GET    /v1/agent/capabilities
```

Internal/provider callbacks:

```text
POST   /internal/webhooks/:provider
GET    /internal/health/live
GET    /internal/health/ready
GET    /internal/metrics
```

Every POST requires an idempotency key. Return `202 Accepted` for asynchronous
financial workflows and a stable intent URL for polling/webhooks.

## 8. Durable jobs

Initial job engine: PostgreSQL-backed queue with `FOR UPDATE SKIP LOCKED`, leased
jobs, heartbeat, attempt count, scheduled retry, and dead-letter state. Enqueue
through a transactional outbox so database commits cannot lose work.

Job types:

- `intent.evaluate`
- `intent.compile`
- `intent.simulate`
- `approval.expire`
- `proposal.publish`
- `proposal.observe`
- `transaction.execute`
- `transaction.confirm`
- `chain.index.evm`
- `chain.index.solana`
- `ledger.project`
- `treasury.reconcile`
- `notification.deliver`
- `webhook.deliver`
- `integration.probe`

Execution jobs use advisory locks and idempotency checks. At-least-once delivery
is assumed; handlers must be safe to repeat.

## 9. Security architecture

### Key and secret boundaries

- Human keys stay in user wallets/hardware wallets.
- API keys and agent bootstrap secrets are hashed, never encrypted for recovery.
- Provider credentials live in a managed secret store and are injected only into
  the process that requires them.
- If automatic signing is introduced, use an HSM/MPC-managed restricted key in a
  separate signer service. The application never exports it.
- Separate keys, projects, databases, RPC credentials, and deploy identities for
  test and production.

### Transaction safety

- allowlist code, not prompt text, controls executable destinations
- block arbitrary delegate calls and Solana unknown programs
- protect against EVM nonce conflicts and Solana stale blockhashes
- bind approval to exact compiled hash and expiry
- require fresh simulation after configuration or price changes
- maximum-fee and maximum-slippage rules
- kill switch at organization, treasury, agent, network, and integration level

### Application safety

- strict CSP, no third-party scripts on approval/signing screens
- HTTP-only secure session cookies and CSRF protection
- schema validation with unknown fields rejected
- per-agent and per-organization rate limits
- SSRF protection for x402/resource fetching: DNS/IP validation, redirect limit,
  private-range blocking, content-size/time limits, and egress proxy
- encrypted database/storage, least-privilege IAM, dependency pinning and SBOM
- audit log access separated from normal operator roles

## 10. Integration health

Each adapter reports a capability matrix rather than a boolean:

```text
configured
rpc_reachable
chain_id_verified
read_path_verified
simulation_verified
write_path_verified
indexer_current
reconciliation_current
automatic_execution_allowed
last_success_at
last_error_code
```

If write verification, indexer freshness, or reconciliation freshness fails,
automatic execution is disabled. Humans may still inspect/export data.

## 11. Observability and operations

- OpenTelemetry trace from HTTP request through outbox, worker, RPC call, and
  reconciliation.
- Structured logs with request/intent/treasury/network IDs; no secrets, raw
  signed messages, or personal data.
- Metrics: intent latency by state, policy rejection rate, simulation failure,
  approval time, RPC error/latency, indexer lag, finality time, reconciliation
  breaks, queue lag, retries, and dead letters.
- SLOs for initial production candidate:
  - API availability: 99.9%
  - accepted intent durably recorded: p95 < 500 ms
  - policy evaluation: p95 < 100 ms
  - indexer lag: < 2 finalized blocks / < 32 finalized Solana slots
  - zero unexplained ledger differences tolerated for automatic execution
- Runbooks for provider outage, chain halt/reorg, leaked credential, stuck nonce,
  stale Solana blockhash, reconciliation mismatch, and emergency freeze.

## 12. Environments

Local:

- PostgreSQL
- Anvil chain ID 31337
- `solana-test-validator`
- locally deployed Safe/Squads programs
- fake email/webhook sink

Staging:

- Base Sepolia and Solana Devnet
- separate hosted RPC providers with failover
- dedicated Safe/Squads accounts containing faucet assets only
- production-identical auth, worker, indexer, and reconciliation topology

Production candidate:

- initially one EVM network and Solana mainnet, manually approved transactions
- low balance caps per treasury and global circuit breakers
- no autonomous mainnet execution until sustained reconciliation evidence and an
  external security review

## 13. Repository target

```text
apps/
  web/
  api/
  worker/
packages/
  domain/
  auth/
  policy/
  intent-service/
  transaction-compiler/
  simulation/
  chain-core/
  evm-adapter/
  solana-adapter/
  safe-adapter/
  squads-adapter/
  x402-adapter/
  ledger/
  audit/
  database/
  observability/
  config/
  ui/
infra/
  docker/
  migrations/
  terraform/
tests/
  contract/
  integration/
  e2e/
  adversarial/
```

## 14. Delivery sequence

### Milestone 0 — stop calling the prototype production

- persistent banner identifying test mode
- remove fixture addresses from any copy/send flow
- deploy only the frontend preview
- complete this architecture and threat model

### Milestone 1 — durable control plane

- PostgreSQL migrations and repository layer
- organization, membership, wallet authentication, agent credentials
- intent API, policy versions, audit events, outbox, and worker
- frontend reads real API data; no browser-local financial state

Exit: created proposal survives redeploy, is scoped to an authenticated
organization, and has a complete audit trail.

### Milestone 2 — observed treasuries

- Safe and Squads read/onboarding adapters
- EVM and Solana indexers
- balances and membership from chain
- double-entry projection and reconciliation

Exit: UI fixtures are gone; balances and transactions match independently
queried test networks.

### Milestone 3 — human-approved execution

- compiler, simulation, semantic approval UI
- Safe and Squads proposal/sign/execute lifecycle
- confirmation, finality, failure, replacement, and reconciliation

Exit: a human-approved testnet transfer completes end to end on both families,
including denial, rejection, expiry, retry, and provider-outage cases.

### Milestone 4 — x402

- protected-resource quote acquisition
- policy-bound x402 authorization on Base Sepolia and Solana Devnet
- idempotent resource retry and refund workflow

Exit: paid API calls reconcile to intent, chain transaction, resource receipt,
and ledger entries.

### Milestone 5 — security and production candidate

- passkey step-up, device/session controls, CSP and SSRF egress boundary
- external smart-account/application security review
- disaster recovery, key/credential rotation, alerts and runbooks
- capped mainnet manual approvals

Exit: signed release checklist and incident exercise; still no automatic mainnet
execution.

### Milestone 6 — constrained autonomy

- separately managed restricted executor
- dual on-chain/off-chain limits
- low-value allowlisted operations only
- automatic freeze on indexer/reconciliation/integration degradation

Exit: explicit risk approval backed by production evidence, not merely passing
tests.

## 15. Current implementation status

Implemented and verified:

- chain-neutral domain and policy packages
- local EVM native transfer lifecycle on Anvil
- local Solana native transfer lifecycle on `solana-test-validator`
- frontend interaction prototype and browser test
- PostgreSQL control plane, versioned migrations, transactional outbox, leased
  durable worker, and safe-default approval request transition
- encrypted EVM/Solana development signer generation and agent binding
- transactional human approval state machine with role eligibility, quorum,
  evidence/version binding, rejection, expiry, idempotent replay, and audit trail
- isolated-worker direct EVM/Solana execution with encrypted signer access,
  simulation, broadcast, confirmation, double-entry projection, and reconciliation
- official Safe Protocol Kit adapter with custom-network contract deployment,
  Safe prediction/deployment, observation, transaction hashing, distinct-owner
  signature aggregation, threshold enforcement, and execution

Not implemented:

- production authentication
- Safe/Squads governance lifecycle
- real treasury onboarding and balances
- execution, confirmation, indexer, and reconciliation job handlers
- indexers, ledger, and reconciliation
- deployed backend
- x402 execution
- production signer or automatic execution

The app becomes a functioning financial control plane only after Milestones 1–3.
