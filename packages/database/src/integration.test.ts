import { describe, expect, it } from "vitest";
import { createPostgresJobQueue, createPostgresStore } from "./index.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const testIf = enabled ? it : it.skip;

describe("PostgreSQL control-plane store", () => {
  testIf("persists an organization and revocable agent identity", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const store = createPostgresStore(databaseUrl);
    const queue = createPostgresJobQueue(databaseUrl);
    try {
      expect(await store.health()).toBe(true);
      const suffix = crypto.randomUUID().slice(0, 8);
      const organization = await store.createOrganization({ name: "Integration Test", slug: `integration-${suffix}` });
      const agent = await store.createAgent(organization.id, { displayName: "Test agent", purpose: "Verify durable control-plane storage" });
      expect((await store.listAgents(organization.id))[0]?.displayName).toBe("Test agent");
      const frozen = await store.setAgentStatus(organization.id, agent.id, "frozen");
      expect(frozen?.status).toBe("frozen");
      expect(frozen?.capabilityVersion).toBe(2);
      const signer = await store.createSigner(organization.id, {
        agentId: agent.id,
        chainFamily: "evm",
        address: `0x${crypto.randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
        encryptedSecret: "ciphertext-only",
        encryptionNonce: "nonce",
        authTag: "tag",
        keyVersion: 1
      });
      expect((await store.listSigners(organization.id))[0]).not.toHaveProperty("encryptedSecret");
      expect((await store.getSignerSecret(organization.id, signer.id))?.encryptedSecret).toBe("ciphertext-only");
      const treasury = await store.createTreasury(organization.id, {
        name: "Local treasury",
        chainFamily: "evm",
        network: "eip155:31337",
        address: signer.address,
        governance: "direct"
      });
      expect((await store.listTreasuries(organization.id))[0]?.id).toBe(treasury.id);
      const approver = await store.createHumanPrincipal(organization.id, { displayName: "Owner", role: "owner" });
      const intentId = crypto.randomUUID();
      await store.createIntent({
        id: intentId,
        idempotencyKey: `integration-${crypto.randomUUID()}`,
        organizationId: organization.id,
        treasuryAccountId: treasury.id,
        requesterId: agent.principalId,
        network: "eip155:31337",
        assetId: "slip44:60",
        amountBaseUnits: "1000",
        destination: "0x000000000000000000000000000000000000dEaD",
        purpose: "Approval lifecycle integration test",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        kind: "transfer"
      });
      await queue.pumpOutbox();
      let job = await queue.claim("integration-test");
      while (job && job.type !== "intent.evaluate") {
        await queue.complete(job.id);
        job = await queue.claim("integration-test");
      }
      expect(job?.type).toBe("intent.evaluate");
      await queue.evaluateIntent(intentId);
      if (job) await queue.complete(job.id);
      const approval = await store.getApprovalRequest(organization.id, intentId);
      expect(approval?.compiledHash).toMatch(/^[a-f0-9]{64}$/);
      await expect(store.decideIntent(organization.id, intentId, {
        principalId: approver.id,
        decision: "approved",
        expectedIntentVersion: 2,
        compiledHash: "0".repeat(64),
        simulationHash: approval?.simulationHash ?? ""
      })).rejects.toMatchObject({ code: "evidence_mismatch" });
      const approved = await store.decideIntent(organization.id, intentId, {
        principalId: approver.id,
        decision: "approved",
        expectedIntentVersion: 2,
        compiledHash: approval?.compiledHash ?? "",
        simulationHash: approval?.simulationHash ?? ""
      });
      expect(approved.intentStatus).toBe("approved");
      expect((await store.decideIntent(organization.id, intentId, {
        principalId: approver.id,
        decision: "approved",
        expectedIntentVersion: 2,
        compiledHash: approval?.compiledHash ?? "",
        simulationHash: approval?.simulationHash ?? ""
      })).idempotentReplay).toBe(true);
    } finally {
      await queue.close();
      await store.close();
    }
  });
});
