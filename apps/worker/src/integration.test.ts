import { describe, expect, it } from "vitest";
import { createPostgresJobQueue, createPostgresStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { tokenAssetId } from "@ai-neobank/domain";
import { createWorker, type WorkerChainConfig, type WorkerHooks } from "./worker.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const evmTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const solanaTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && solanaRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(11);
const evmNetwork = "eip155:31337" as const;
const solNetwork = "solana:localnet" as const;

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

/** One organisation with an owner, an agent with a permissive policy, and a direct treasury whose key the worker holds. */
async function workspace(store: PostgresControlPlaneStore, family: "evm" | "svm", network: string, allowedAssets: string[]) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: family, address: family === "evm" ? `0x${suffix.padEnd(40, "a")}` : Keypair.generate().publicKey.toBase58(), displayName: "Owner", organizationName: "Worker", slug: `worker-${suffix}` });
  const agent = await store.createAgent(owner.organizationId, { displayName: "Executor", purpose: "Integration transfers" }, owner.principalId);
  const generated = generateSigner(family);
  const encrypted = encryptSecret(generated.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(network, family);
  const treasury = await store.createTreasury(owner.organizationId, { name: "Direct", chainFamily: family, network, address: generated.address, governance: "direct" }, owner.principalId);
  const policy = await store.createPolicy(owner.organizationId, { name: "Permissive", definition: { frozen: false, maxPerTransactionBaseUnits: "100000000000000000000", maxDailyBaseUnits: "1000000000000000000000", autoApproveUpToBaseUnits: "0", allowedNetworks: [network], allowedAssets, allowedDestinations: [], allowedKinds: ["transfer"], humanApprovalRequired: true, minApprovals: 1 }, createdBy: owner.principalId });
  await store.bindPolicy(owner.organizationId, { policyId: policy.id, agentId: agent.id }, owner.principalId);
  return { owner, agent, treasury, signer: generated };
}

