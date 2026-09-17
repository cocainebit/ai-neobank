import { describe, expect, it } from "vitest";
import { createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner, exportDevelopmentSecret } from "@ai-neobank/signer";
import { deploySafeProtocolFixture, SafeGovernanceAdapter, recoverSafeSigner, type CompiledSafeTransaction } from "@ai-neobank/safe-adapter";
import { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { createWorker, type WorkerChainConfig } from "./worker.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const safeTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const squadsTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && solanaRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(21);
const evmNetwork = "eip155:31337" as const;
const solNetwork = "solana:localnet" as const;

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

async function untilStatus(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, organizationId: string, intentId: string, wanted: string[], attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    await runtime.worker.drain();
    const current = (await store.getIntent(organizationId, intentId))!.intent;
    if (wanted.includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = await store.getIntent(organizationId, intentId);
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""} ${JSON.stringify(detail?.execution)}`);
}

describe("Safe treasury through the worker", () => {
  safeTestIf("publishes the Safe transaction, collects owner signatures, executes with a non-owner executor, reconciles", async () => {
    const store = createPostgresStore(databaseUrl!);
    const ownerKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
    const owners = ownerKeys.map((key) => privateKeyToAccount(key));
    await anvil("anvil_setBalance", [owners[0]!.address, "0x56bc75e2d63100000"]);
    const contracts = await deploySafeProtocolFixture(evmRpc!, 31337, ownerKeys[0]!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, confirmations: 1, safeContracts: contracts } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const safe = new SafeGovernanceAdapter({ rpcUrl: evmRpc!, chainId: 31337, contracts });
      const deployment = await safe.deploy(ownerKeys[0]!, owners.map((owner) => owner.address), 2);
      const viemChain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
      const wallet = createWalletClient({ account: owners[0]!, chain: viemChain, transport: http(evmRpc) });
      const publicClient = createPublicClient({ chain: viemChain, transport: http(evmRpc) });
      await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: owners[0]!, to: deployment.address as Address, value: parseEther("5") }) });

      // Organisation: owner 0 and owner 1 are principals; owner 2 exists on chain but is not registered.
      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "evm", address: owners[0]!.address, displayName: "Owner", organizationName: "Safe org", slug: `safe-${suffix}` });
      const second = await store.addMember(owner.organizationId, { displayName: "Second", role: "approver", wallet: { chainFamily: "evm", address: owners[1]!.address } }, owner.principalId);
      const agent = await store.createAgent(owner.organizationId, { displayName: "Payables", purpose: "Pay vendors" }, owner.principalId);
      const executor = generateSigner("evm");
      const encrypted = encryptSecret(executor.secret, masterKey);
      const executorSigner = await store.createSigner(owner.organizationId, { chainFamily: "evm", address: executor.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
      await anvil("anvil_setBalance", [executor.address, "0x8ac7230489e80000"]);
      const nativeAsset = `${evmNetwork}/slip44:60`;
      await store.ensureNativeAsset(evmNetwork, "evm");
      const observed = await safe.observe(deployment.address);
      const treasury = await store.createTreasury(owner.organizationId, { name: "Safe", chainFamily: "evm", network: evmNetwork, address: deployment.address, governance: "safe", executorSignerId: executorSigner.id, observedConfiguration: { owners: observed.owners, threshold: observed.threshold } }, owner.principalId);
      const policy = await store.createPolicy(owner.organizationId, { name: "Safe policy", definition: { frozen: false, maxPerTransactionBaseUnits: parseEther("2").toString(), maxDailyBaseUnits: parseEther("4").toString(), autoApproveUpToBaseUnits: "0", allowedNetworks: [evmNetwork], allowedAssets: [nativeAsset], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
      const destination = privateKeyToAccount(generatePrivateKey()).address;

      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `safe-${intentId}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Safe governed transfer", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      const published = await store.getIntent(owner.organizationId, intentId);
      expect(published?.intent.status).toBe("approval_required");
      // Quorum follows the Safe threshold (2), not the policy's 1.
      expect(published?.approval?.requiredApprovals).toBe(2);
      const ref = published!.approval!.externalRef as { kind: string; safeTx: CompiledSafeTransaction };
      expect(ref.kind).toBe("safe");
      expect(published?.approval?.compiledHash).toBe(ref.safeTx.safeTxHash.replace(/^0x/, ""));

      // Owner signatures are EIP-712 over the Safe transaction; a non-owner's signature is not counted at execution.
      const sign = async (key: Hex) => safe.signTypedDataFor(deployment.address, ref.safeTx, key);
      const first = await sign(ownerKeys[0]!);
      expect((await recoverSafeSigner(ref.safeTx.safeTxHash, first.signature)).toLowerCase()).toBe(owners[0]!.address.toLowerCase());
      const evidence = { expectedIntentVersion: published!.intent.version, compiledHash: published!.approval!.compiledHash!, simulationHash: published!.approval!.simulationHash! };
      const one = await store.decideIntent(owner.organizationId, intentId, { principalId: owner.principalId, decision: "approved", ...evidence, signedPayload: first.signature, signerAddress: first.owner });
      expect(one.intentStatus).toBe("approval_required");
      const secondSignature = await sign(ownerKeys[1]!);
      const two = await store.decideIntent(owner.organizationId, intentId, { principalId: second.id, decision: "approved", ...evidence, signedPayload: secondSignature.signature, signerAddress: secondSignature.owner });
      expect(two.intentStatus).toBe("approved");

      const done = await untilStatus(store, runtime, owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(done.status).toBe("reconciled");
      expect(await publicClient.getBalance({ address: destination })).toBe(parseEther("1"));
      const detail = (await store.getIntent(owner.organizationId, intentId))!;
      expect((detail.execution?.observed as { reconciliation?: string })?.reconciliation).toBe("matched");
      expect((await safe.observe(deployment.address)).nonce).toBe(1);
      expect(await publicClient.getBalance({ address: executor.address })).toBeLessThan(parseEther("10"));
      void exportDevelopmentSecret;

      // A second intent approved against a nonce the Safe has since moved past fails clearly instead of executing.
      const stale = crypto.randomUUID();
      await store.createIntent({ id: stale, idempotencyKey: `safe-${stale}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Stale nonce", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      const staleDetail = (await store.getIntent(owner.organizationId, stale))!;
      const staleRef = staleDetail.approval!.externalRef as { safeTx: CompiledSafeTransaction };
      expect(staleRef.safeTx.nonce).toBe(1);
      // Owners execute something else directly, moving the nonce to 2.
      const direct = await safe.buildNativeTransfer(deployment.address, ownerKeys[0]!, destination, parseEther("0.1"));
      await safe.collectSignatures(deployment.address, direct.transaction, direct.safeTransactionHash, [ownerKeys[0]!, ownerKeys[1]!]);
      await safe.execute(deployment.address, ownerKeys[0]!, direct.transaction);
      const staleEvidence = { expectedIntentVersion: staleDetail.intent.version, compiledHash: staleDetail.approval!.compiledHash!, simulationHash: staleDetail.approval!.simulationHash! };
      const s1 = await safe.signTypedDataFor(deployment.address, staleRef.safeTx, ownerKeys[0]!);
      const s2 = await safe.signTypedDataFor(deployment.address, staleRef.safeTx, ownerKeys[1]!);
      await store.decideIntent(owner.organizationId, stale, { principalId: owner.principalId, decision: "approved", ...staleEvidence, signedPayload: s1.signature, signerAddress: s1.owner });
      await store.decideIntent(owner.organizationId, stale, { principalId: second.id, decision: "approved", ...staleEvidence, signedPayload: s2.signature, signerAddress: s2.owner });
      const failed = await untilStatus(store, runtime, owner.organizationId, stale, ["reconciled", "failed"]);
      expect(failed.status).toBe("failed");
      expect(failed.failureReason).toContain("nonce moved");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 180_000);
});

describe("Squads treasury through the worker", () => {
  squadsTestIf("executor publishes the proposal, members vote on chain, votes are mirrored, executor executes, reconciles", async () => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "finalized" } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const connection = new Connection(solanaRpc!, "confirmed");
      const adapter = new SolanaAdapter({ rpcUrl: solanaRpc!, network: solNetwork, finality: "confirmed" });
      const squads = new SquadsGovernanceAdapter(adapter);
      const airdrop = async (address: PublicKey, sol: number) => {
        const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
        await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      };
      const members = [Keypair.generate(), Keypair.generate()];
      const executor = generateSigner("svm");
      const encrypted = encryptSecret(executor.secret, masterKey);
      await Promise.all([airdrop(members[0]!.publicKey, 3), airdrop(members[1]!.publicKey, 2), airdrop(new PublicKey(executor.address), 2)]);
      const created = await squads.create(members[0]!, [
        { key: members[0]!.publicKey.toBase58(), role: "owner" },
        { key: members[1]!.publicKey.toBase58(), role: "owner" },
        { key: executor.address, role: "executor" }
      ], 2);
      await airdrop(new PublicKey(created.vaultPda), 3);

      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "svm", address: members[0]!.publicKey.toBase58(), displayName: "Owner", organizationName: "Squads org", slug: `squads-${suffix}` });
      const agent = await store.createAgent(owner.organizationId, { displayName: "Payables", purpose: "Pay vendors" }, owner.principalId);
      const executorSigner = await store.createSigner(owner.organizationId, { chainFamily: "svm", address: executor.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
      const nativeAsset = `${solNetwork}/slip44:501`;
      await store.ensureNativeAsset(solNetwork, "svm");
      const observed = await squads.observe(created.multisigPda);
      const treasury = await store.createTreasury(owner.organizationId, { name: "Vault", chainFamily: "svm", network: solNetwork, address: created.vaultPda, governance: "squads", executorSignerId: executorSigner.id, observedConfiguration: { multisigPda: created.multisigPda, threshold: observed.threshold, members: observed.members } }, owner.principalId);
      const policy = await store.createPolicy(owner.organizationId, { name: "Vault policy", definition: { frozen: false, maxPerTransactionBaseUnits: String(2 * LAMPORTS_PER_SOL), maxDailyBaseUnits: String(4 * LAMPORTS_PER_SOL), autoApproveUpToBaseUnits: "0", allowedNetworks: [solNetwork], allowedAssets: [nativeAsset], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
      const destination = Keypair.generate().publicKey.toBase58();

      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `squads-${intentId}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: solNetwork, assetId: nativeAsset, amountBaseUnits: "1000000", destination, purpose: "Squads governed transfer", expiresAt: new Date(Date.now() + 180_000).toISOString(), kind: "transfer" });
      const published = await untilStatus(store, runtime, owner.organizationId, intentId, ["approval_required", "rejected", "failed"]);
      expect(published.status).toBe("approval_required");
      const detail = (await store.getIntent(owner.organizationId, intentId))!;
      const ref = detail.approval!.externalRef as { kind: string; multisigPda: string; transactionIndex: string };
      expect(ref.kind).toBe("squads");
      expect(detail.approval?.requiredApprovals).toBe(2);
      expect(detail.intent.policyDecision).toMatchObject({ outcome: "approval_required" });
      expect(await squads.publishedBy(ref.multisigPda, BigInt(ref.transactionIndex), executor.address)).toBe(true);

      // First member votes on chain; the mirror records one approval and the intent stays pending.
      await squads.vote(ref.multisigPda, BigInt(ref.transactionIndex), members[0]!, "approved");
      await runtime.worker.drain();
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      await runtime.worker.drain();
      const partial = (await store.getIntent(owner.organizationId, intentId))!;
      expect(partial.intent.status).toBe("approval_required");
      expect(partial.approval?.approvals).toBe(1);
      expect(partial.approval?.decisions[0]).toMatchObject({ principalId: owner.principalId, signerAddress: members[0]!.publicKey.toBase58() });

      // Second member (not a registered principal) votes; the on-chain threshold approves and the executor runs it.
      await squads.vote(ref.multisigPda, BigInt(ref.transactionIndex), members[1]!, "approved");
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      const done = await untilStatus(store, runtime, owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(done.status).toBe("reconciled");
      expect(await connection.getBalance(new PublicKey(destination), "finalized")).toBe(1_000_000);
      const final = (await store.getIntent(owner.organizationId, intentId))!;
      expect(final.approval?.decisions.find((decision) => decision.signerAddress === members[1]!.publicKey.toBase58())?.principalId).toBeNull();
      expect((await squads.observeProposal(ref.multisigPda, BigInt(ref.transactionIndex)))?.status).toBe("executed");
      expect(final.events.map((event) => event.eventType)).toContain("intent.policy_evaluated");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 240_000);
});
