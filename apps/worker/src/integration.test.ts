import { describe, expect, it } from "vitest";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { createWorker } from "./worker.js";
import { Connection, PublicKey } from "@solana/web3.js";

const evmTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && process.env.EVM_RPC_URL ? it : it.skip;
const solanaTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && process.env.SOLANA_RPC_URL ? it : it.skip;

describe("direct EVM execution worker", () => {
  evmTestIf("approves, simulates, signs, broadcasts, confirms, and reconciles", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const rpcUrl = process.env.EVM_RPC_URL;
    if (!databaseUrl || !rpcUrl) throw new Error("DATABASE_URL and EVM_RPC_URL are required");
    const masterKey = new Uint8Array(32).fill(11);
    const store = createPostgresStore(databaseUrl);
    const queue = createPostgresJobQueue(databaseUrl);
    const runtime = createWorker(databaseUrl, { signerMasterKey: masterKey, evm: { rpcUrl, chainId: 31337, network: "eip155:31337" } });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const organization = await store.createOrganization({ name: "Worker Integration", slug: `worker-${suffix}` });
      const agent = await store.createAgent(organization.id, { displayName: "Executor", purpose: "Execute integration transfers" });
      const owner = await store.createHumanPrincipal(organization.id, { displayName: "Owner", role: "owner" });
      const generated = generateSigner("evm");
      const encrypted = encryptSecret(generated.secret, masterKey);
      await store.createSigner(organization.id, { chainFamily: "evm", address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion });
      const treasury = await store.createTreasury(organization.id, { name: "Anvil", chainFamily: "evm", network: "eip155:31337", address: generated.address, governance: "direct" });
      const destination = generateSigner("evm").address;
      const rpc = async (method: string, params: unknown[]) => {
        const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const payload = await response.json() as { result?: unknown; error?: unknown };
        if (payload.error) throw new Error(JSON.stringify(payload.error));
        return payload.result;
      };
      await rpc("anvil_setBalance", [generated.address, "0x8ac7230489e80000"]);
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `worker-${crypto.randomUUID()}`, organizationId: organization.id, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: "eip155:31337", assetId: "slip44:60", amountBaseUnits: "1000000000000000", destination, purpose: "End-to-end worker execution", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await queue.evaluateIntent(intentId);
      const request = await store.getApprovalRequest(organization.id, intentId);
      if (!request?.compiledHash || !request.simulationHash) throw new Error("Approval evidence missing");
      await store.decideIntent(organization.id, intentId, { principalId: owner.id, decision: "approved", expectedIntentVersion: 2, compiledHash: request.compiledHash, simulationHash: request.simulationHash });
      for (let index = 0; index < 12; index += 1) {
        await runtime.worker.runOnce();
        const current = (await store.listIntents(organization.id)).find((item) => item.id === intentId);
        if (current?.status === "reconciled") break;
      }
      const intent = (await store.listIntents(organization.id)).find((item) => item.id === intentId);
      expect(intent?.status).toBe("reconciled");
      expect(BigInt(await rpc("eth_getBalance", [destination, "latest"]) as string)).toBe(1_000_000_000_000_000n);
    } finally {
      await runtime.close();
      await queue.close();
      await store.close();
    }
  }, 30_000);
});

describe("direct Solana execution worker", () => {
  solanaTestIf("approves, simulates, signs, broadcasts, confirms, and reconciles", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!databaseUrl || !rpcUrl) throw new Error("DATABASE_URL and SOLANA_RPC_URL are required");
    const masterKey = new Uint8Array(32).fill(12);
    const store = createPostgresStore(databaseUrl);
    const queue = createPostgresJobQueue(databaseUrl);
    const runtime = createWorker(databaseUrl, { signerMasterKey: masterKey, solana: { rpcUrl, network: "solana:localnet" } });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const organization = await store.createOrganization({ name: "Solana Worker Integration", slug: `svm-worker-${suffix}` });
      const agent = await store.createAgent(organization.id, { displayName: "Solana Executor", purpose: "Execute integration transfers" });
      const owner = await store.createHumanPrincipal(organization.id, { displayName: "Owner", role: "owner" });
      const generated = generateSigner("svm");
      const encrypted = encryptSecret(generated.secret, masterKey);
      await store.createSigner(organization.id, { chainFamily: "svm", address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion });
      const treasury = await store.createTreasury(organization.id, { name: "Local validator", chainFamily: "svm", network: "solana:localnet", address: generated.address, governance: "direct" });
      const destination = generateSigner("svm").address;
      const connection = new Connection(rpcUrl, "confirmed");
      const airdrop = await connection.requestAirdrop(new PublicKey(generated.address), 2_000_000_000);
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature: airdrop, ...latest }, "confirmed");
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `svm-worker-${crypto.randomUUID()}`, organizationId: organization.id, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: "solana:localnet", assetId: "slip44:501", amountBaseUnits: "1000000", destination, purpose: "End-to-end Solana worker execution", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await queue.evaluateIntent(intentId);
      const request = await store.getApprovalRequest(organization.id, intentId);
      if (!request?.compiledHash || !request.simulationHash) throw new Error("Approval evidence missing");
      await store.decideIntent(organization.id, intentId, { principalId: owner.id, decision: "approved", expectedIntentVersion: 2, compiledHash: request.compiledHash, simulationHash: request.simulationHash });
      for (let index = 0; index < 12; index += 1) {
        await runtime.worker.runOnce();
        const current = (await store.listIntents(organization.id)).find((item) => item.id === intentId);
        if (current?.status === "reconciled") break;
      }
      const intent = (await store.listIntents(organization.id)).find((item) => item.id === intentId);
      expect(intent?.status).toBe("reconciled");
      expect(await connection.getBalance(new PublicKey(destination), "confirmed")).toBe(1_000_000);
    } finally {
      await runtime.close();
      await queue.close();
      await store.close();
    }
  }, 30_000);
});
