# Working in this repo

Floatlane (UI brand "Relay"): crypto-only neobank. Humans own Safe (EVM) or Squads
(Solana) treasuries; AI agents submit payment intents that humans approve. Built by
Codex 2026-09-16/17, taken over by Claude 2026-09-17. Status report with evidence:
`~/status-reports/ai-neobank.md`.

**Keep it short.** Rules that prevented a real failure, and one line per instance.

## Who is working on what

| instance | writes | mid-way through |
|---|---|---|
| achi-b6 (Claude, takeover) | everything under this repo | closing the money-path security holes first (auth, policy, freezes, asset confusion, recoverable execution), then the milestone list |

## Ports (this repo's block is 8720-8729)

    54339  Postgres (docker compose project `ai-neobank`, infra/docker-compose.yml)
    8720   API            8721  web (next dev)
    8722   anvil          8724  solana-test-validator RPC (ws 8725), faucet 8726

Never run integration tests against 8545/8899: those belong to other repos.
`lsof -ti :<port>` before binding. Kill by PID only.

## Rules

- The Codex dev signer `0x9ECc...279d` and its master key are in a Codex log in
  plaintext. Treat as compromised; never fund it off a local chain.
- The Codex thread goal is still active and auto-continues on resume (usage reset
  2026-09-22). Do not resume it without giving it the current state first.
