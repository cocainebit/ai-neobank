# Working in this repo

Floatlane (UI brand "Relay"): crypto-only neobank. Humans own Safe (EVM) or Squads
(Solana) treasuries; AI agents submit payment intents that humans approve. Built by
Codex 2026-09-16/17, taken over by Claude 2026-09-17. Status report with evidence:
`~/status-reports/ai-neobank.md`.

**Keep it short.** Rules that prevented a real failure, and one line per instance.

## Who is working on what

| instance | writes | mid-way through |
|---|---|---|
| achi-b6 (Claude, takeover) | everything under this repo | **done:** wallet auth, agent keys, policy/freeze/quorum on the durable path, sign-before-broadcast recovery, real finality, fee ledger, ERC-20/SPL. Safe + Squads on the intent path (executor never votes), x402 v2 from direct treasuries, invoices/beneficiaries/recurring/statements with a chain indexer and reconciliation, KMS custody and key/executor rotation. **next:** frontend on the real API, then devnet runs and CI |

## Ports (this repo's block is 8720-8755)

    8720   API            8721  web (next dev)        8723  postgres (scripts/localnet.sh, not Docker)
    8722   anvil          8724  solana-test-validator RPC (ws 8725), faucet 8726, gossip 8727, dynamic 8730-8755 (8760-8798 is ~/platform)

Never run integration tests against 8545/8899: those belong to other repos.
`lsof -ti :<port>` before binding. Kill by PID only.

## Rules

- The Codex dev signer `0x9ECc...279d` and its master key are in a Codex log in
  plaintext. Treat as compromised; never fund it off a local chain.
- Integration suites share one Postgres job queue. Run them one at a time: a
  worker configured for one chain will claim and poison another suite's jobs.
- The Codex thread goal is still active and auto-continues on resume (usage reset
  2026-09-22). Do not resume it without giving it the current state first.

## Local development

`scripts/dev.sh up|down|logs` runs API :8720, worker, web :8721 from `.local/dev.env` against the `relay_dev` database. Integration tests use the `relay` database; never point a running dev worker at it.
