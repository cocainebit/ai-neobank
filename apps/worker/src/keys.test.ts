import { describe, expect, it } from "vitest";
import { createPostgresStore, RotationStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { LocalKeyring, awsKmsClient, encryptSecret, evmAddressFromSpki, generateSigner, sealSecret } from "@ai-neobank/signer";
import { SoftKms, softKmsCommands } from "@ai-neobank/signer/testing";
import { deploySafeProtocolFixture, SafeGovernanceAdapter, type CompiledSafeTransaction } from "@ai-neobank/safe-adapter";
import { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { createWorker, rotateKeyEncryption } from "./worker.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createPublicClient, defineChain, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const evmTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const solanaTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && solanaRpc ? it : it.skip;
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
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""}`);
}

async function payNative(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, input: { organizationId: string; principalId: string; treasuryId: string; network: string; asset: string; amount: string; destination: string }) {
  const intentId = crypto.randomUUID();
  await store.createIntent({ id: intentId, idempotencyKey: `keys-${intentId}`, organizationId: input.organizationId, treasuryAccountId: input.treasuryId, requesterId: input.principalId, network: input.network, assetId: input.asset, amountBaseUnits: input.amount, destination: input.destination, purpose: "Key management test", expiresAt: new Date(Date.now() + 180_000).toISOString(), kind: "transfer" });
  await runtime.worker.drain();
  const detail = (await store.getIntent(input.organizationId, intentId))!;
  if (!detail.approval) throw new Error(`No approval request: ${detail.intent.status} ${detail.intent.failureReason}`);
  await store.decideIntent(input.organizationId, intentId, { principalId: input.principalId, decision: "approved", expectedIntentVersion: detail.intent.version, compiledHash: detail.approval.compiledHash!, simulationHash: detail.approval.simulationHash! });
  return intentId;
}

describe("KMS custody and key rotation on EVM", () => {
  evmTestIf("a KMS-held key signs a direct transfer and becomes a Safe's executor by rotation, without key material entering the worker", async () => {
    const store = createPostgresStore(databaseUrl!);
    const softKms = new SoftKms();
    const kms = awsKmsClient(softKms, softKmsCommands);
    const keyring = new LocalKeyring({ v1: new Uint8Array(32).fill(51) }, "v1");
    const ownerKeys = [generatePrivateKey(), generatePrivateKey()];
    const owners = ownerKeys.map((key) => privateKeyToAccount(key));
    await anvil("anvil_setBalance", [owners[0]!.address, "0x56bc75e2d63100000"]);
    const contracts = await deploySafeProtocolFixture(evmRpc!, 31337, ownerKeys[0]!);
    const runtime = createWorker(databaseUrl!, { keys: keyring, kms, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, safeContracts: contracts } });
    const publicClient = createPublicClient({ chain: defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } }), transport: http(evmRpc) });
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "evm", address: owners[0]!.address, displayName: "Owner", organizationName: "KMS", slug: `kms-${suffix}` });
      await store.addMember(owner.organizationId, { displayName: "Second", role: "approver", wallet: { chainFamily: "evm", address: owners[1]!.address } }, owner.principalId);
      const nativeAsset = `${evmNetwork}/slip44:60`;
      await store.ensureNativeAsset(evmNetwork, "evm");

      // Direct treasury whose key lives in KMS.
      const kmsKeyId = softKms.createSigningKey();
      const kmsAddress = evmAddressFromSpki(await kms.getPublicKey(kmsKeyId));
      await store.createKmsSigner(owner.organizationId, { chainFamily: "evm", address: kmsAddress, kmsKeyId }, owner.principalId);
      await anvil("anvil_setBalance", [kmsAddress, "0x8ac7230489e80000"]);
      const direct = await store.createTreasury(owner.organizationId, { name: "KMS account", chainFamily: "evm", network: evmNetwork, address: kmsAddress, governance: "direct" }, owner.principalId);
      const destination = privateKeyToAccount(generatePrivateKey()).address;
      const signsBefore = softKms.calls.filter((call) => call.command === "SignCommand").length;
      const first = await payNative(store, runtime, { organizationId: owner.organizationId, principalId: owner.principalId, treasuryId: direct.id, network: evmNetwork, asset: nativeAsset, amount: parseEther("1").toString(), destination });
      expect((await untilStatus(store, runtime, owner.organizationId, first, ["reconciled", "failed"])).status).toBe("reconciled");
      expect(await publicClient.getBalance({ address: destination as Address })).toBe(parseEther("1"));
      expect(softKms.calls.filter((call) => call.command === "SignCommand").length).toBeGreaterThan(signsBefore);

      // A Safe starts with a software executor; the owner rotates it to a KMS executor while nothing is in flight.
      const safe = new SafeGovernanceAdapter({ rpcUrl: evmRpc!, chainId: 31337, contracts });
      const deployment = await safe.deploy(ownerKeys[0]!, owners.map((account) => account.address), 2);
      await anvil("anvil_setBalance", [deployment.address, "0x4563918244f40000"]);
      const software = generateSigner("evm");
      const sealed = await sealSecret(software.secret, keyring);
      const softwareSigner = await store.createSigner(owner.organizationId, { chainFamily: "evm", address: software.address, encryptedSecret: sealed.ciphertext, encryptionNonce: sealed.nonce, authTag: sealed.authTag, dataKey: sealed.dataKey, dataKeyVersion: sealed.dataKeyVersion }, owner.principalId);
      const observed = await safe.observe(deployment.address);
      const safeTreasury = await store.createTreasury(owner.organizationId, { name: "Safe", chainFamily: "evm", network: evmNetwork, address: deployment.address, governance: "safe", executorSignerId: softwareSigner.id, observedConfiguration: { owners: observed.owners, threshold: observed.threshold } }, owner.principalId);
      const kmsExecutorKey = softKms.createSigningKey();
      const kmsExecutorAddress = evmAddressFromSpki(await kms.getPublicKey(kmsExecutorKey));
      const kmsExecutor = await store.createKmsSigner(owner.organizationId, { chainFamily: "evm", address: kmsExecutorAddress, kmsKeyId: kmsExecutorKey }, owner.principalId);
      await anvil("anvil_setBalance", [kmsExecutorAddress, "0x8ac7230489e80000"]);

      const rotations = new RotationStore(store.sql);
      // Refused while a payment is in flight.
      const inFlight = await payNative(store, runtime, { organizationId: owner.organizationId, principalId: owner.principalId, treasuryId: safeTreasury.id, network: evmNetwork, asset: nativeAsset, amount: "1000", destination }).catch(() => null);
      void inFlight;
      await expect(rotations.start(owner.organizationId, safeTreasury.id, kmsExecutor.id, owner.principalId)).rejects.toMatchObject({ code: "treasury_busy" });
      await store.sql`update intents set status = 'expired' where treasury_account_id = ${safeTreasury.id} and status not in ('reconciled', 'failed', 'rejected', 'expired')`;
      const rotation = await rotations.start(owner.organizationId, safeTreasury.id, kmsExecutor.id, owner.principalId);
      expect(rotation.status).toBe("completed");
      expect((await store.getTreasury(owner.organizationId, safeTreasury.id))?.executorSignerId).toBe(kmsExecutor.id);

      // The next Safe payment is executed by the KMS executor.
      const safePayment = crypto.randomUUID();
      await store.createIntent({ id: safePayment, idempotencyKey: `keys-${safePayment}`, organizationId: owner.organizationId, treasuryAccountId: safeTreasury.id, requesterId: owner.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("0.5").toString(), destination, purpose: "Safe payment via KMS executor", expiresAt: new Date(Date.now() + 180_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      const pending = (await store.getIntent(owner.organizationId, safePayment))!;
      const safeTx = (pending.approval!.externalRef as { safeTx: CompiledSafeTransaction }).safeTx;
      const members = await store.listMembers(owner.organizationId);
      for (const [index, key] of ownerKeys.entries()) {
        const signature = await safe.signTypedDataFor(deployment.address, safeTx, key);
        const principal = members.find((member) => member.wallets.some((wallet) => wallet.address.toLowerCase() === owners[index]!.address.toLowerCase()))!;
        await store.decideIntent(owner.organizationId, safePayment, { principalId: principal.id, decision: "approved", expectedIntentVersion: pending.intent.version, compiledHash: pending.approval!.compiledHash!, simulationHash: pending.approval!.simulationHash!, signedPayload: signature.signature, signerAddress: signature.owner });
      }
      expect((await untilStatus(store, runtime, owner.organizationId, safePayment, ["reconciled", "failed"])).status).toBe("reconciled");
      const execution = (await store.getIntent(owner.organizationId, safePayment))!.execution!;
      const transaction = await publicClient.getTransaction({ hash: execution.transactionHash as `0x${string}` });
      expect(transaction.from.toLowerCase()).toBe(kmsExecutorAddress.toLowerCase());
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 180_000);

  evmTestIf("rotating the key-encryption key re-wraps data keys and upgrades legacy envelopes; payments work with only the new key", async () => {
    const store = createPostgresStore(databaseUrl!);
    const oldKey = new Uint8Array(32).fill(61);
    const newKey = new Uint8Array(32).fill(62);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "evm", address: `0x${suffix.padEnd(40, "d")}`, displayName: "Owner", organizationName: "Rotation", slug: `rot-${suffix}` });
      await store.ensureNativeAsset(evmNetwork, "evm");
      // One legacy envelope (sealed directly under the old master key) and one format 2 envelope under the old keyring version.
      const legacy = generateSigner("evm");
      const legacyEnvelope = encryptSecret(legacy.secret, oldKey);
      await store.createSigner(owner.organizationId, { chainFamily: "evm", address: legacy.address, encryptedSecret: legacyEnvelope.ciphertext, encryptionNonce: legacyEnvelope.nonce, authTag: legacyEnvelope.authTag, keyVersion: 1 }, owner.principalId);
      const modern = generateSigner("evm");
      const modernEnvelope = await sealSecret(modern.secret, new LocalKeyring({ "1": oldKey }, "1"));
      await store.createSigner(owner.organizationId, { chainFamily: "evm", address: modern.address, encryptedSecret: modernEnvelope.ciphertext, encryptionNonce: modernEnvelope.nonce, authTag: modernEnvelope.authTag, dataKey: modernEnvelope.dataKey, dataKeyVersion: modernEnvelope.dataKeyVersion }, owner.principalId);

      const result = await rotateKeyEncryption(store, new LocalKeyring({ "1": oldKey, "2": newKey }, "2"), { organizationId: owner.organizationId });
      expect(result).toEqual({ rewrapped: 2, failed: [] });
      expect(await store.listSignersToRewrap("2", { organizationId: owner.organizationId })).toHaveLength(0);
      expect((await rotateKeyEncryption(store, new LocalKeyring({ "2": newKey }, "2"), { organizationId: owner.organizationId })).rewrapped).toBe(0);
      const signers = await store.listSigners(owner.organizationId);
      const modernRow = (await store.getSignerSecret(owner.organizationId, signers.find((signer) => signer.address === modern.address)!.id))!;
      expect(modernRow.encryptedSecret).toBe(modernEnvelope.ciphertext);
      expect(modernRow.dataKeyVersion).toBe("2");

      // The worker now holds only the new key; both signers still pay.
      const runtime = createWorker(databaseUrl!, { keys: new LocalKeyring({ "2": newKey }, "2"), evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork } });
      try {
        for (const signer of [legacy, modern]) {
          await anvil("anvil_setBalance", [signer.address, "0x8ac7230489e80000"]);
          const treasury = await store.createTreasury(owner.organizationId, { name: signer.address.slice(0, 10), chainFamily: "evm", network: evmNetwork, address: signer.address, governance: "direct" }, owner.principalId);
          const intentId = await payNative(store, runtime, { organizationId: owner.organizationId, principalId: owner.principalId, treasuryId: treasury.id, network: evmNetwork, asset: `${evmNetwork}/slip44:60`, amount: "1000", destination: privateKeyToAccount(generatePrivateKey()).address });
          expect((await untilStatus(store, runtime, owner.organizationId, intentId, ["reconciled", "failed"])).status).toBe("reconciled");
        }
      } finally {
        await runtime.close();
      }
    } finally {
      await store.close();
    }
  }, 120_000);
});

describe("Squads executor rotation", () => {
  solanaTestIf("the old executor proposes the member swap, members approve on chain, Relay switches executors and keeps paying", async () => {
    const store = createPostgresStore(databaseUrl!);
    const keyring = new LocalKeyring({ k1: new Uint8Array(32).fill(71) }, "k1");
    const runtime = createWorker(databaseUrl!, { keys: keyring, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "confirmed" } });
    try {
      const connection = new Connection(solanaRpc!, "confirmed");
      const airdrop = async (address: PublicKey, sol: number) => {
        const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
        await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      };
      const squads = new SquadsGovernanceAdapter(new SolanaAdapter({ rpcUrl: solanaRpc!, network: solNetwork, finality: "confirmed" }));
      const members = [Keypair.generate(), Keypair.generate()];
      const oldExecutor = generateSigner("svm");
      const newExecutor = generateSigner("svm");
      await Promise.all([airdrop(members[0]!.publicKey, 3), airdrop(members[1]!.publicKey, 2), airdrop(new PublicKey(oldExecutor.address), 2), airdrop(new PublicKey(newExecutor.address), 2)]);
      const created = await squads.create(members[0]!, [{ key: members[0]!.publicKey.toBase58(), role: "owner" }, { key: members[1]!.publicKey.toBase58(), role: "owner" }, { key: oldExecutor.address, role: "executor" }], 2);
      await airdrop(new PublicKey(created.vaultPda), 2);

      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "svm", address: members[0]!.publicKey.toBase58(), displayName: "Owner", organizationName: "Squads rotation", slug: `sqrot-${suffix}` });
      const seal = async (signer: ReturnType<typeof generateSigner>) => {
        const sealed = await sealSecret(signer.secret, keyring);
        return store.createSigner(owner.organizationId, { chainFamily: "svm", address: signer.address, encryptedSecret: sealed.ciphertext, encryptionNonce: sealed.nonce, authTag: sealed.authTag, dataKey: sealed.dataKey, dataKeyVersion: sealed.dataKeyVersion }, owner.principalId);
      };
      const oldRow = await seal(oldExecutor);
      const newRow = await seal(newExecutor);
      await store.ensureNativeAsset(solNetwork, "svm");
      const observed = await squads.observe(created.multisigPda);
      const treasury = await store.createTreasury(owner.organizationId, { name: "Vault", chainFamily: "svm", network: solNetwork, address: created.vaultPda, governance: "squads", executorSignerId: oldRow.id, observedConfiguration: { multisigPda: created.multisigPda, threshold: observed.threshold, members: observed.members } }, owner.principalId);

      const rotations = new RotationStore(store.sql);
      const rotation = await rotations.start(owner.organizationId, treasury.id, newRow.id, owner.principalId);
      expect(rotation.status).toBe("publishing");
      await expect(rotations.start(owner.organizationId, treasury.id, newRow.id, owner.principalId)).rejects.toMatchObject({ code: "rotation_in_progress" });
      await runtime.worker.drain();
      const published = (await rotations.get(owner.organizationId, rotation.id))!;
      expect(published.status).toBe("approval_required");
      const ref = published.externalRef as { multisigPda: string; transactionIndex: string };
      expect(await squads.configPublishedBy(ref.multisigPda, BigInt(ref.transactionIndex), oldExecutor.address)).toBe(true);

      for (const member of members) await squads.vote(ref.multisigPda, BigInt(ref.transactionIndex), member, "approved");
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await store.sql`update outbox_events set available_at = now() where aggregate_id = ${rotation.id} and processed_at is null`;
        await store.sql`update jobs set run_at = now() where status = 'retry' and payload->>'rotationId' = ${rotation.id}`;
        await runtime.worker.drain();
        if ((await rotations.get(owner.organizationId, rotation.id))!.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect((await rotations.get(owner.organizationId, rotation.id))!.status).toBe("completed");
      const after = await squads.observe(created.multisigPda);
      expect(after.members.map((member) => member.key)).toContain(newExecutor.address);
      expect(after.members.map((member) => member.key)).not.toContain(oldExecutor.address);
      expect(after.members.find((member) => member.key === newExecutor.address)).toMatchObject({ canVote: false, canExecute: true, canInitiate: true });
      expect((await store.getTreasury(owner.organizationId, treasury.id))?.executorSignerId).toBe(newRow.id);

      // A vault payment after rotation is proposed and executed by the new executor.
      const intentId = crypto.randomUUID();
      const destination = Keypair.generate().publicKey.toBase58();
      await store.createIntent({ id: intentId, idempotencyKey: `sqrot-${intentId}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: owner.principalId, network: solNetwork, assetId: `${solNetwork}/slip44:501`, amountBaseUnits: "1000000", destination, purpose: "After rotation", expiresAt: new Date(Date.now() + 180_000).toISOString(), kind: "transfer" });
      await untilStatus(store, runtime, owner.organizationId, intentId, ["approval_required", "failed", "rejected"]);
      const detail = (await store.getIntent(owner.organizationId, intentId))!;
      const intentRef = detail.approval!.externalRef as { multisigPda: string; transactionIndex: string };
      expect(await squads.publishedBy(intentRef.multisigPda, BigInt(intentRef.transactionIndex), newExecutor.address)).toBe(true);
      for (const member of members) await squads.vote(intentRef.multisigPda, BigInt(intentRef.transactionIndex), member, "approved");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await store.sql`update outbox_events set available_at = now() where aggregate_id = ${intentId} and processed_at is null`;
        await runtime.worker.drain();
        const status = (await store.getIntent(owner.organizationId, intentId))!.intent.status;
        if (["reconciled", "failed"].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect((await store.getIntent(owner.organizationId, intentId))!.intent.status).toBe("reconciled");
      expect(await connection.getBalance(new PublicKey(destination), "confirmed")).toBe(1_000_000);
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 240_000);
});
