import { describe, expect, it } from "vitest";
import { createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { deploySafeProtocolFixture, SafeGovernanceAdapter, recoverSafeMessageSigner, safeMessageTypedData } from "@ai-neobank/safe-adapter";
import { createLocalFacilitator, startLocalSeller } from "@ai-neobank/x402-adapter/testing";
import { eip3009Digest, type Eip3009Authorization } from "@ai-neobank/x402-adapter";
import { tokenAssetId } from "@ai-neobank/domain";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { createWorker, type WorkerChainConfig } from "./worker.js";

/**
 * A Safe paying for an x402 resource. The Safe cannot sign an EIP-3009
 * authorization itself, so its owners sign a Safe message over the
 * authorization's digest and the token accepts the Safe's ERC-1271 signature at
 * settlement. No Relay key authorises the payment.
 */
const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const testIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(31);
const evmNetwork = "eip155:31337" as const;
const chainId = 31337;
const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

async function untilStatus(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, organizationId: string, intentId: string, wanted: string[], attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    await runtime.worker.drain();
    const current = (await store.getIntent(organizationId, intentId))!.intent;
    if (wanted.includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = await store.getIntent(organizationId, intentId);
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""}`);
}

describe("x402 from a Safe treasury", () => {
  testIf("owners authorise an EIP-3009 payment with a Safe message; the facilitator settles it through ERC-1271", async () => {
    const store = createPostgresStore(databaseUrl!);
    const ownerKeys = [generatePrivateKey(), generatePrivateKey()];
    const owners = ownerKeys.map((key) => privateKeyToAccount(key));
    const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // Anvil's published account
    const deployer = privateKeyToAccount(deployerKey);
    const facilitatorKey = generatePrivateKey();
    await Promise.all([
      anvil("anvil_setBalance", [owners[0]!.address, "0x56bc75e2d63100000"]),
      anvil("anvil_setBalance", [privateKeyToAccount(facilitatorKey).address, "0x8ac7230489e80000"])
    ]);
    const contracts = await deploySafeProtocolFixture(evmRpc!, chainId, ownerKeys[0]!);
    const chain = defineChain({ id: chainId, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const wallet = createWalletClient({ account: deployer, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const token = (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: deployer }) })).contractAddress as Address;
    const assetId = tokenAssetId(evmNetwork, "erc20", token);
    await store.upsertAsset({ id: assetId, network: evmNetwork, chainFamily: "evm", kind: "erc20", address: token, symbol: "TUSD", decimals: 6 });
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const facilitator = await createLocalFacilitator({ evm: { rpcUrl: evmRpc!, chainId, privateKey: facilitatorKey } });
    const seller = await startLocalSeller(facilitator.client, [
      { route: "GET /report", network: evmNetwork, payTo: payee, asset: token, amount: "250000", extra: { name: "Test USD", version: "2" }, body: { report: "quarterly" } }
    ], { evm: { rpcUrl: evmRpc! } });
    const runtime = createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId, network: evmNetwork, safeContracts: contracts } } satisfies WorkerChainConfig);
    try {
      const safe = new SafeGovernanceAdapter({ rpcUrl: evmRpc!, chainId, contracts });
      const deployment = await safe.deploy(ownerKeys[0]!, owners.map((owner) => owner.address), 2);
      await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [deployment.address as Address, 5_000_000n], account: deployer }) });

      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "evm", address: owners[0]!.address, displayName: "Owner", organizationName: "Safe x402", slug: `safe-x402-${suffix}` });
      const second = await store.addMember(owner.organizationId, { displayName: "Second", role: "approver", wallet: { chainFamily: "evm", address: owners[1]!.address } }, owner.principalId);
      const agent = await store.createAgent(owner.organizationId, { displayName: "Research", purpose: "Buy reports" }, owner.principalId);
      const executor = generateSigner("evm");
      const encrypted = encryptSecret(executor.secret, masterKey);
      const executorSigner = await store.createSigner(owner.organizationId, { chainFamily: "evm", address: executor.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
      await store.ensureNativeAsset(evmNetwork, "evm");
      const observed = await safe.observe(deployment.address);
      const treasury = await store.createTreasury(owner.organizationId, { name: "Safe", chainFamily: "evm", network: evmNetwork, address: deployment.address, governance: "safe", executorSignerId: executorSigner.id, observedConfiguration: { owners: observed.owners, threshold: observed.threshold } }, owner.principalId);
      const policy = await store.createPolicy(owner.organizationId, { name: "Machine payments", definition: { frozen: false, maxPerTransactionBaseUnits: "1000000", maxDailyBaseUnits: "5000000", autoApproveUpToBaseUnits: "0", allowedNetworks: [evmNetwork], allowedAssets: [assetId], allowedDestinations: [], allowedKinds: ["x402"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);

      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `safe-x402-${intentId}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: evmNetwork, assetId, amountBaseUnits: "1000000", destination: `${seller.url}/report`, purpose: "Quarterly report", expiresAt: new Date(Date.now() + 600_000).toISOString(), kind: "x402" });
      await runtime.worker.drain();

      const published = (await store.getIntent(owner.organizationId, intentId))!;
      expect(published.intent.status).toBe("approval_required");
      // Quorum is the Safe's threshold, not the policy's single approval.
      expect(published.approval?.requiredApprovals).toBe(2);
      const ref = published.approval!.externalRef as { kind: string; safeAddress: string; chainId: number; owners: string[]; authorization: Eip3009Authorization; digest: string; safeMessageHash: string };
      expect(ref.kind).toBe("safe_x402");
      expect(ref.safeAddress.toLowerCase()).toBe(deployment.address.toLowerCase());
      expect(ref.authorization.from.toLowerCase()).toBe(deployment.address.toLowerCase());
      expect(ref.authorization.to.toLowerCase()).toBe(payee.toLowerCase());
      expect(ref.authorization.value).toBe("250000");
      // Nothing is signed yet, and the authorization binds to this intent alone.
      expect(published.execution).toBeNull();

      // Owners sign the Safe message over the authorization digest, exactly as the console asks a wallet to.
      const typed = safeMessageTypedData(chainId, deployment.address, ref.digest);
      const sign = async (key: Hex) => privateKeyToAccount(key).signTypedData(typed);
      const evidence = { expectedIntentVersion: published.intent.version, compiledHash: published.approval!.compiledHash!, simulationHash: published.approval!.simulationHash! };

      // A wallet that is not an owner cannot move it forward: its signature recovers to a stranger.
      const stranger = generatePrivateKey();
      const strangerSignature = await sign(stranger);
      expect((await recoverSafeMessageSigner(ref.safeMessageHash, strangerSignature)).toLowerCase()).toBe(privateKeyToAccount(stranger).address.toLowerCase());
      expect(ref.owners.map((entry) => entry.toLowerCase())).not.toContain(privateKeyToAccount(stranger).address.toLowerCase());

      const firstSignature = await sign(ownerKeys[0]!);
      const one = await store.decideIntent(owner.organizationId, intentId, { principalId: owner.principalId, decision: "approved", ...evidence, signedPayload: firstSignature, signerAddress: owners[0]!.address });
      expect(one.intentStatus).toBe("approval_required");
      const secondSignature = await sign(ownerKeys[1]!);
      const two = await store.decideIntent(owner.organizationId, intentId, { principalId: second.id, decision: "approved", ...evidence, signedPayload: secondSignature, signerAddress: owners[1]!.address });
      expect(two.intentStatus).toBe("approved");

      const done = await untilStatus(store, runtime, owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(done.status).toBe("reconciled");
      expect(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [payee] })).toBe(250_000n);
      expect(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployment.address as Address] })).toBe(4_750_000n);
      // The executor paid nothing: the facilitator submitted the transfer.
      expect(await publicClient.getBalance({ address: executor.address as Address })).toBe(0n);
      const detail = (await store.getIntent(owner.organizationId, intentId))!;
      expect(detail.execution?.status).toBe("finalized");
      expect(eip3009Digest({ url: `${seller.url}/report`, method: "GET", x402Version: 2, requirements: (detail.intent.policyDecision as { x402: { requirements: never } }).x402.requirements, resource: {} as never, paymentRequired: {} as never }, ref.authorization, chainId)).toBe(ref.digest);
    } finally {
      await seller.close();
      await runtime.close();
      await store.close();
      void parseEther;
    }
  }, 180_000);
});
