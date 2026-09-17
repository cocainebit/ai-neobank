import { describe, expect, it } from "vitest";
import { createPostgresJobQueue, createPostgresStore, ExecutionRejected, type PostgresControlPlaneStore } from "./index.js";
import type { PolicyDefinitionInput } from "@ai-neobank/domain";

const databaseUrl = process.env.DATABASE_URL;
const testIf = process.env.RUN_DATABASE_INTEGRATION === "1" && databaseUrl ? it : it.skip;
const network = "eip155:31337";
const nativeAsset = `${network}/slip44:60`;
const address = () => `0x${crypto.randomUUID().replaceAll("-", "").padEnd(40, "0")}`;

function policy(overrides: Partial<PolicyDefinitionInput> = {}): PolicyDefinitionInput {
  return { frozen: false, maxPerTransactionBaseUnits: "1000", maxDailyBaseUnits: "1500", autoApproveUpToBaseUnits: "0", allowedNetworks: [network], allowedAssets: [nativeAsset], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 2, ...overrides };
}

async function intent(store: PostgresControlPlaneStore, input: { organizationId: string; treasuryAccountId: string; requesterId: string; amount: string; assetId?: string; destination?: string }) {
  const id = crypto.randomUUID();
  await store.createIntent({ id, idempotencyKey: `db-${crypto.randomUUID()}`, organizationId: input.organizationId, treasuryAccountId: input.treasuryAccountId, requesterId: input.requesterId, network, assetId: input.assetId ?? nativeAsset, amountBaseUnits: input.amount, destination: input.destination ?? address(), purpose: "Database integration", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
  return id;
}

describe("PostgreSQL control plane", () => {
  testIf("identity, policy enforcement, quorum, freezes, and execution gating", async () => {
    const store = createPostgresStore(databaseUrl!);
    const queue = createPostgresJobQueue(databaseUrl!);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const ownerWallet = address();
      const owner = await store.bootstrapOwner({ chainFamily: "evm", address: ownerWallet, displayName: "Owner", organizationName: "Integration", slug: `db-${suffix}` });
      expect(owner.role).toBe("owner");
      const approverWallet = address();
      const approver = await store.addMember(owner.organizationId, { displayName: "Approver", role: "approver", wallet: { chainFamily: "evm", address: approverWallet } }, owner.principalId);
      expect(approver.wallets[0]?.verifiedAt).toBeNull();
      expect((await store.findMemberships("evm", approverWallet))[0]?.principalId).toBe(approver.id);

      // Challenges are single-use; sessions expire and revoke.
      await store.createChallenge({ nonce: `n-${suffix}`, chainFamily: "evm", address: ownerWallet, domain: "relay.test", message: "m", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await store.consumeChallenge(`n-${suffix}`))?.address).toBe(ownerWallet);
      expect(await store.consumeChallenge(`n-${suffix}`)).toBeNull();
      await store.createSession({ organizationId: owner.organizationId, principalId: owner.principalId, walletId: owner.walletId, tokenHash: `h-${suffix}`, expiresAt: new Date(Date.now() + 60_000) });
      expect((await store.getSession(`h-${suffix}`))?.role).toBe("owner");
      await store.revokeSession(`h-${suffix}`);
      expect(await store.getSession(`h-${suffix}`)).toBeNull();

      // Agent, credential, treasury, signer, asset, policy.
      const agent = await store.createAgent(owner.organizationId, { displayName: "Payables", purpose: "Pay vendors" }, owner.principalId);
      const credential = await store.createAgentCredential(owner.organizationId, agent.id, { keyId: `k${suffix}`, secretHash: "hash", createdBy: owner.principalId });
      expect((await store.findAgentCredential(credential.keyId))?.principalId).toBe(agent.principalId);
      await store.ensureNativeAsset(network, "evm");
      const treasuryAddress = address();
      const treasury = await store.createTreasury(owner.organizationId, { name: "Ops", chainFamily: "evm", network, address: treasuryAddress, governance: "direct" }, owner.principalId);
      await store.createSigner(owner.organizationId, { chainFamily: "evm", address: treasuryAddress, encryptedSecret: "c", encryptionNonce: "n", authTag: "t", keyVersion: 1 }, owner.principalId);
      const created = await store.createPolicy(owner.organizationId, { name: "Vendor policy", definition: policy(), createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: created.id, agentId: agent.id }, owner.principalId);
      expect((await store.listPolicies(owner.organizationId))[0]?.bindings[0]?.agentId).toBe(agent.id);

      // Per-transaction limit rejects at intake.
      const tooLarge = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "2000" });
      await queue.evaluateIntent(tooLarge);
      const rejected = await store.getIntent(owner.organizationId, tooLarge);
      expect(rejected?.intent.status).toBe("rejected");
      expect(rejected?.intent.failureReason).toContain("Per-transaction limit");

      // Unknown asset rejects.
      const unknownAsset = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "10", assetId: `${network}/erc20:${address()}` });
      await queue.evaluateIntent(unknownAsset);
      expect((await store.getIntent(owner.organizationId, unknownAsset))?.intent.failureReason).toContain("Unknown asset");

      // Within limits: needs two approvals, taken from the policy.
      const first = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "900" });
      await queue.evaluateIntent(first, async () => ({ ok: true, feeBaseUnits: "21000", sourceBalanceBaseUnits: "1000000" }));
      const request = await store.getApprovalRequest(owner.organizationId, first);
      expect(request?.requiredApprovals).toBe(2);
      expect(request?.simulationHash).toMatch(/^[a-f0-9]{64}$/);
      const evidence = { expectedIntentVersion: 2, compiledHash: request!.compiledHash!, simulationHash: request!.simulationHash! };
      await expect(store.decideIntent(owner.organizationId, first, { principalId: agent.principalId, decision: "approved", ...evidence })).rejects.toMatchObject({ code: "not_eligible" });
      const one = await store.decideIntent(owner.organizationId, first, { principalId: owner.principalId, decision: "approved", ...evidence });
      expect(one).toMatchObject({ intentStatus: "approval_required", approvals: 1, requiredApprovals: 2 });
      const two = await store.decideIntent(owner.organizationId, first, { principalId: approver.id, decision: "approved", ...evidence });
      expect(two).toMatchObject({ intentStatus: "approved", approvals: 2 });

      // Daily limit counts the approved intent.
      const overDaily = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "900" });
      await queue.evaluateIntent(overDaily);
      expect((await store.getIntent(owner.organizationId, overDaily))?.intent.failureReason).toContain("Daily limit");

      // Frozen agent cannot spend; the execution gate also re-checks.
      await store.setAgentStatus(owner.organizationId, agent.id, "frozen", owner.principalId);
      const frozenAgent = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "10" });
      await queue.evaluateIntent(frozenAgent);
      expect((await store.getIntent(owner.organizationId, frozenAgent))?.intent.failureReason).toContain("frozen");
      await expect(queue.getExecutionContext(first)).rejects.toBeInstanceOf(ExecutionRejected);
      await store.setAgentStatus(owner.organizationId, agent.id, "active", owner.principalId);
      const context = await queue.getExecutionContext(first);
      expect(context.from).toBe(treasuryAddress);
      expect(context.asset.kind).toBe("native");
      expect(context.execution).toBeNull();

      // Frozen organisation blocks approvals.
      const pending = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "100" });
      await queue.evaluateIntent(pending);
      await store.updateOrganization(owner.organizationId, { frozen: true }, owner.principalId);
      const pendingRequest = await store.getApprovalRequest(owner.organizationId, pending);
      await expect(store.decideIntent(owner.organizationId, pending, { principalId: owner.principalId, decision: "approved", expectedIntentVersion: 2, compiledHash: pendingRequest!.compiledHash!, simulationHash: pendingRequest!.simulationHash! })).rejects.toMatchObject({ code: "frozen" });
      await store.updateOrganization(owner.organizationId, { frozen: false }, owner.principalId);

      // Terminal failure is recorded once.
      await queue.markFailed(first, "Test failure");
      const failed = await store.getIntent(owner.organizationId, first);
      expect(failed?.intent.status).toBe("failed");
      expect(failed?.intent.failureReason).toBe("Test failure");
      expect((await store.listAuditEvents(owner.organizationId)).some((event) => event.action === "intent.failed")).toBe(true);

      // Autonomous execution: auto_authorized only when the organisation allows it.
      const autoPolicy = await store.createPolicy(owner.organizationId, { name: "Auto", definition: policy({ humanApprovalRequired: false, autoApproveUpToBaseUnits: "100", minApprovals: 1 }), createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: autoPolicy.id, agentId: agent.id }, owner.principalId);
      const gated = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "50" });
      await queue.evaluateIntent(gated);
      expect((await store.getIntent(owner.organizationId, gated))?.intent.status).toBe("approval_required");
      await store.updateOrganization(owner.organizationId, { autonomousExecution: true }, owner.principalId);
      const auto = await intent(store, { organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, amount: "50" });
      await queue.evaluateIntent(auto);
      expect((await store.getIntent(owner.organizationId, auto))?.intent.status).toBe("approved");
    } finally {
      await queue.close();
      await store.close();
    }
  }, 30_000);
});