async function submitAndApprove(store: PostgresControlPlaneStore, runtime: ReturnType<typeof createWorker>, ws: Awaited<ReturnType<typeof workspace>>, input: { assetId: string; amount: string; destination: string; network: string }) {
  const intentId = crypto.randomUUID();
  await store.createIntent({ id: intentId, idempotencyKey: `w-${crypto.randomUUID()}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: input.network, assetId: input.assetId, amountBaseUnits: input.amount, destination: input.destination, purpose: "Worker integration", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
  await runtime.worker.drain();
  const request = await store.getApprovalRequest(ws.owner.organizationId, intentId);
  if (!request?.compiledHash || !request.simulationHash) throw new Error(`No approval request: ${JSON.stringify((await store.getIntent(ws.owner.organizationId, intentId))?.intent)}`);
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
  throw new Error(`Intent stuck in ${detail?.intent.status}: ${detail?.intent.failureReason ?? ""} ${JSON.stringify(detail?.execution)}`);
}

describe("direct EVM execution through the worker", () => {
  evmTestIf("evaluates with a real simulation, executes, finalizes, ledgers fees, and reconciles native and ERC-20 transfers", async () => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, confirmations: 1 } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestToken.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
      const viemChain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
      const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // Anvil's default funded account
      const wallet = createWalletClient({ account: deployer, chain: viemChain, transport: http(evmRpc) });
      const publicClient = createPublicClient({ chain: viemChain, transport: http(evmRpc) });
      const deployHash = await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: deployer });
      const token = (await publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address;
      const tokenAsset = tokenAssetId(evmNetwork, "erc20", token);
      const nativeAsset = `${evmNetwork}/slip44:60`;

      const ws = await workspace(store, "evm", evmNetwork, [nativeAsset, tokenAsset]);
      await store.upsertAsset({ id: tokenAsset, network: evmNetwork, chainFamily: "evm", kind: "erc20", address: token, symbol: "TUSD", decimals: 6 });
      await anvil("anvil_setBalance", [ws.signer.address, "0x8ac7230489e80000"]);
      const mintHash = await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [ws.signer.address, 5_000_000n], account: deployer });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
      const destination = generateSigner("evm").address;

      // Insufficient balance is rejected at intake by the real simulation, before any approval exists.
      const tooMuch = crypto.randomUUID();
      await store.createIntent({ id: tooMuch, idempotencyKey: `w-${tooMuch}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("11").toString(), destination, purpose: "Too much", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      const rejected = (await store.getIntent(ws.owner.organizationId, tooMuch))!.intent;
      expect(rejected.status).toBe("rejected");
      expect(rejected.failureReason).toMatch(/[Ii]nsufficient/);

      // Native transfer end to end.
      const native = await submitAndApprove(store, runtime, ws, { assetId: nativeAsset, amount: parseEther("1").toString(), destination, network: evmNetwork });
      const done = await untilStatus(store, runtime, ws.owner.organizationId, native, ["reconciled", "failed"]);
      expect(done.status).toBe("reconciled");
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));
      const detail = (await store.getIntent(ws.owner.organizationId, native))!;
      expect(detail.execution?.status).toBe("finalized");
      expect(BigInt(detail.execution?.feeBaseUnits ?? "0")).toBeGreaterThan(0n);
      expect(detail.events.map((event) => event.eventType)).toEqual(["intent.received", "intent.approval_required", "intent.approved", "intent.executing", "intent.submitted", "intent.finalized", "intent.reconciled"]);
      const entries = await store.listLedgerEntries(ws.owner.organizationId);
      const codes = entries.filter((entry) => entry.intentId === native).map((entry) => `${entry.accountCode}:${entry.direction}`).sort();
      expect(codes).toEqual(["fee_expense:debit", "pending_outbound:credit", "pending_outbound:debit", "settled_expense:debit", "treasury_asset:credit", "treasury_asset:credit"]);
      const balances = await store.listLedgerBalances(ws.owner.organizationId);
      const pending = balances.find((balance) => balance.accountCode === "pending_outbound" && balance.assetId === nativeAsset);
      expect(BigInt(pending!.debits) - BigInt(pending!.credits)).toBe(0n);

      // ERC-20 transfer end to end.
      const erc20 = await submitAndApprove(store, runtime, ws, { assetId: tokenAsset, amount: "1250000", destination, network: evmNetwork });
      expect((await untilStatus(store, runtime, ws.owner.organizationId, erc20, ["reconciled", "failed"])).status).toBe("reconciled");
      const tokenBalance = await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [destination] }) as bigint;
      expect(tokenBalance).toBe(1_250_000n);
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 120_000);

  evmTestIf("recovers a transfer signed before a crash: never-sent is resent, already-sent is not sent twice", async () => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, confirmations: 1 } };
    let crashes = 0;
    let broadcastBeforeCrash = false;
    const hooks: WorkerHooks = {
      beforeBroadcast: async (context, signed) => {
        if (crashes >= 1) return;
        crashes += 1;
        if (broadcastBeforeCrash) {
          // The bytes reached the network but the worker died before recording it.
          await anvil("eth_sendRawTransaction", [signed.raw]);
        }
        throw new Error(`simulated crash after signing ${context.intentId}`);
      }
    };
    const crashing = createWorker(databaseUrl!, chain, hooks);
    try {
      const nativeAsset = `${evmNetwork}/slip44:60`;
      const ws = await workspace(store, "evm", evmNetwork, [nativeAsset]);
      await anvil("anvil_setBalance", [ws.signer.address, "0x8ac7230489e80000"]);
      const destination = generateSigner("evm").address;

      // Case 1: crash before the bytes left the process. Recovery finds nothing on chain and resends the same signed transaction.
      const first = await submitAndApprove(store, crashing, ws, { assetId: nativeAsset, amount: parseEther("1").toString(), destination, network: evmNetwork });
      await crashing.worker.drain();
      const afterCrash = (await store.getIntent(ws.owner.organizationId, first))!;
      expect(afterCrash.intent.status).toBe("executing");
      expect(afterCrash.execution?.status).toBe("signed");
      const signedHash = afterCrash.execution?.transactionHash;
      expect(signedHash).toMatch(/^0x[0-9a-f]{64}$/);
      const retryJobs = await crashing.queue.listJobs({ status: "retry" });
      expect(retryJobs.some((job) => job.type === "transaction.execute" && job.payload.intentId === first)).toBe(true);
      await crashing.queue.sql`update jobs set run_at = now() where status = 'retry'`;
      const recovered = await untilStatus(store, crashing, ws.owner.organizationId, first, ["reconciled", "failed"]);
      expect(recovered.status).toBe("reconciled");
      expect((await store.getIntent(ws.owner.organizationId, first))!.execution?.transactionHash).toBe(signedHash);
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));

      // Case 2: crash after the bytes were broadcast. Recovery sees the transaction and must not send again.
      crashes = 0;
      broadcastBeforeCrash = true;
      const second = await submitAndApprove(store, crashing, ws, { assetId: nativeAsset, amount: parseEther("1").toString(), destination, network: evmNetwork });
      await crashing.worker.drain();
      expect((await store.getIntent(ws.owner.organizationId, second))!.execution?.status).toBe("signed");
      await crashing.queue.sql`update jobs set run_at = now() where status = 'retry'`;
      expect((await untilStatus(store, crashing, ws.owner.organizationId, second, ["reconciled", "failed"])).status).toBe("reconciled");
      expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("2"));
      expect(await anvil("eth_getTransactionCount", [ws.signer.address, "latest"])).toBe("0x2");
    } finally {
      await crashing.close();
      await store.close();
    }
  }, 120_000);
});

