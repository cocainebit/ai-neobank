# Working in this repo

Floatlane (UI brand "Relay"): crypto-only neobank. Humans own Safe (EVM) or Squads
(Solana) treasuries; AI agents submit payment intents that humans approve. Built by
Codex 2026-09-16/17, taken over by Claude 2026-09-17. Status report with evidence:
`~/status-reports/ai-neobank.md`.

**Keep it short.** Rules that prevented a real failure, and one line per instance.

## Who is working on what

| instance | writes | mid-way through |
|---|---|---|
| achi-b6 (Claude, takeover) | everything under this repo | **done:** wallet auth, agent keys, policy/freeze/quorum on the durable path, sign-before-broadcast recovery, real finality, fee ledger, ERC-20/SPL. Safe + Squads on the intent path (executor never votes), x402 v2 from direct treasuries, invoices/beneficiaries/recurring/statements with a chain indexer and reconciliation, KMS custody and key/executor rotation. Web console on the real API (every page, public pay page, dev wallets), verified in headless Chrome. Failure-recovery drills, Solana devnet settlement, CI workflow (never executed: no remote). Squads and x402 also settled on Solana devnet; browser-wallet path (foreign EIP-1193 provider) verified. x402 from a Safe works (owners sign a Safe message, settled via ERC-1271). **next:** Base Sepolia once a key is funded |
| achi-59 (Claude, session 228c1ae2) | `apps/web/app/(console)/vaults`, `apps/web/app/(console)/cards`, vault and governance UI, cards UI, verification gating, API routes and domain for vault creation, time locks, rejection transactions and verification | started 2026-09-21: owner asked for a create-a-vault flow in the console, time locks and rejection transactions, a Cards tab restricted until verification, and more human features. 2026-09-21: three security-review fixes in the time lock routes (config-transaction gate on the vote and change routes, treasury filter on `listIntents`, unknown lock start counts as locked); uncommitted |
| achi-59-web (Claude subagent, verification console) | `apps/web/app/(console)/verification/`, `apps/web/components/verification-application.tsx`, `apps/web/components/verification-banner.tsx`, `apps/web/lib/verification.ts` | started 2026-09-21: the console half of the verification application (requirements, business profile draft, wallet attestation, submit, reviewer decision, a screen per state). Reads the contract from the API; does not touch `apps/api` or `packages/domain`. Uncommitted |
| achi-59-domain (Claude subagent, session 228c1ae2) | `packages/domain/src/verification.ts`, `packages/domain/src/verification.test.ts` only | **done 2026-09-21**, uncommitted: verification application domain half. `verificationProfileSchema` (entity facts only, strict), `verificationProfileRequirements` + `verificationProfileExclusions`, `attestationStatement()`, `profileComplete()`, `canSubmitVerification()` / `verificationSubmitCheck()`. 96 domain tests green, repo typecheck green. `verificationReasonSchema` now shares one free-text rule with the new fields; same messages, same behaviour |
| achi-59-api (Claude subagent, session 228c1ae2) | `packages/database/migrations/009_verification_cases.sql`, `packages/database/src/index.ts` (append only), `apps/api/src/verification-routes.ts`, `apps/api/src/verification.test.ts` only | **done 2026-09-21**, uncommitted: verification application storage and API half. `verification_cases` table, `VerificationCaseStore` appended to the database package, `PUT /v1/verification/profile`, `GET /v1/verification/attestation`, `POST /v1/verification/submit` (server-built statement, `verifyWalletSignature`, started to pending), `GET /v1/verification` now carries profile + requirements + submission. 23 api tests, repo typecheck and `pnpm test` green; SQL proved on a throwaway database. **`relay_dev` is still on 008: run `DATABASE_URL=postgres://relay@127.0.0.1:8723/relay_dev pnpm --filter @ai-neobank/database migrate` or the running console 500s on `/v1/verification`** |
| achi-59-verify (Claude subagent, session 228c1ae2) | reconciled the three verification halves; **edited files the three of them own**: `packages/domain/src/verification.ts` + its test, `apps/api/src/verification-routes.ts` + its test, `apps/web/lib/verification.ts` + its test, `apps/web/components/verification-application.tsx`, `apps/web/components/cards-panel.tsx` | **done 2026-09-21**, uncommitted: verifier round 1. Contract fixes: requirement `options` are `{value,label}` so the entity-type enum renders as a list instead of a free-text box the API refused; `format` now reaches the form; the view carries `exclusions` and the submission's verbatim `statement` (never the signature); the draft is editable only while the case is `started` (a rejected or expired case kept its signature while the facts could still be edited under it); the decision's `reference` is held to an identifier charset so a data URL cannot be stored in it. Copy fixes where a screen claimed more than happened. 42 api + 42 domain + 29 web verification tests, repo typecheck and `pnpm test` green (218 unit). **Still open: `relay_dev` is on 008, so the running console 500s on `/v1/verification` until somebody runs the 009 migration** |
| achi-59-verify-2 (Claude subagent, session 228c1ae2) | verifier round 2; **edited files achi-59-web and achi-59-api own**: `packages/domain/src/verification.ts` + its test, `apps/api/src/verification.test.ts`, `apps/web/lib/verification.ts` + its test, `apps/web/components/verification-application.tsx`, `apps/web/components/verification-banner.tsx` | **done 2026-09-21**, uncommitted. Two real defects: (1) the data URL rule only matched `type/subtype`, so `data:;base64,...` and `data:,...` (both whole working data URLs) were stored by every free-text field and by the decision reason, fixed in the domain schema and mirrored in the console; (2) `decisionCopy` offered "With a reviewer", which the decision route refuses by name, and it was first in the list so it was the reviewer's default on an open case. Copy fixes where three sentences implied a decision opens cards; cards need an issuer and there is none. The console's prose check now covers every field the API holds to the free-text rule, not just the description. 231 unit tests green (domain 102, api 63, web 34), repo typecheck green. **Still open: `relay_dev` is on 008, so the running console 500s on `/v1/verification` until somebody runs the 009 migration** |

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
