import { describe, expect, it, type TestContext } from "vitest";
import { createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
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

async function workspace(store: PostgresControlPlaneStore, family: "evm" | "svm", network: string, assetId: string, secret?: Uint8Array) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: family, address: family === "evm" ? `0x${suffix.padEnd(40, "c")}` : Keypair.generate().publicKey.toBase58(), displayName: "Owner", organizationName: "Devnet", slug: `devnet-${suffix}` });
  const agent = await store.createAgent(owner.organizationId, { displayName: "Devnet agent", purpose: "Devnet certification" }, owner.principalId);
  const generated = secret ? { address: family === "evm" ? privateKeyToAccount(`0x${Buffer.from(secret).toString("hex")}` as Hex).address : Keypair.fromSecretKey(secret).publicKey.toBase58(), secret } : generateSigner(family);
  const encrypted = encryptSecret(generated.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(network, family);
  const treasury = await store.createTreasury(owner.organizationId, { name: "Devnet treasury", chainFamily: family, network, address: generated.address, governance: "direct" }, owner.principalId);
  const policy = await store.createPolicy(owner.organizationId, { name: "Devnet", definition: { frozen: false, maxPerTransactionBaseUnits: "1000000000000000000", maxDailyBaseUnits: "2000000000000000000", autoApproveUpToBaseUnits: "0", allowedNetworks: [network], allowedAssets: [assetId], allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
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
});
