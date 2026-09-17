# Threat model

## Protected assets

- treasury funds and governance authority
- human wallet approvals and session credentials
- agent capability credentials
- policy definitions and spend counters
- compiled transaction and simulation evidence
- audit history, receipts, and organization metadata

## Primary adversaries

- malicious or compromised AI agent
- prompt injection embedded in web/API/tool output
- stolen agent credential or browser session
- malicious destination, contract, token, or Solana program
- compromised RPC, facilitator, webhook, or indexing provider
- malicious organization member or operator
- dependency/supply-chain compromise
- attacker exploiting retry, nonce, race, or reorg behavior

## Required controls

| Threat | Control |
| --- | --- |
| Agent requests arbitrary transaction | Intent schema only; compiler owns bytes |
| Prompt asks agent to reveal key | Agent never has treasury/signing key |
| Prompt redirects payment | Destination/origin allowlist and semantic approval |
| Stolen capability token | Short expiry, DPoP binding, scope, rate limit, revocation |
| Replay/double spend | Idempotency key, versioned state machine, advisory execution lock |
| Approval bait-and-switch | Bind approval to compiled/simulation/policy hashes |
| Malicious EVM call | Target/selector/value/argument allowlist; block delegate call |
| Malicious Solana instruction | Program/account-meta/instruction allowlist |
| RPC lies or is stale | Provider failover/quorum, chain ID check, independent reconciliation |
| Chain reorg/fork | Confirmation policy, finalized cursor, compensating ledger entries |
| Hosted proposal service outage | Own durable state; self-host/direct fallback |
| x402 SSRF or hostile redirect | Egress proxy, origin policy, IP checks, redirect and size limits |
| Policy race | Immutable versions and final evaluation before execution |
| Spend-counter race | Serializable/advisory-lock reservation before authorization |
| Database compromise | No treasury keys; encrypted storage; tamper-evident audit export |
| Worker compromise | Least-privilege credentials, separate deploy identity, circuit breakers |
| Automatic signer compromise | HSM/MPC key plus on-chain limits and narrow allowlist |

## Kill switches

- global environment execution disable
- network disable
- integration disable
- organization freeze
- treasury freeze
- agent freeze and credential revocation
- intent cancellation before submission
- automatic-executor disable independent of human proposal flows

## Security release gates

- no critical/high findings in application and dependency scans
- external review of compiler, policy, approval binding, and governance adapters
- adversarial prompt-injection suite
- replay, concurrency, provider-outage, and reorg tests
- backup restore and credential-rotation exercise
- incident response exercise using the global freeze

