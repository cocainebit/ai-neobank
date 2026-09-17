import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { createWorker } from "@ai-neobank/worker";
import { tokenAssetId } from "@ai-neobank/domain";
import { createLocalFacilitator, startLocalSeller } from "@ai-neobank/x402-adapter/testing";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl && evmRpc;
const testIf = enabled ? it : it.skip;
const masterKey = new Uint8Array(32).fill(13);
const network = "eip155:31337" as const;
const domain = "relay.test";
const uri = "http://relay.test";
const fixture = JSON.parse(readFileSync(new URL("../../../packages/evm-adapter/fixtures/TestUSD3009.json", import.meta.url), "utf8")) as { abi: readonly unknown[]; bytecode: Hex };

const app = enabled
  ? buildApp({ store: createPostgresStore(databaseUrl!), queue: createPostgresJobQueue(databaseUrl!), environment: "development", auth: { domain, uri }, webOrigin: uri, signerMasterKey: masterKey, allowSoftwareSigners: true, chains: { evm: { rpcUrl: evmRpc!, chainId: 31337, network } }, logger: false })
  : null;
const runtime = enabled ? createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network } }) : null;

beforeAll(async () => { await app?.ready(); });
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

describe("x402 over HTTP", () => {
  testIf("agent quotes, submits a URL intent, owner approves the quoted terms, worker pays and reconciles", async () => {
    const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [evmRpc!] } } });
    const deployerKey = generatePrivateKey();
    const deployer = privateKeyToAccount(deployerKey);
    const facilitatorKey = generatePrivateKey();
    await Promise.all([anvil("anvil_setBalance", [deployer.address, "0x8ac7230489e80000"]), anvil("anvil_setBalance", [privateKeyToAccount(facilitatorKey).address, "0x8ac7230489e80000"])]);
    const wallet = createWalletClient({ account: deployer, chain, transport: http(evmRpc) });
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const token = (await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: fixture.abi as never, bytecode: fixture.bytecode, account: deployer }) })).contractAddress as Address;
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const facilitator = await createLocalFacilitator({ evm: { rpcUrl: evmRpc!, chainId: 31337, privateKey: facilitatorKey } });
    const seller = await startLocalSeller(facilitator.client, [{ route: "GET /report", network, payTo: payee, asset: token, amount: "250000", extra: { name: "Test USD", version: "2" }, body: { report: "quarterly" } }], { evm: { rpcUrl: evmRpc! } });
    try {
      const owner = privateKeyToAccount(generatePrivateKey());
      const token0 = (await signIn(owner)).session.token;
      const signer = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token0), payload: { chainFamily: "evm" } })).json().data as { id: string; address: string };
      await anvil("anvil_setBalance", [signer.address, "0xde0b6b3a7640000"]);
      await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: fixture.abi as never, functionName: "mint", args: [signer.address, 5_000_000n], account: deployer }) });
      const treasury = (await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token0), payload: { name: "Agent account", chainFamily: "evm", network, address: signer.address, governance: "direct" } })).json().data as { id: string };
      const asset = await app!.inject({ method: "POST", url: "/v1/assets", headers: bearer(token0), payload: { network, kind: "erc20", address: token, symbol: "TUSD" } });
      expect(asset.statusCode, asset.body).toBe(201);
      expect(asset.json().data.decimals).toBe(6);
      const assetId = asset.json().data.id as string;
      expect(assetId).toBe(tokenAssetId(network, "erc20", getAddress(token)));
      const agentResponse = await app!.inject({ method: "POST", url: "/v1/agents", headers: bearer(token0), payload: { displayName: "Research", purpose: "Buy data" } });
      expect(agentResponse.statusCode, agentResponse.body).toBe(201);
      const agent = agentResponse.json().data as { id: string };
      const credential = await app!.inject({ method: "POST", url: `/v1/agents/${agent.id}/credentials`, headers: bearer(token0), payload: {} });
      expect(credential.statusCode, credential.body).toBe(201);
      const agentToken = credential.json().token as string;
      const policy = (await app!.inject({ method: "POST", url: "/v1/policies", headers: bearer(token0), payload: { name: "Machine payments", definition: { maxPerTransactionBaseUnits: "1000000", maxDailyBaseUnits: "5000000", allowedNetworks: [network], allowedAssets: [assetId], allowedKinds: ["x402"] } } })).json().data as { id: string };
      await app!.inject({ method: "POST", url: `/v1/policies/${policy.id}/bindings`, headers: bearer(token0), payload: { agentId: agent.id } });

      // The agent can look before it leaps: the quote is a dry run.
      const quote = await app!.inject({ method: "POST", url: "/v1/agent/x402/quote", headers: bearer(agentToken), payload: { url: `${seller.url}/report`, treasuryAccountId: treasury.id, assetId, maxAmountBaseUnits: "1000000" } });
      expect(quote.statusCode, quote.body).toBe(200);
      expect(quote.json().data.requirements.amount).toBe("250000");
      const tooCheap = await app!.inject({ method: "POST", url: "/v1/agent/x402/quote", headers: bearer(agentToken), payload: { url: `${seller.url}/report`, treasuryAccountId: treasury.id, assetId, maxAmountBaseUnits: "1000" } });
      expect(tooCheap.statusCode).toBe(422);
      expect(tooCheap.json().error).toBe("x402_exceeds_max");

      // Non-https destinations are refused outside local development hosts; a transfer to a URL is refused too.
      expect((await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `x-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, kind: "x402", assetId, amountBaseUnits: "1000000", destination: "http://example.com/report", purpose: "insecure" } })).statusCode).toBe(400);
      expect((await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `x-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, kind: "transfer", assetId, amountBaseUnits: "1000000", destination: `${seller.url}/report`, purpose: "wrong kind" } })).statusCode).toBe(400);

      const submitted = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `x-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, kind: "x402", assetId, amountBaseUnits: "1000000", destination: `${seller.url}/report`, purpose: "Buy the quarterly report" } });
      expect(submitted.statusCode).toBe(202);
      const intentId = submitted.json().data.id as string;
      await runtime!.worker.drain();
      const pending = (await app!.inject({ method: "GET", url: `/v1/intents/${intentId}`, headers: bearer(token0) })).json().data;
      expect(pending.intent.status).toBe("approval_required");
      expect(pending.intent.policyDecision.x402.requirements.amount).toBe("250000");
      const approval = (await app!.inject({ method: "GET", url: `/v1/intents/${intentId}/approval-message/approved`, headers: bearer(token0) })).json().data;
      expect(approval.kind).toBe("plain");
      expect(approval.message).toContain(`Compiled: ${pending.approval.compiledHash}`);
      const approved = await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(token0), payload: { expectedIntentVersion: approval.expectedIntentVersion, compiledHash: approval.compiledHash, simulationHash: approval.simulationHash, signature: await owner.signMessage({ message: approval.message }) } });
      expect(approved.statusCode).toBe(202);
      let status = "";
      for (let attempt = 0; attempt < 40 && status !== "reconciled"; attempt += 1) {
        await runtime!.worker.drain();
        status = (await app!.inject({ method: "GET", url: `/v1/intents/${intentId}`, headers: bearer(token0) })).json().data.intent.status;
        if (status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(status).toBe("reconciled");
      expect(await publicClient.readContract({ address: token, abi: fixture.abi as never, functionName: "balanceOf", args: [payee] })).toBe(250_000n);
      const agentView = (await app!.inject({ method: "GET", url: `/v1/agent/intents/${intentId}`, headers: bearer(agentToken) })).json().data;
      expect(agentView.execution.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await app!.inject({ method: "GET", url: "/health" })).json().integrations.x402).toBe("e2e_local");
    } finally {
      await seller.close();
    }
  }, 120_000);
});