describe("direct Solana execution through the worker", () => {
  solanaTestIf("executes, reaches finalized commitment, ledgers fees, and reconciles SOL and SPL transfers", async () => {
    const store = createPostgresStore(databaseUrl!);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "finalized" } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const connection = new Connection(solanaRpc!, "confirmed");
      const nativeAsset = `${solNetwork}/slip44:501`;
      const payer = Keypair.generate();
      const airdrop = await connection.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature: airdrop, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      const mint = await createMint(connection, payer, payer.publicKey, null, 6);
      const tokenAsset = tokenAssetId(solNetwork, "spl", mint.toBase58());

      const ws = await workspace(store, "svm", solNetwork, [nativeAsset, tokenAsset]);
      await store.upsertAsset({ id: tokenAsset, network: solNetwork, chainFamily: "svm", kind: "spl", address: mint.toBase58(), symbol: "TUSD", decimals: 6 });
      const treasuryKey = new PublicKey(ws.signer.address);
      const fund = await connection.requestAirdrop(treasuryKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature: fund, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, treasuryKey);
      await mintTo(connection, payer, mint, treasuryAta.address, payer, 5_000_000n);
      const destination = Keypair.generate().publicKey.toBase58();

      const native = await submitAndApprove(store, runtime, ws, { assetId: nativeAsset, amount: "1000000", destination, network: solNetwork });
      expect((await untilStatus(store, runtime, ws.owner.organizationId, native, ["reconciled", "failed"])).status).toBe("reconciled");
      expect(await connection.getBalance(new PublicKey(destination), "finalized")).toBe(1_000_000);
      const detail = (await store.getIntent(ws.owner.organizationId, native))!;
      expect(BigInt(detail.execution?.feeBaseUnits ?? "0")).toBeGreaterThan(0n);

      const spl = await submitAndApprove(store, runtime, ws, { assetId: tokenAsset, amount: "1250000", destination, network: solNetwork });
      expect((await untilStatus(store, runtime, ws.owner.organizationId, spl, ["reconciled", "failed"])).status).toBe("reconciled");
      const destinationAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, new PublicKey(destination));
      expect((await connection.getTokenAccountBalance(destinationAta.address, "finalized")).value.amount).toBe("1250000");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 180_000);
});
