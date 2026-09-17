import { describe, expect, it } from "vitest";
import { createPostgresStore, OperationsStore, type PostgresControlPlaneStore } from "@ai-neobank/database";
import { encryptSecret, generateSigner } from "@ai-neobank/signer";
import { tokenAssetId } from "@ai-neobank/domain";
import { createWorker, type WorkerChainConfig } from "./worker.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, createTransferCheckedInstruction, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const solanaRpc = process.env.SOLANA_RPC_URL;
const evmTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && evmRpc ? it : it.skip;
const solanaTestIf = process.env.RUN_WORKER_INTEGRATION === "1" && databaseUrl && solanaRpc ? it : it.skip;
const masterKey = new Uint8Array(32).fill(41);
const evmNetwork = "eip155:31337" as const;
const solNetwork = "solana:localnet" as const;
const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestToken.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

async function directWorkspace(store: PostgresControlPlaneStore, family: "evm" | "svm", network: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await store.bootstrapOwner({ chainFamily: family, address: family === "evm" ? `0x${suffix.padEnd(40, "c")}` : Keypair.generate().publicKey.toBase58(), displayName: "Owner", organizationName: "Receivables", slug: `recv-${suffix}` });
  const signer = generateSigner(family);
  const encrypted = encryptSecret(signer.secret, masterKey);
  await store.createSigner(owner.organizationId, { chainFamily: family, address: signer.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, owner.principalId);
  await store.ensureNativeAsset(network, family);
  const treasury = await store.createTreasury(owner.organizationId, { name: "Operating", chainFamily: family, network, address: signer.address, governance: "direct" }, owner.principalId);
  return { owner, treasury, signer };
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

async function approve(store: PostgresControlPlaneStore, organizationId: string, principalId: string, intentId: string) {
  const detail = (await store.getIntent(organizationId, intentId))!;
  if (!detail.approval) throw new Error(`No approval request: ${detail.intent.status} ${detail.intent.failureReason}`);
  await store.decideIntent(organizationId, intentId, { principalId, decision: "approved", expectedIntentVersion: detail.intent.version, compiledHash: detail.approval.compiledHash!, simulationHash: detail.approval.simulationHash! });
}

describe("receivables, reconciliation, and statements on EVM", () => {
  evmTestIf("opens balances, matches invoices by unique amount, books receipts and costs, reconciles, and produces a statement", async () => {
    const store = createPostgresStore(databaseUrl!);
    const operations = new OperationsStore(store.sql);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, confirmations: 1 } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const viemChain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
      const customerKey = generatePrivateKey();
      const customer = privateKeyToAccount(customerKey);
      await anvil("anvil_setBalance", [customer.address, "0x56bc75e2d63100000"]);
      const wallet = createWalletClient({ account: customer, chain: viemChain, transport: http(evmRpc) });
      const publicClient = createPublicClient({ chain: viemChain, transport: http(evmRpc) });
      const token = (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: customer }) })).contractAddress as Address;
      await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [customer.address, 1_000_000_000n], account: customer }) });
      const tokenAsset = tokenAssetId(evmNetwork, "erc20", token);
      await store.upsertAsset({ id: tokenAsset, network: evmNetwork, chainFamily: "evm", kind: "erc20", address: token, symbol: "TUSD", decimals: 6 });
      const nativeAsset = `${evmNetwork}/slip44:60`;

      const ws = await directWorkspace(store, "evm", evmNetwork);
      const periodStart = new Date(Date.now() - 1_000).toISOString();
      await anvil("anvil_setBalance", [ws.signer.address, "0x29a2241af62c0000"]); // 3 ETH before Relay has looked

      // First sync books the chain balance as the opening balance for every registered asset.
      const opened = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(opened.assets.find((asset) => asset.assetId === nativeAsset)).toMatchObject({ opened: true, reconciliation: "matched" });
      expect(opened.assets.find((asset) => asset.assetId === tokenAsset)).toMatchObject({ opened: true, reconciliation: "matched" });

      // EVM invoices carry a sub-cent identifier in the amount.
      const invoice = await operations.createInvoice(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, customerName: "Northwind", lineItems: [{ description: "Design sprint", quantity: 2, unitAmountBaseUnits: "50000000" }], issue: true }, ws.owner.principalId);
      expect(invoice.status).toBe("open");
      expect(invoice.subtotalBaseUnits).toBe("100000000");
      const tag = BigInt(invoice.amountDueBaseUnits) - 100_000_000n;
      expect(tag > 0n && tag < 10_000n).toBe(true);
      await expect(operations.createInvoice(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: nativeAsset, customerName: "x", lineItems: [{ description: "x", quantity: 1, unitAmountBaseUnits: "1" }], issue: true }, ws.owner.principalId)).rejects.toMatchObject({ code: "evm_native_invoice_unsupported" });

      // The customer pays the exact amount due, sends an unrelated 5 TUSD, and 0.5 ETH directly.
      const transfer = async (amount: bigint) => publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "transfer", args: [ws.signer.address, amount], account: customer }) });
      await transfer(BigInt(invoice.amountDueBaseUnits));
      await transfer(5_000_000n);
      await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: customer, to: ws.signer.address as Address, value: parseEther("0.5") }) });
      const synced = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(synced.assets.find((asset) => asset.assetId === tokenAsset)).toMatchObject({ inflows: 2, reconciliation: "matched" });
      expect(synced.assets.find((asset) => asset.assetId === nativeAsset)).toMatchObject({ inflows: 1, reconciliation: "matched" });
      const paid = (await operations.getInvoice(ws.owner.organizationId, invoice.id))!;
      expect(paid.invoice.status).toBe("paid");
      expect(paid.payments).toHaveLength(1);
      expect(paid.payments[0]?.fromAddress?.toLowerCase()).toBe(customer.address.toLowerCase());
      const unallocated = await operations.listInflows(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, unallocatedOnly: true });
      expect(unallocated.map((inflow) => inflow.amountBaseUnits).sort()).toEqual(["5000000", "500000000000000000"]);
      // Syncing again books nothing twice.
      expect((await runtime.worker.syncTreasury(ws.treasury.id)).assets.every((asset) => asset.inflows === 0)).toBe(true);

      // A customer who pays the subtotal without the identifier is matched by hand.
      const second = await operations.createInvoice(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, customerName: "Contoso", lineItems: [{ description: "Retainer", quantity: 1, unitAmountBaseUnits: "20000000" }], issue: true }, ws.owner.principalId);
      await transfer(20_000_000n);
      await runtime.worker.syncTreasury(ws.treasury.id);
      expect((await operations.getInvoice(ws.owner.organizationId, second.id))!.invoice.status).toBe("open");
      const stray = (await operations.listInflows(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, unallocatedOnly: true })).find((inflow) => inflow.amountBaseUnits === "20000000")!;
      const allocated = await operations.allocateInflow(ws.owner.organizationId, stray.id, second.id, ws.owner.principalId);
      expect(allocated.status).toBe("paid");
      await expect(operations.allocateInflow(ws.owner.organizationId, stray.id, second.id, ws.owner.principalId)).rejects.toMatchObject({ code: "inflow_already_allocated" });
      const draft = await operations.createInvoice(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, customerName: "Fabrikam", lineItems: [{ description: "Cancelled work", quantity: 1, unitAmountBaseUnits: "1000000" }], issue: true }, ws.owner.principalId);
      expect((await operations.voidInvoice(ws.owner.organizationId, draft.id, ws.owner.principalId)).status).toBe("void");

      // An outbound transfer: fees are booked, and reconciliation still matches.
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `recv-${intentId}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.owner.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination: privateKeyToAccount(generatePrivateKey()).address, purpose: "Contractor payout", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      await approve(store, ws.owner.organizationId, ws.owner.principalId, intentId);
      expect((await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["reconciled", "failed"])).status).toBe("reconciled");
      const afterPayout = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(afterPayout.assets.find((asset) => asset.assetId === nativeAsset)?.reconciliation).toBe("matched");

      // Statement for the native asset: opening balance, receipt, payout, fee, closing equal to the chain.
      const periodEnd = new Date(Date.now() + 60_000).toISOString();
      const native = (await operations.statement(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: nativeAsset, from: periodStart, to: periodEnd }))!;
      expect(native.openingBalanceBaseUnits).toBe("0");
      expect(native.lines.map((line) => line.category)).toEqual(["opening_balance", "inflow", "outflow", "fee"]);
      expect(native.outflowsBaseUnits).toBe(parseEther("1").toString());
      expect(BigInt(native.feesBaseUnits)).toBeGreaterThan(0n);
      expect(native.closingBalanceBaseUnits).toBe((await publicClient.getBalance({ address: ws.signer.address as Address })).toString());
      const tokens = (await operations.statement(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, from: periodStart, to: periodEnd }))!;
      expect(tokens.inflowsBaseUnits).toBe((BigInt(invoice.amountDueBaseUnits) + 25_000_000n).toString());
      expect(tokens.closingBalanceBaseUnits).toBe(String(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [ws.signer.address] })));
      expect(tokens.latestReconciliation?.status).toBe("matched");
      // Opening from later in the period carries the running balance forward.
      const later = (await operations.statement(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, from: new Date(Date.now() + 1_000).toISOString(), to: periodEnd }))!;
      expect(later.openingBalanceBaseUnits).toBe(tokens.closingBalanceBaseUnits);
      expect(later.lines).toHaveLength(0);

      // A deposit nobody sees yet is a break until the next sync picks it up.
      await anvil("anvil_setBalance", [ws.signer.address, `0x${((await publicClient.getBalance({ address: ws.signer.address as Address })) + 1n).toString(16)}`]);
      await anvil("evm_mine", []);
      const broken = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(broken.assets.find((asset) => asset.assetId === nativeAsset)?.reconciliation).toBe("break");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 180_000);

  evmTestIf("recurring payments create policy-checked intents once per occurrence and skip missed bursts", async () => {
    const store = createPostgresStore(databaseUrl!);
    const operations = new OperationsStore(store.sql);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, confirmations: 1 } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const ws = await directWorkspace(store, "evm", evmNetwork);
      await anvil("anvil_setBalance", [ws.signer.address, "0x8ac7230489e80000"]);
      const nativeAsset = `${evmNetwork}/slip44:60`;
      const contractor = privateKeyToAccount(generatePrivateKey()).address;
      const agent = await store.createAgent(ws.owner.organizationId, { displayName: "Payroll", purpose: "Pay contractors" }, ws.owner.principalId);
      const policy = await store.createPolicy(ws.owner.organizationId, { name: "Beneficiaries only", definition: { maxPerTransactionBaseUnits: parseEther("1").toString(), maxDailyBaseUnits: parseEther("5").toString(), allowedNetworks: [evmNetwork], allowedAssets: [nativeAsset], requireBeneficiary: true }, createdBy: ws.owner.principalId });
      await store.bindPolicy(ws.owner.organizationId, { policyId: policy.id, agentId: agent.id }, ws.owner.principalId);

      const beneficiary = await operations.createBeneficiary(ws.owner.organizationId, { name: "Ada (contractor)", chainFamily: "evm", network: evmNetwork, address: contractor }, ws.owner.principalId);
      expect(beneficiary.status).toBe("pending");
      const submit = async (destination: string) => {
        const id = crypto.randomUUID();
        await store.createIntent({ id, idempotencyKey: `ben-${id}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: agent.principalId, network: evmNetwork, assetId: nativeAsset, amountBaseUnits: "1000", destination, purpose: "Contractor payment", expiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "transfer" });
        await runtime.worker.drain();
        return (await store.getIntent(ws.owner.organizationId, id))!.intent;
      };
      expect((await submit(contractor)).failureReason).toContain("not an approved beneficiary");
      await operations.approveBeneficiary(ws.owner.organizationId, beneficiary.id, ws.owner.principalId, "0xsignature");
      expect((await submit(contractor)).status).toBe("approval_required");
      expect((await submit(privateKeyToAccount(generatePrivateKey()).address)).failureReason).toContain("not an approved beneficiary");

      // A schedule that started just now: occurrence 1 is due once, never twice.
      await expect(operations.createSchedule(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, beneficiaryId: crypto.randomUUID(), assetId: nativeAsset, amountBaseUnits: "1", purpose: "x", intervalUnit: "day", intervalCount: 1, startAt: new Date().toISOString() }, ws.owner.principalId)).rejects.toThrow();
      const schedule = await operations.createSchedule(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, beneficiaryId: beneficiary.id, assetId: nativeAsset, amountBaseUnits: parseEther("0.1").toString(), purpose: "Weekly retainer", intervalUnit: "week", intervalCount: 1, startAt: new Date(Date.now() - 1_000).toISOString(), maxOccurrences: 2 }, ws.owner.principalId);
      await runtime.worker.enqueueSchedules();
      await runtime.worker.enqueueSchedules();
      const scheduled = (await store.listIntents(ws.owner.organizationId)).filter((intent) => intent.purpose.startsWith("Weekly retainer"));
      expect(scheduled).toHaveLength(1);
      const first = scheduled[0]!;
      expect(first.destination.toLowerCase()).toBe(contractor.toLowerCase());
      await runtime.worker.drain();
      await approve(store, ws.owner.organizationId, ws.owner.principalId, first.id);
      expect((await untilStatus(store, runtime, ws.owner.organizationId, first.id, ["reconciled", "failed"])).status).toBe("reconciled");

      // Next week arrives: occurrence 2, then the schedule completes at its limit.
      await store.sql`update payment_schedules set next_run_at = now() - interval '1 second' where id = ${schedule.id}`;
      await runtime.worker.enqueueSchedules();
      const afterSecond = (await operations.listSchedules(ws.owner.organizationId)).find((candidate) => candidate.id === schedule.id)!;
      expect(afterSecond.occurrencesCreated).toBe(2);
      expect(afterSecond.status).toBe("completed");
      expect((await store.listIntents(ws.owner.organizationId)).filter((intent) => intent.purpose.startsWith("Weekly retainer"))).toHaveLength(2);

      // A daily schedule that started three days ago pays only the latest occurrence and records the skip.
      const backdated = await operations.createSchedule(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, beneficiaryId: beneficiary.id, assetId: nativeAsset, amountBaseUnits: "1000", purpose: "Daily fee", intervalUnit: "day", intervalCount: 1, startAt: new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString() }, ws.owner.principalId);
      await runtime.worker.enqueueSchedules();
      const daily = (await store.listIntents(ws.owner.organizationId)).filter((intent) => intent.purpose.startsWith("Daily fee"));
      expect(daily).toHaveLength(1);
      expect(daily[0]!.purpose).toContain("payment 4");
      const refreshed = (await operations.listSchedules(ws.owner.organizationId)).find((candidate) => candidate.id === backdated.id)!;
      expect(new Date(refreshed.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      expect((await store.listAuditEvents(ws.owner.organizationId)).some((event) => event.action === "schedule.occurrences_skipped")).toBe(true);

      // Archiving the beneficiary pauses its schedules.
      await operations.archiveBeneficiary(ws.owner.organizationId, beneficiary.id, ws.owner.principalId);
      expect((await operations.listSchedules(ws.owner.organizationId)).find((candidate) => candidate.id === backdated.id)?.status).toBe("paused");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 180_000);
});

