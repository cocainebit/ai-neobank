import { describe, expect, it } from "vitest";
import { createPostgresJobQueue, createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { parseEther } from "viem";
import { Keypair } from "@solana/web3.js";
import { createWorker, type WorkerChainConfig } from "./worker.js";

/**
 * Failure-recovery drills: what happens when the worker dies, its lease lapses,
 * or the chain RPC goes away mid-flight. Money must move exactly once, and a
 * transient outage must never fail a payment that is already on chain.
 */
const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const drill = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(11);
const evmNetwork = "eip155:31337" as const;
const nativeAsset = `${evmNetwork}/slip44:60`;
// Inside this repo's port block and never bound, so a connection is refused at once.
const deadRpc = "http://127.0.0.1:8729";

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

async function workspace(store: PostgresControlPlaneStore) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: "evm", address: `0x${suffix.padEnd(40, "b")}`, displayName: "Owner", organizationName: "Recovery", slug: `recovery-${suffix}` });
  const agent = await store.createAgent(owner.organizationId, { displayName: "Executor", purpose: "Recovery drills" }, owner.principalId);
  const generated = generateSigner("evm");
  const encrypted = encryptSecret(generated.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: "evm", address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(evmNetwork, "evm");
  const treasury = await store.createTreasury(owner.organizationId, { name: "Direct", chainFamily: "evm", network: evmNetwork, address: generated.address, governance: "direct" }, owner.principalId);
  const policy = await store.createPolicy(owner.organizationId, { name: "Permissive", definition: { frozen: false, maxPerTransactionBaseUnits: "100000000000000000000", maxDailyBaseUnits: "1000000000000000000000", autoApproveUpToBaseUnits: "0", allowedNetworks: [evmNetwork], allowedAssets: [nativeAsset], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
  await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
  await anvil("anvil_setBalance", [generated.address, "0x8ac7230489e80000"]);
  return { owner, agent, treasury, signer: generated };
}

async function submitAndApprove(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, ws: Awaited<ReturnType<typeof workspace>>, destination: string) {
  const intentId = crypto.randomUUID();
  await store.createIntent({ id: intentId, idempotencyKey: `r-${crypto.randomUUID()}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Recovery drill", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
  await runtime.worker.drain();
  const request = await store.getApprovalRequest(ws.owner.organizationId, intentId);
  if (!request?.compiledHash || !request.simulationHash) throw new Error("No approval request");
  await store.decideIntent(ws.owner.organizationId, intentId, { principalId: ws.owner.principalId, decision: "approved", expectedIntentVersion: 2, compiledHash: request.compiledHash, simulationHash: request.simulationHash });
  return intentId;
}

async function untilStatus(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, organizationId: string, intentId: string, wanted: string[], attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    await runtime.worker.drain();
    const current = (await store.getIntent(organizationId, intentId))!.intent;
    if (wanted.includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = await store.getIntent(organizationId, intentId);
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""}`);
}

const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc ?? "", chainId: 31337, network: evmNetwork, confirmations: 1 } };

describe("failure recovery", () => {
  drill("a replacement worker finishes a payment the first worker broadcast and then died on", async () => {
    const store = createPostgresStore(databaseUrl!);
    // The first worker puts the bytes on chain and dies before recording the send.
    const first = createWorker(databaseUrl!, chain, {
      beforeBroadcast: async (context, signed) => {
        await anvil("eth_sendRawTransaction", [signed.raw]);
        throw new Error(`worker died after broadcasting ${context.intentId}`);
      }
    });
    let second: ReturnType<typeof createWorker> | null = null;
    try {
      const ws = await workspace(store);
      const destination = generateSigner("evm").address;
      const intentId = await submitAndApprove(store, first, ws, destination);
      await first.worker.drain();
      const afterDeath = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(afterDeath.execution?.status).toBe("signed");
      const signedHash = afterDeath.execution?.transactionHash;
      await first.close();

      // A different worker picks the payment up. It must find the transaction rather than send it again.
      second = createWorker(databaseUrl!, chain);
      await second.queue.sql`update jobs set run_at = now(), leased_until = null where status in ('queued', 'retry')`;
      const settled = await untilStatus(store, second, ws.owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(settled.status).toBe("reconciled");
      expect((await store.getIntent(ws.owner.organizationId, intentId))!.execution?.transactionHash).toBe(signedHash);
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));
      expect(await anvil("eth_getTransactionCount", [ws.signer.address, "latest"])).toBe("0x1");
    } finally {
      await second?.close();
      await store.close();
    }
  }, 180_000);

  drill("a job whose worker died is picked up after the lease lapses, and runs once", async () => {
    const store = createPostgresStore(databaseUrl!);
    const runtime = createWorker(databaseUrl!, chain);
    const abandoned = createPostgresJobQueue(databaseUrl!);
    try {
      const ws = await workspace(store);
      const destination = generateSigner("evm").address;
      const intentId = await submitAndApprove(store, runtime, ws, destination);
      // A worker claims the execute job with a one-second lease and never reports back.
      await abandoned.pumpOutbox();
      const claimed = await abandoned.claim("dead-worker", 1);
      expect(claimed?.type).toBe("transaction.execute");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const settled = await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(settled.status).toBe("reconciled");
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));
      expect(await anvil("eth_getTransactionCount", [ws.signer.address, "latest"])).toBe("0x1");
    } finally {
      await abandoned.close();
      await runtime.close();
      await store.close();
    }
  }, 180_000);

  drill("an RPC outage during recovery leaves a broadcast payment alone until the RPC returns", async () => {
    const store = createPostgresStore(databaseUrl!);
    let broadcastOnce = false;
    const healthy = createWorker(databaseUrl!, chain, {
      beforeBroadcast: async (context, signed) => {
        if (broadcastOnce) return;
        broadcastOnce = true;
        await anvil("eth_sendRawTransaction", [signed.raw]);
        throw new Error(`worker died after broadcasting ${context.intentId}`);
      }
    });
    const blind = createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: { rpcUrl: deadRpc, chainId: 31337, network: evmNetwork, confirmations: 1 } });
    try {
      const ws = await workspace(store);
      const destination = generateSigner("evm").address;
      const intentId = await submitAndApprove(store, healthy, ws, destination);
      await healthy.worker.drain();
      expect((await store.getIntent(ws.owner.organizationId, intentId))!.execution?.status).toBe("signed");

      // The RPC is unreachable, so recovery cannot tell whether the bytes landed.
      // It must leave the payment alone rather than resend it or fail it.
      await blind.queue.sql`update jobs set run_at = now(), leased_until = null where status in ('queued', 'retry')`;
      for (let attempt = 0; attempt < 3; attempt += 1) await blind.worker.drain();
      const during = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(during.intent.status).toBe("executing");
      expect(during.intent.failureReason).toBeNull();
      const jobs = await blind.queue.listJobs({ organizationId: ws.owner.organizationId });
      const executeJob = jobs.find((job) => job.type === "transaction.execute");
      expect(executeJob?.status).not.toBe("dead");

      // The RPC comes back.
      await healthy.queue.sql`update jobs set run_at = now(), leased_until = null where status in ('queued', 'retry')`;
      const settled = await untilStatus(store, healthy, ws.owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(settled.status).toBe("reconciled");
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));
    } finally {
      await blind.close();
      await healthy.close();
      await store.close();
    }
  }, 180_000);

  drill("an intent that nobody approves before it expires is expired, never signed", async () => {
    const store = createPostgresStore(databaseUrl!);
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const ws = await workspace(store);
      const destination = Keypair.generate().publicKey.toBase58();
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `r-${crypto.randomUUID()}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination: generateSigner("evm").address, purpose: `Expiry drill for ${destination.slice(0, 6)}`, expiresAt: new Date(Date.now() + 1_500).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      expect((await store.getIntent(ws.owner.organizationId, intentId))!.intent.status).toBe("approval_required");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const expired = await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["expired", "failed", "reconciled"], 20);
      expect(expired.status).toBe("expired");
      expect((await store.getIntent(ws.owner.organizationId, intentId))!.execution).toBeNull();
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 120_000);
});
