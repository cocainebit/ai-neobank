# Failure recovery

What Relay must survive to be trusted with money, how each case is proven, and
how to run the drills. The drills are ordinary tests: `apps/worker/src/recovery.test.ts`,
run by `pnpm test:integration` against the local chains.

## The rule

A payment moves money at most once. Anything Relay cannot determine (an RPC it
cannot reach, a node that has not yet seen a transaction) is a reason to wait,
never a reason to declare a payment dead or to send it again.

## Proven by drill

| Failure | What must happen | Proof |
| --- | --- | --- |
| Worker dies after signing, before the bytes leave the process | The same signed transaction is resent on recovery; the nonce is used once | `integration.test.ts` crash injection, case 1 |
| Worker dies after broadcasting, before recording it | Recovery finds the transaction on chain and never sends a second one | `integration.test.ts` case 2, and `recovery.test.ts` with a different worker instance taking over |
| Worker disappears holding a job lease | Another worker claims the job once the lease lapses, and the payment settles once | `recovery.test.ts` lease drill |
| Chain RPC unreachable during recovery | The payment is left alone: not resent, not failed. It settles when the RPC returns | `recovery.test.ts` RPC outage drill |
| Treasury balance drops below the amount after broadcast | Recovery must not re-simulate; a signed execution is resolved from chain state only | Same drill: the recovery path skips simulation, the Safe nonce check, and the x402 balance check |
| Nobody approves before the intent expires | The intent expires with no execution row | `recovery.test.ts` expiry drill |
| Signed transaction can never land (nonce consumed elsewhere) | The intent fails cleanly, with the reason | `integration.test.ts` dead-nonce case |
| A treasury holds an asset whose contract is unreadable | That asset is skipped with an error; the treasury's other assets still sync | `worker.syncTreasury` per-asset isolation |
| A Safe x402 payment retried after a crash | The authorization's nonce comes from the intent, so a retry re-sends the same authorization; the token's `authorizationState` makes a second settlement impossible | `packages/x402-adapter` (`buildEip3009Authorization`), exercised by the Safe x402 suites |
| Duplicate submission of the same request | The original intent is returned; no second payment | `apps/api/src/app.test.ts` idempotency |
| Approval replayed or applied to a changed intent | Refused on the version and evidence hashes | `apps/api/src/app.test.ts`, `governance.test.ts` |

## Running the drills

```sh
scripts/localnet.sh up
pnpm migrate
DATABASE_URL=postgres://relay@127.0.0.1:8723/relay EVM_RPC_URL=http://127.0.0.1:8722 \
  RUN_WORKER_INTEGRATION=1 pnpm --filter @ai-neobank/worker exec vitest run --no-file-parallelism src/recovery.test.ts
```

Suites share one job queue, so they run one at a time. A worker configured for
one chain will claim another suite's jobs if they run together.

## Not yet drilled

Postgres failover mid-transaction, a chain reorg deeper than the configured
confirmation depth, a Safe or Squads proposal executed outside Relay while an
intent is in flight, and clock skew between the API and the chain.
