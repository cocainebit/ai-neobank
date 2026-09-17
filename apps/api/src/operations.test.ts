import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { createWorker } from "@ai-neobank/worker";
import { X402PaymentClient } from "@ai-neobank/x402-adapter";
import { createLocalFacilitator } from "@ai-neobank/x402-adapter/testing";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl && evmRpc;
const testIf = enabled ? it : it.skip;
const masterKey = new Uint8Array(32).fill(17);
const network = "eip155:31337" as const;
const domain = "relay.test";
const uri = "http://relay.test";
const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };
const chainConfig = { rpcUrl: evmRpc ?? "", chainId: 31337, network };

let app: ReturnType<typeof buildApp> | null = null;
let baseUrl = "";
const runtime = enabled ? createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: chainConfig }) : null;

beforeAll(async () => {
  if (!enabled) return;
  const facilitatorKey = generatePrivateKey();
  await anvil("anvil_setBalance", [privateKeyToAccount(facilitatorKey).address, "0x8ac7230489e80000"]);
  const facilitator = await createLocalFacilitator({ evm: { rpcUrl: evmRpc!, chainId: 31337, privateKey: facilitatorKey } });
  app = buildApp({ store: createPostgresStore(databaseUrl!), queue: createPostgresJobQueue(databaseUrl!), environment: "development", auth: { domain, uri }, webOrigin: uri, signerMasterKey: masterKey, allowSoftwareSigners: true, chains: { evm: chainConfig }, x402Seller: { facilitator: facilitator.client }, logger: false });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => { await app?.close(); await runtime?.close(); });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

async function signIn(account: PrivateKeyAccount) {
  const challenge = await app!.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "evm", address: account.address, chainReference: "31337" } });
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const verify = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: account.address, nonce, signature: await account.signMessage({ message }) } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data as { session: { token: string }; organization: { id: string }; principal: { id: string } };
}