describe("receivables and reconciliation on Solana", () => {
  solanaTestIf("matches invoices by Solana Pay reference and books rent paid for recipient token accounts", async () => {
    const store = createPostgresStore(databaseUrl!);
    const operations = new OperationsStore(store.sql);
    const chain: WorkerChainConfig = { signerMasterKey: masterKey, solana: { rpcUrl: solanaRpc!, network: solNetwork, finality: "finalized" } };
    const runtime = createWorker(databaseUrl!, chain);
    try {
      const connection = new Connection(solanaRpc!, "confirmed");
      const airdrop = async (address: PublicKey, sol: number) => {
        const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL);
        await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
      };
      const customer = Keypair.generate();
      await airdrop(customer.publicKey, 5);
      const mint = await createMint(connection, customer, customer.publicKey, null, 6);
      const customerAta = await getOrCreateAssociatedTokenAccount(connection, customer, mint, customer.publicKey);
      await mintTo(connection, customer, mint, customerAta.address, customer, 1_000_000_000n);
      const tokenAsset = tokenAssetId(solNetwork, "spl", mint.toBase58());
      await store.upsertAsset({ id: tokenAsset, network: solNetwork, chainFamily: "svm", kind: "spl", address: mint.toBase58(), symbol: "TUSD", decimals: 6 });
      const nativeAsset = `${solNetwork}/slip44:501`;

      const ws = await directWorkspace(store, "svm", solNetwork);
      const treasuryKey = new PublicKey(ws.signer.address);
      await airdrop(treasuryKey, 2);
      const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, customer, mint, treasuryKey);
      const finalized = async () => { for (let i = 0; i < 60; i += 1) { const slot = await connection.getSlot("finalized"); const confirmed = await connection.getSlot("confirmed"); if (slot >= confirmed) return; await new Promise((resolve) => setTimeout(resolve, 500)); } };
      await finalized();
      const opened = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(opened.assets.find((asset) => asset.assetId === nativeAsset)).toMatchObject({ opened: true, reconciliation: "matched" });

      const invoice = await operations.createInvoice(ws.owner.organizationId, { treasuryAccountId: ws.treasury.id, assetId: tokenAsset, customerName: "Globex", lineItems: [{ description: "Audit", quantity: 1, unitAmountBaseUnits: "75000000" }], issue: true }, ws.owner.principalId);
      expect(invoice.amountDueBaseUnits).toBe("75000000");
      expect(invoice.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

      // The customer's wallet includes the invoice reference as a read-only account, as Solana Pay prescribes.
      const payment = createTransferCheckedInstruction(customerAta.address, mint, treasuryAta.address, customer.publicKey, 75_000_000n, 6);
      payment.keys.push({ pubkey: new PublicKey(invoice.reference!), isSigner: false, isWritable: false });
      await sendAndConfirmTransaction(connection, new Transaction().add(payment), [customer], { commitment: "confirmed" });
      await finalized();
      const synced = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(synced.assets.find((asset) => asset.assetId === tokenAsset)).toMatchObject({ inflows: 1, reconciliation: "matched" });
      const paid = (await operations.getInvoice(ws.owner.organizationId, invoice.id))!;
      expect(paid.invoice.status).toBe("paid");
      expect(paid.payments[0]?.fromAddress).toBe(customer.publicKey.toBase58());

      // Paying out tokens to a wallet without a token account costs the treasury rent; the ledger books it and SOL still reconciles.
      const intentId = crypto.randomUUID();
      await store.createIntent({ id: intentId, idempotencyKey: `sol-${intentId}`, organizationId: ws.owner.organizationId, treasuryAccountId: ws.treasury.id, requesterId: ws.owner.principalId, network: solNetwork, assetId: tokenAsset, amountBaseUnits: "10000000", destination: Keypair.generate().publicKey.toBase58(), purpose: "Refund", expiresAt: new Date(Date.now() + 180_000).toISOString(), kind: "transfer" });
      await runtime.worker.drain();
      await approve(store, ws.owner.organizationId, ws.owner.principalId, intentId);
      expect((await untilStatus(store, runtime, ws.owner.organizationId, intentId, ["reconciled", "failed"], 120)).status).toBe("reconciled");
      const fees = (await store.listLedgerEntries(ws.owner.organizationId)).filter((entry) => entry.intentId === intentId && entry.accountCode === "fee_expense");
      expect(fees).toHaveLength(1);
      expect(BigInt(fees[0]!.amountBaseUnits)).toBeGreaterThan(2_000_000n); // network fee plus token account rent
      await finalized();
      const afterPayout = await runtime.worker.syncTreasury(ws.treasury.id);
      expect(afterPayout.assets.find((asset) => asset.assetId === nativeAsset)?.reconciliation).toBe("matched");
      expect(afterPayout.assets.find((asset) => asset.assetId === tokenAsset)?.reconciliation).toBe("matched");
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 240_000);
});
