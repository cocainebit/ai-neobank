import { describe, expect, it } from "vitest";
import { createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { tokenAssetId } from "@ai-neobank/domain";
import { solanaWireNetwork } from "@ai-neobank/x402-adapter";
import { createLocalFacilitator, startLocalSeller } from "@ai-neobank/x402-adapter/testing";
import { createWorker, type WorkerChainConfig, type WorkerHooks } from "./worker.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const evmTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const solanaTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && solanaRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(31);
const evmNetwork = "eip155:31337" as const;
const solNetwork = "solana:localnet" as const;
const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

async function workspace(store: PostgresControlPlaneStore, family: "evm" | "svm", network: string, assetId: string, maxPerTransaction: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: family, address: family === "evm" ? `0x${suffix.padEnd(40, "b")}` : Keypair.generate().publicKey.toBase58(), displayName: "Owner", organizationName: "x402", slug: `x402-${suffix}` });
  const agent = await store.createAgent(owner.organizationId, { displayName: "Research", purpose: "Buy data and inference" }, owner.principalId);
  const executor = generateSigner(family);
  const encrypted = encryptSecret(executor.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: family, address: executor.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(network, family);
  const treasury = await store.createTreasury(owner.organizationId, { name: "Agent account", chainFamily: family, network, address: executor.address, governance: "direct" }, owner.principalId);
  const policy = await store.createPolicy(owner.organizationId, { name: "Machine payments", definition: { frozen: false, maxPerTransactionBaseUnits: maxPerTransaction, maxDailyBaseUnits: String(BigInt(maxPerTransaction) * 10n), autoApproveUpToBaseUnits: "0", allowedNetworks: [network], allowedAssets: [assetId], allowedDestinations: [], allowedKinds: ["x402"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
  await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
  return { owner, agent, treasury, executor };
}

async function submit(store: PostgresControlPlaneStore, ws: Awaited<ReturnType<typeof workspace>>, input: { network: string; assetId: string; amount: string; url: string }) {
  const intentId = crypto.randomUUID();
  await store.createIntent({ id: intentId, idempotencyKey: `x402-${intentId}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: input.network, assetId: input.assetId, amountBaseUnits: input.amount, destination: input.url, purpose: "Buy the report", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "x402" });
  return intentId;
}

async function approve(store: PostgresControlPlaneStore, ws: Awaited<ReturnType<typeof workspace>>, intentId: string) {
  const detail = (await store.getIntent(ws.owner.organizationId, intentId))!;
  await store.decideIntent(ws.owner.organizationId, intentId, { principalId: ws.owner.principalId, decision: "approved", expectedIntentVersion: detail.intent.version, compiledHash: detail.approval!.compiledHash!, simulationHash: detail.approval!.simulationHash! });
}

async function untilStatus(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, organizationId: string, intentId: string, wanted: string[], attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    await runtime.worker.drain();
    const current = (await store.getIntent(organizationId, intentId))!.intent;
    if (wanted.includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = await store.getIntent(organizationId, intentId);
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""} ${JSON.stringify(detail?.execution)}`);
}

describe("x402 intents through the worker on EVM", () => {
  evmTestIf("quotes at intake, pays the quoted amount after approval, reconciles, and never pays twice across a crash", async () => {
    const store = createPostgresStore(databaseUrl!);
    const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const deployerKey = generatePrivateKey();
    const deployer = privateKeyToAccount(deployerKey);
    const facilitatorKey = generatePrivateKey();
    await Promise.all([anvil("anvil_setBalance", [deployer.address, "0x8ac7230489e80000"]), anvil("anvil_setBalance", [privateKeyToAccount(facilitatorKey).address, "0x8ac7230489e80000"])]);
    const wallet = createWalletClient({ account: deployer, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const token = (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: deployer }) })).contractAddress as Address;
    const assetId = tokenAssetId(evmNetwork, "erc20", token);
    await store.upsertAsset({ id: assetId, network: evmNetwork, chainFamily: "evm", kind: "erc20", address: token, symbol: "TUSD", decimals: 6 });
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const facilitator = await createLocalFacilitator({ evm: { rpcUrl: evmRpc!, chainId: 31337, privateKey: facilitatorKey } });
    const seller = await startLocalSeller(facilitator.client, [
      { route: "GET /report", network: evmNetwork, payTo: payee, asset: token, amount: "250000", extra: { name: "Test USD", version: "2" }, body: { report: "quarterly" } },
      { route: "GET /premium", network: evmNetwork, payTo: payee, asset: token, amount: "9000000", extra: { name: "Test USD", version: "2" }, body: { report: "premium" } }
    ], { evm: { rpcUrl: evmRpc! } });
    let crashes = 0;
    const hooks: WorkerHooks = { beforeBroadcast: async (context) => { if (context.kind === "x402" && crashes === 0) { crashes += 1; throw new Error("simulated crash after the payload was persisted"); } } };
    const runtime = createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork } }, hooks);
    try {
      const ws = await workspace(store, "evm", evmNetwork, assetId, "1000000");
      await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [ws.executor.address, 5_000_000n], account: deployer }) });
      await anvil("anvil_setBalance", [ws.executor.address, "0xde0b6b3a7640000"]);

      // Too expensive for the intent's cap: rejected at intake with the seller's terms in the reason.
      const expensive = await submit(store, ws, { network: evmNetwork, assetId, amount: "1000000", url: `${seller.url}/premium` });
      await runtime.worker.drain();
      const rejected = (await store.getIntent(ws.owner.organizationId, expensive))!.intent;
      expect(rejected.status).toBe("rejected");
      expect(rejected.failureReason).toContain("exceeds_max");

      // Quote captured as evidence; the approver signs over the quote hash, not the field hash.
      const intentId = await submit(store, ws, { network: evmNetwork, assetId, amount: "1000000", url: `${seller.url}/report` });
      await runtime.worker.drain();
      const pending = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(pending.intent.status).toBe("approval_required");
      const quote = (pending.intent.policyDecision as { x402: { requirements: { amount: string; payTo: string } } }).x402;
      expect(quote.requirements.amount).toBe("250000");
      expect(quote.requirements.payTo.toLowerCase()).toBe(payee.toLowerCase());
      await approve(store, ws, intentId);

      // First execution crashes after persisting the payload; the retry re-sends the same payload.
      await runtime.worker.drain();
      const crashed = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(crashed.execution?.status).toBe("signed");
      expect(crashed.execution?.transactionHash).toMatch(/^eip3009:0x/);
      await runtime.queue.sql`update jobs set run_at = now() where status = 'retry'`;
      const done = await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["reconciled", "failed"]);
      expect(done.status).toBe("reconciled");
      expect(crashes).toBe(1);
      const final = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(final.execution?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [payee] })).toBe(250_000n);
      // The ledger books the quoted price, not the intent's cap.
      const entries = (await store.listLedgerEntries(ws.owner.organizationId)).filter((entry) => entry.intentId === intentId && entry.accountCode === "settled_expense");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.amountBaseUnits).toBe("250000");
      expect((final.execution?.observed as { reconciliation: string }).reconciliation).toBe("matched");
    } finally {
      await seller.close();
      await runtime.close();
      await store.close();
    }
  }, 120_000);
});