describe("payables and receivables over HTTP", () => {
  testIf("beneficiary step-up, invoices paid over x402 without double counting, schedules, reconciliation, statements", async () => {
    const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const customerKey = generatePrivateKey();
    const customer = privateKeyToAccount(customerKey);
    await anvil("anvil_setBalance", [customer.address, "0x8ac7230489e80000"]);
    const wallet = createWalletClient({ account: customer, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const token = (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: customer }) })).contractAddress as Address;
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [customer.address, 1_000_000_000n], account: customer }) });

    const owner = privateKeyToAccount(generatePrivateKey());
    const session = (await signIn(owner)).session.token;
    const signer = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(session), payload: { chainFamily: "evm" } })).json().data as { address: string };
    await anvil("anvil_setBalance", [signer.address, "0xde0b6b3a7640000"]);
    const treasury = (await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(session), payload: { name: "Receivables", chainFamily: "evm", network, address: signer.address, governance: "direct" } })).json().data as { id: string };
    const asset = (await app!.inject({ method: "POST", url: "/v1/assets", headers: bearer(session), payload: { network, kind: "erc20", address: token, symbol: "TUSD" } })).json().data as { id: string };
    const nativeAsset = `${network}/slip44:60`;
    const periodStart = new Date(Date.now() - 1_000).toISOString();
    await runtime!.worker.syncTreasury(treasury.id);

    // Beneficiaries need an owner wallet signature over the exact address.
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const created = await app!.inject({ method: "POST", url: "/v1/beneficiaries", headers: bearer(session), payload: { name: "Studio Ada", chainFamily: "evm", network, address: payee.toLowerCase() } });
    expect(created.statusCode).toBe(201);
    const beneficiary = created.json().data as { id: string; address: string; status: string };
    expect(beneficiary.address).toBe(payee);
    expect((await app!.inject({ method: "POST", url: "/v1/beneficiaries", headers: bearer(session), payload: { name: "Dup", chainFamily: "evm", network, address: payee } })).statusCode).toBe(409);
    const pendingPay = await app!.inject({ method: "POST", url: "/v1/intents", headers: { ...bearer(session), origin: uri }, payload: { idempotencyKey: `ben-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, assetId: nativeAsset, amountBaseUnits: "1000", beneficiaryId: beneficiary.id, purpose: "Too early" } });
    expect(pendingPay.statusCode).toBe(409);
    const { message } = (await app!.inject({ method: "GET", url: `/v1/beneficiaries/${beneficiary.id}/approval-message`, headers: bearer(session) })).json().data as { message: string };
    expect(message).toContain(payee);
    expect((await app!.inject({ method: "POST", url: `/v1/beneficiaries/${beneficiary.id}/approve`, headers: bearer(session), payload: { signature: await privateKeyToAccount(generatePrivateKey()).signMessage({ message }) } })).statusCode).toBe(401);
    const approved = await app!.inject({ method: "POST", url: `/v1/beneficiaries/${beneficiary.id}/approve`, headers: bearer(session), payload: { signature: await owner.signMessage({ message }) } });
    expect(approved.json().data.status).toBe("active");
    const pay = await app!.inject({ method: "POST", url: "/v1/intents", headers: bearer(session), payload: { idempotencyKey: `ben-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, assetId: nativeAsset, amountBaseUnits: "1000", beneficiaryId: beneficiary.id, purpose: "Pay the studio" } });
    expect(pay.statusCode).toBe(202);
    expect(pay.json().data.destination).toBe(payee);

    // Recurring payment to the beneficiary, paused and resumed.
    const schedule = await app!.inject({ method: "POST", url: "/v1/schedules", headers: bearer(session), payload: { treasuryAccountId: treasury.id, beneficiaryId: beneficiary.id, assetId: asset.id, amountBaseUnits: "2500000", purpose: "Monthly retainer", intervalUnit: "month", startAt: new Date(Date.now() + 86_400_000).toISOString() } });
    expect(schedule.statusCode).toBe(201);
    const scheduleId = schedule.json().data.id as string;
    expect((await app!.inject({ method: "PATCH", url: `/v1/schedules/${scheduleId}`, headers: bearer(session), payload: { status: "paused" } })).json().data.status).toBe("paused");
    expect((await app!.inject({ method: "PATCH", url: `/v1/schedules/${scheduleId}`, headers: bearer(session), payload: { status: "active" } })).json().data.status).toBe("active");

    // Invoice, public page, and payment over x402.
    const invoiceResponse = await app!.inject({ method: "POST", url: "/v1/invoices", headers: bearer(session), payload: { treasuryAccountId: treasury.id, assetId: asset.id, customerName: "Initech", customerEmail: "ap@initech.example", lineItems: [{ description: "API integration", quantity: 3, unitAmountBaseUnits: "40000000" }] } });
    expect(invoiceResponse.statusCode).toBe(201);
    const invoice = invoiceResponse.json().data as { id: string; publicToken: string; subtotalBaseUnits: string; amountDueBaseUnits: string };
    expect(invoice.subtotalBaseUnits).toBe("120000000");
    const publicView = await fetch(`${baseUrl}/v1/public/invoices/${invoice.publicToken}`);
    const view = (await publicView.json() as { data: { amountDue: string; subtotal: string; instructions: Record<string, string>; issuer: string } }).data;
    expect(view.subtotal).toBe("120");
    expect(view.instructions.eip681).toContain(`/transfer?address=${signer.address}&uint256=${invoice.amountDueBaseUnits}`);
    expect(view.instructions.x402).toBe(`${baseUrl}/v1/public/invoices/${invoice.publicToken}/x402`);
    expect((await fetch(`${baseUrl}/v1/public/invoices/not-a-token`)).status).toBe(404);

    const payer = new X402PaymentClient({ evm: { network, chainId: 31337, rpcUrl: evmRpc! } });
    const quote = await payer.quote({ url: view.instructions.x402! }, { chainFamily: "evm", network, assetAddress: token, maxAmountBaseUnits: 200_000_000n });
    expect(quote.requirements.amount).toBe("120000000");
    expect(quote.requirements.payTo.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(quote.requirements.extra).toMatchObject({ name: "Test USD", version: "2" });
    const payload = await payer.createPayload(quote, { evmPrivateKey: customerKey });
    const paid = await payer.pay(quote, payload);
    expect(paid.status).toBe(200);
    expect(paid.settle?.success).toBe(true);
    const invoiceDetail = (await app!.inject({ method: "GET", url: `/v1/invoices/${invoice.id}`, headers: bearer(session) })).json().data as { invoice: { status: string; amountPaidBaseUnits: string }; payments: { method: string; transactionHash: string }[] };
    expect(invoiceDetail.invoice.status).toBe("paid");
    expect(invoiceDetail.payments).toEqual([expect.objectContaining({ method: "x402", transactionHash: paid.settle!.transaction })]);
    expect((await payer.pay(quote, payload)).status).toBe(409);

    // The indexer sees the same transfer on chain and books nothing twice; the ledger matches the chain.
    const synced = await runtime!.worker.syncTreasury(treasury.id);
    expect(synced.assets.find((entry) => entry.assetId === asset.id)).toMatchObject({ inflows: 0, reconciliation: "matched" });
    const afterSync = (await app!.inject({ method: "GET", url: `/v1/invoices/${invoice.id}`, headers: bearer(session) })).json().data;
    expect(afterSync.invoice.amountPaidBaseUnits).toBe("120000000");
    const reconciliation = (await app!.inject({ method: "GET", url: "/v1/reconciliation", headers: bearer(session) })).json().data as { assetId: string; status: string }[];
    expect(reconciliation.find((row) => row.assetId === asset.id)?.status).toBe("matched");
    expect((await app!.inject({ method: "POST", url: `/v1/treasuries/${treasury.id}/sync`, headers: bearer(session) })).statusCode).toBe(202);

    // Statements in JSON and CSV.
    const to = new Date(Date.now() + 60_000).toISOString();
    const statement = (await app!.inject({ method: "GET", url: `/v1/statements?treasuryAccountId=${treasury.id}&assetId=${encodeURIComponent(asset.id)}&from=${periodStart}&to=${to}`, headers: bearer(session) })).json().data as { inflowsBaseUnits: string; closingBalanceBaseUnits: string; lines: unknown[] };
    expect(statement.inflowsBaseUnits).toBe("120000000");
    expect(statement.closingBalanceBaseUnits).toBe("120000000");
    const csv = await app!.inject({ method: "GET", url: `/v1/statements?treasuryAccountId=${treasury.id}&assetId=${encodeURIComponent(asset.id)}&from=${periodStart}&to=${to}&format=csv`, headers: bearer(session) });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("date,category,description,amount,balance,reference,intent");
    expect(csv.body).toContain(",inflow,");
    expect(csv.body).toContain(",120,120,");
    const monthly = await app!.inject({ method: "GET", url: `/v1/statements?treasuryAccountId=${treasury.id}&assetId=${encodeURIComponent(asset.id)}&month=${new Date().toISOString().slice(0, 7)}`, headers: bearer(session) });
    expect(monthly.statusCode).toBe(200);

    // Voiding a paid invoice is refused.
    expect((await app!.inject({ method: "POST", url: `/v1/invoices/${invoice.id}/void`, headers: bearer(session) })).statusCode).toBe(409);
  }, 120_000);
});
