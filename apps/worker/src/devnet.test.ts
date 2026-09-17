import { describe, expect, it, type TestContext } from "vitest";
import { createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import { SquadsGovernanceAdapter } from "@ai-neobank/squads-adapter";
import { solanaWireNetwork } from "@ai-neobank/x402-adapter";
import { createLocalFacilitator, startLocalSeller } from "@ai-neobank/x402-adapter/testing";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { tokenAssetId } from "@ai-neobank/domain";
import { createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWorker, type WorkerChainConfig } from "./worker.js";

/**
 * The same pipeline against public test networks, with real finality and real
 * fees. Opt in with RUN_DEVNET=1. Solana devnet funds itself from the cluster
 * faucet; Base Sepolia needs a funded key in DEVNET_EVM_KEY because its faucets
 * are gated.
 */
const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DEVNET === "1" && Boolean(databaseUrl);
const devnet = enabled ? it : it.skip;
const devnetEvm = enabled && evmKeyPresent() ? it : it.skip;
function evmKeyPresent() { return Boolean(process.env.DEVNET_EVM_KEY); }
const solanaRpc = process.env.DEVNET_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const evmRpc = process.env.DEVNET_EVM_RPC_URL ?? "https://sepolia.base.org";
const evmKey = process.env.DEVNET_EVM_KEY as Hex | undefined;
const solanaKey = process.env.DEVNET_SOLANA_KEY;
const masterKey = new Uint8Array(32).fill(23);
const solNetwork = "solana:devnet" as const;
const evmNetwork = "eip155:84532" as const;

async function workspace(store: PostgresControlPlaneStore, family: "evm" | "svm", network: string, assetId: string, secret?: Uint8Array, kinds: ("transfer" | "x402")[] = ["transfer"], cap = "1000000000000000000") {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: family, address: family === "evm" ? `0x${suffix.padEnd(40, "c")}` : Keypair.generate().publicKey.toBase58(), displayName: "Owner", organizationName: "Devnet", slug: `devnet-${suffix}` });
  const agent = await store.createAgent(owner.organizationId, { displayName: "Devnet agent", purpose: "Devnet certification" }, owner.principalId);
  const generated = secret ? { address: family === "evm" ? privateKeyToAccount(`0x${Buffer.from(secret).toString("hex")}` as Hex).address : Keypair.fromSecretKey(secret).publicKey.toBase58(), secret } : generateSigner(family);
  const encrypted = encryptSecret(generated.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(network, family);
  const treasury = await store.createTreasury(owner.organizationId, { name: "Devnet treasury", chainFamily: family, network, address: generated.address, governance: "direct" }, owner.principalId);
  const policy = await store.createPolicy(owner.organizationId, { name: "Devnet", definition: { frozen: false, maxPerTransactionBaseUnits: cap, maxDailyBaseUnits: (BigInt(cap) * 2n).toString(), autoApproveUpToBaseUnits: "0", allowedNetworks: [network], allowedAssets: [assetId], allowedDestinations: [], allowedKinds: kinds, humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
  await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
  return { owner, agent, treasury, signer: generated };
}

async function settle(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, ws: Awaited<ReturnType<typeof workspace>>, input: { network: string; assetId: string; amount: string; destination: string }, attempts = 180) {
  const intentId = crypto.randomUUID();
  await store.createIntent({ id: intentId, idempotencyKey: `d-${crypto.randomUUID()}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: input.network, assetId: input.assetId, amountBaseUnits: input.amount, destination: input.destination, purpose: "Devnet certification", expiresAt: new Date(Date.now() + 900_000).toISOString(), kind: "transfer" });
  await runtime.worker.drain();
  const request = await store.getApprovalRequest(ws.owner.organizationId, intentId);
  const detail = await store.getIntent(ws.owner.organizationId, intentId);
  if (!request?.compiledHash || !request.simulationHash) throw new Error(`No approval request: ${detail?.intent.status} ${detail?.intent.failureReason ?? ""}`);
  await store.decideIntent(ws.owner.organizationId, intentId, { principalId: ws.owner.principalId, decision: "approved", expectedIntentVersion: 2, compiledHash: request.compiledHash, simulationHash: request.simulationHash });
  for (let index = 0; index < attempts; index += 1) {
    await runtime.worker.drain();
    const current = (await store.getIntent(ws.owner.organizationId, intentId))!;
    if (["reconciled", "failed", "rejected"].includes(current.intent.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const stuck = await store.getIntent(ws.owner.organizationId, intentId);
  throw new Error(`Intent stuck in ${stuck?.intent.status}: ${JSON.stringify(stuck?.execution)}`);
}

/** The funded devnet key pays for everything these runs need. */
function devnetPayer(): Keypair {
  if (!solanaKey) throw new Error("Set DEVNET_SOLANA_KEY to the funded devnet keypair");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaKey) as number[]));
}

async function fund(connection: Connection, payer: Keypair, targets: { to: PublicKey; sol: number }[]) {
  const transaction = new Transaction();
  for (const target of targets) transaction.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: target.to, lamports: Math.round(target.sol * LAMPORTS_PER_SOL) }));
  await sendAndConfirmTransaction(connection, transaction, [payer], { commitment: "confirmed" });
}

describe("public devnets", () => {
  devnet("settles a SOL transfer on Solana devnet at finalized commitment", async (context: TestContext) => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc, network: solNetwork, finality: "finalized" } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const assetId = `${solNetwork}/slip44:501`;
      // A key from the environment keeps one faucet top-up usable across runs.
      const ws = await workspace(store, "svm", solNetwork, assetId, solanaKey ? Uint8Array.from(JSON.parse(solanaKey) as number[]) : undefined);
      const connection = new Connection(solanaRpc, "confirmed");
      const treasury = new PublicKey(ws.treasury.address);
      let balance = await connection.getBalance(treasury);
      if (balance < 0.05 * LAMPORTS_PER_SOL) {
        const signature = await connection.requestAirdrop(treasury, LAMPORTS_PER_SOL).catch(() => null);
        if (!signature) {
          // The cluster faucet is rate limited per address and per source; funding is a manual step, not a product failure.
          context.skip(`Fund ${ws.treasury.address} with about 0.1 devnet SOL (https://faucet.solana.com) and run again`);
          return;
        }
        await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
        balance = await connection.getBalance(treasury);
      }
      expect(balance).toBeGreaterThan(0.02 * LAMPORTS_PER_SOL);

      const destination = Keypair.generate().publicKey;
      const amount = String(0.01 * LAMPORTS_PER_SOL);
      const settled = await settle(store, runtime, ws, { network: solNetwork, assetId, amount, destination: destination.toBase58() });
      expect(settled.intent.status).toBe("reconciled");
      expect(settled.execution?.transactionHash).toBeTruthy();
      expect(await connection.getBalance(destination, "finalized")).toBe(Number(amount));
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 900_000);

  devnetEvm("settles an ETH transfer on Base Sepolia at the configured confirmation depth", async (context: TestContext) => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc, chainId: 84532, network: evmNetwork, confirmations: 2 } };
    const runtime = createWorker(databaseUrl!, chain);
    const client = createPublicClient({ transport: http(evmRpc) });
    try {
      const assetId = `${evmNetwork}/slip44:60`;
      const secret = Uint8Array.from(Buffer.from(evmKey!.replace(/^0x/, ""), "hex"));
      const ws = await workspace(store, "evm", evmNetwork, assetId, secret);
      const balance = await client.getBalance({ address: ws.treasury.address as Address });
      if (balance < parseEther("0.002")) {
        context.skip(`Fund ${ws.treasury.address} with a little Base Sepolia ETH and run again (it holds ${balance} wei)`);
        return;
      }

      const destination = generateSigner("evm").address as Address;
      const amount = parseEther("0.0005").toString();
      const settled = await settle(store, runtime, ws, { network: evmNetwork, assetId, amount, destination });
      expect(settled.intent.status).toBe("reconciled");
      expect(await client.getBalance({ address: destination })).toBe(BigInt(amount));
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 900_000);

  devnet("runs a Squads vault payment on devnet: executor publishes, the member votes on chain, the executor executes", async (context) => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc, network: solNetwork, finality: "finalized" } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const connection = new Connection(solanaRpc, "confirmed");
      const payer = devnetPayer();
      const funds = await connection.getBalance(payer.publicKey);
      if (funds < 0.05 * LAMPORTS_PER_SOL) {
        context.skip(`Fund ${payer.publicKey.toBase58()} with about 0.05 devnet SOL and run again (it holds ${funds / LAMPORTS_PER_SOL})`);
        return;
      }
      const adapter = new SolanaAdapter({ rpcUrl: solanaRpc, network: solNetwork, finality: "confirmed" });
      const squads = new SquadsGovernanceAdapter(adapter);
      const member = Keypair.generate();
      const executor = generateSigner("svm");
      const encrypted = encryptSecret(executor.secret, masterKey);
      await fund(connection, payer, [{ to: member.publicKey, sol: 0.02 }, { to: new PublicKey(executor.address), sol: 0.015 }]);

      const created = await squads.create(member, [
        { key: member.publicKey.toBase58(), role: "owner" },
        { key: executor.address, role: "executor" }
      ], 1);
      await fund(connection, payer, [{ to: new PublicKey(created.vaultPda), sol: 0.005 }]);

      const suffix = crypto.randomUUID().slice(0, 8);
      const owner = await store.bootstrapOwner({ chainFamily: "svm", address: member.publicKey.toBase58(), displayName: "Owner", organizationName: "Devnet Squads", slug: `devnet-squads-${suffix}` });
      const agent = await store.createAgent(owner.organizationId, { displayName: "Payables", purpose: "Devnet vault payments" }, owner.principalId);
      const executorSigner = await store.createSigner(owner.organizationId, { chainFamily: "svm", address: executor.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
      const assetId = `${solNetwork}/slip44:501`;
      await store.ensureNativeAsset(solNetwork, "svm");
      const observed = await squads.observe(created.multisigPda);
      const treasury = await store.createTreasury(owner.organizationId, { name: "Devnet vault", chainFamily: "svm", network: solNetwork, address: created.vaultPda, governance: "squads", executorSignerId: executorSigner.id, observedConfiguration: { multisigPda: created.multisigPda, threshold: observed.threshold, members: observed.members } }, owner.principalId);
      const policy = await store.createPolicy(owner.organizationId, { name: "Vault", definition: { frozen: false, maxPerTransactionBaseUnits: String(0.01 * LAMPORTS_PER_SOL), maxDailyBaseUnits: String(0.02 * LAMPORTS_PER_SOL), autoApproveUpToBaseUnits: "0", allowedNetworks: [solNetwork], allowedAssets: [assetId], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
      await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);

      const destination = Keypair.generate().publicKey;
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `devnet-squads-${intentId}`, organizationId: owner.organizationId, treasuryAccountId: treasury.id, requesterId: agent.principalId, network: solNetwork, assetId, amountBaseUnits: "1000000", destination: destination.toBase58(), purpose: "Devnet Squads payment", expiresAt: new Date(Date.now() + 900_000).toISOString(), kind: "transfer" });
      for (let index = 0; index < 60; index += 1) {
        await runtime.worker.drain();
        if ((await store.getIntent(owner.organizationId, intentId))!.intent.status === "approval_required") break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const published = (await store.getIntent(owner.organizationId, intentId))!;
      expect(published.intent.status).toBe("approval_required");
      const ref = published.approval!.externalRef as { kind: string; multisigPda: string; transactionIndex: string };
      expect(ref.kind).toBe("squads");
      expect(await squads.publishedBy(ref.multisigPda, BigInt(ref.transactionIndex), executor.address)).toBe(true);

      await squads.vote(ref.multisigPda, BigInt(ref.transactionIndex), member, "approved");
      for (let index = 0; index < 180; index += 1) {
        await runtime.worker.drain();
        const current = (await store.getIntent(owner.organizationId, intentId))!.intent;
        if (["reconciled", "failed", "rejected"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const done = (await store.getIntent(owner.organizationId, intentId))!;
      expect(done.intent.status).toBe("reconciled");
      expect(await connection.getBalance(destination, "finalized")).toBe(1_000_000);
      expect((await squads.observeProposal(ref.multisigPda, BigInt(ref.transactionIndex)))?.status).toBe("executed");
      console.log("devnet squads vault", created.vaultPda, "transaction", done.execution?.transactionHash);
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 900_000);

  devnet("pays an x402 resource on devnet with a payer-signed SPL transfer settled by a facilitator", async (context) => {
    const store = createPostgresStore(databaseUrl!);
    const connection = new Connection(solanaRpc, "confirmed");
    const payer = devnetPayer();
    const funds = await connection.getBalance(payer.publicKey);
    if (funds < 0.03 * LAMPORTS_PER_SOL) {
      context.skip(`Fund ${payer.publicKey.toBase58()} with about 0.03 devnet SOL and run again (it holds ${funds / LAMPORTS_PER_SOL})`);
      await store.close();
      return;
    }
    const facilitatorKey = Keypair.generate();
    const payee = Keypair.generate();
    await fund(connection, payer, [{ to: facilitatorKey.publicKey, sol: 0.01 }]);
    // Relay's own test dollar on devnet: the seller prices in it and the facilitator settles it.
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    await getOrCreateAssociatedTokenAccount(connection, payer, mint, payee.publicKey);
    const assetId = tokenAssetId(solNetwork, "spl", mint.toBase58());
    await store.upsertAsset({ id: assetId, network: solNetwork, chainFamily: "svm", kind: "spl", address: mint.toBase58(), symbol: "TUSD", decimals: 6 });
    const wireNetwork = await solanaWireNetwork(solNetwork, solanaRpc);
    const local = await createLocalFacilitator({ solana: { rpcUrl: solanaRpc, wireNetwork, secretKey: facilitatorKey.secretKey } });
    const seller = await startLocalSeller(local.client, [
      { route: "GET /inference", network: wireNetwork, payTo: payee.publicKey.toBase58(), asset: mint.toBase58(), amount: "125000", body: { tokens: 512 } }
    ], { solana: { rpcUrl: solanaRpc, wireNetwork } });
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc, network: solNetwork, finality: "finalized", x402Network: wireNetwork } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const ws = await workspace(store, "svm", solNetwork, assetId, undefined, ["x402"], "1000000");
      const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, new PublicKey(ws.treasury.address));
      await mintTo(connection, payer, mint, treasuryAta.address, payer, 1_000_000n);

      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `devnet-x402-${intentId}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: solNetwork, assetId, amountBaseUnits: "200000", destination: `${seller.url}/inference`, purpose: "Devnet x402 purchase", expiresAt: new Date(Date.now() + 900_000).toISOString(), kind: "x402" });
      await runtime.worker.drain();
      const quoted = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(quoted.intent.status).toBe("approval_required");
      expect(quoted.intent.policyDecision).toMatchObject({ x402: { requirements: { amount: "125000" } } });

      const request = await store.getApprovalRequest(ws.owner.organizationId, intentId);
      await store.decideIntent(ws.owner.organizationId, intentId, { principalId: ws.owner.principalId, decision: "approved", expectedIntentVersion: 2, compiledHash: request!.compiledHash!, simulationHash: request!.simulationHash! });
      for (let index = 0; index < 180; index += 1) {
        await runtime.worker.drain();
        const current = (await store.getIntent(ws.owner.organizationId, intentId))!.intent;
        if (["reconciled", "failed", "rejected"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const done = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(done.intent.status).toBe("reconciled");
      const payeeAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payee.publicKey);
      expect((await connection.getTokenAccountBalance(payeeAta.address, "finalized")).value.amount).toBe("125000");
      console.log("devnet x402 mint", mint.toBase58(), "settlement", done.execution?.transactionHash);
    } finally {
      await seller.close();
      await runtime.close();
      await store.close();
    }
  }, 900_000);
});