describe("x402 intents through the worker on Solana", () => {
  solanaTestIf("quotes at intake, pays the quoted SPL amount after approval, and reconciles", async () => {
    const store = createPostgresStore(databaseUrl!);
    const connection = new Connection(solanaRpc!, "confirmed");
    const airdrop = async (address: PublicKey, sol: number) => {
      const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    };
    const mintAuthority = Keypair.generate();
    const facilitator = Keypair.generate();
    const payee = Keypair.generate();
    await Promise.all([airdrop(mintAuthority.publicKey, 5), airdrop(facilitator.publicKey, 5)]);
    const mint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
    await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, payee.publicKey);
    const assetId = tokenAssetId(solNetwork, "spl", mint.toBase58());
    await store.upsertAsset({ id: assetId, network: solNetwork, chainFamily: "svm", kind: "spl", address: mint.toBase58(), symbol: "TUSD", decimals: 6 });
    const wireNetwork = await solanaWireNetwork(solNetwork, solanaRpc!);
    const local = await createLocalFacilitator({ solana: { rpcUrl: solanaRpc!, wireNetwork, secretKey: facilitator.secretKey } });
    const seller = await startLocalSeller(local.client, [
      { route: "GET /inference", network: wireNetwork, payTo: payee.publicKey.toBase58(), asset: mint.toBase58(), amount: "125000", body: { tokens: 512 } }
    ], { solana: { rpcUrl: solanaRpc!, wireNetwork } });
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "finalized", x402Network: wireNetwork } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const ws = await workspace(store, "svm", solNetwork, assetId, "1000000");
      await airdrop(new PublicKey(ws.executor.address), 1);
      const executorAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, new PublicKey(ws.executor.address));
      await mintTo(connection, mintAuthority, mint, executorAta.address, mintAuthority, 5_000_000n);
      const intentId = await submit(store, ws, { network: solNetwork, assetId, amount: "1000000", url: `${seller.url}/inference` });
      await runtime.worker.drain();
      const pending = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect(pending.intent.status).toBe("approval_required");
      await approve(store, ws, intentId);
      const done = await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["reconciled", "failed"], 120);
      expect(done.status).toBe("reconciled");
      const payeeAta = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, payee.publicKey);
      expect((await connection.getTokenAccountBalance(payeeAta.address, "finalized")).value.amount).toBe("125000");
      const final = (await store.getIntent(ws.owner.organizationId, intentId))!;
      expect((final.execution?.observed as { reconciliation: string }).reconciliation).toBe("matched");
    } finally {
      await seller.close();
      await runtime.close();
      await store.close();
    }
  }, 180_000);
});
