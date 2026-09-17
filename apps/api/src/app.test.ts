import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseEther } from "viem";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { createWorker } from "@ai-neobank/worker";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl && evmRpc;
const testIf = enabled ? it : it.skip;
const masterKey = new Uint8Array(32).fill(7);
const network = "eip155:31337" as const;
const nativeAsset = `${network}/slip44:60`;
const domain = "relay.test";
const uri = "http://relay.test";

const app = enabled
  ? buildApp({
      store: createPostgresStore(databaseUrl!),
      queue: createPostgresJobQueue(databaseUrl!),
      environment: "development",
      auth: { domain, uri },
      webOrigin: uri,
      signerMasterKey: masterKey,
      allowSoftwareSigners: true,
      chains: { evm: { rpcUrl: evmRpc!, chainId: 31337, network } },
      logger: false
    })
  : null;
const runtime = enabled ? createWorker(databaseUrl!, { signerMasterKey: masterKey, evm: { rpcUrl: evmRpc!, chainId: 31337, network } }) : null;

beforeAll(async () => { await app?.ready(); });
afterAll(async () => { await app?.close(); await runtime?.close(); });

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

/** Wallet sign-in over the API, returning a bearer token. */
async function signIn(account: PrivateKeyAccount, organizationId?: string) {
  const challenge = await app!.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "evm", address: account.address, chainReference: "31337" } });
  expect(challenge.statusCode).toBe(201);
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const signature = await account.signMessage({ message });
  const verify = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: account.address, nonce, signature, organizationId } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data as { session: { token: string }; organization: { id: string }; principal: { id: string; role: string }; memberships: { organizationId: string }[] };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("API end to end", () => {
  testIf("wallet sign-in, roles, agent keys, policy, signed approval, and execution to reconciliation", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const first = await signIn(owner);
    expect(first.principal.role).toBe("owner");
    const token = first.session.token;
    const organizationId = first.organization.id;

    // Anonymous and wrong-role access.
    expect((await app!.inject({ method: "GET", url: "/v1/agents" })).statusCode).toBe(401);
    const replayedChallenge = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: owner.address, nonce: "0123456789abcdef", signature: "0x" + "11".repeat(65) } });
    expect(replayedChallenge.statusCode).toBe(401);

    // Members: an approver is pre-registered by wallet and signs in to the same organisation.
    const approver = privateKeyToAccount(generatePrivateKey());
    const member = await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Second signer", role: "approver", wallet: { chainFamily: "evm", address: approver.address } } });
    expect(member.statusCode).toBe(201);
    const approverSession = await signIn(approver);
    expect(approverSession.organization.id).toBe(organizationId);
    expect(approverSession.principal.role).toBe("approver");
    expect((await app!.inject({ method: "POST", url: "/v1/agents", headers: bearer(approverSession.session.token), payload: { displayName: "x", purpose: "not allowed" } })).statusCode).toBe(403);

    // Agent, credential, treasury with a development signer, asset registry, policy.
    const agent = await app!.inject({ method: "POST", url: "/v1/agents", headers: bearer(token), payload: { displayName: "Payables", purpose: "Pay approved vendors" } });
    expect(agent.statusCode).toBe(201);
    const agentId = agent.json().data.id as string;
    const credential = await app!.inject({ method: "POST", url: "/v1/agents/" + agentId + "/credentials", headers: bearer(token), payload: { label: "runtime" } });
    expect(credential.statusCode).toBe(201);
    const agentToken = credential.json().token as string;
    expect(agentToken.startsWith("rl_agent_")).toBe(true);
    expect((await app!.inject({ method: "GET", url: "/v1/agents", headers: bearer(agentToken) })).statusCode).toBe(401);

    const signer = await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "evm" } });
    expect(signer.statusCode).toBe(201);
    expect(signer.json().developmentSecret).toBeUndefined();
    const treasuryAddress = signer.json().data.address as string;
    await anvil("anvil_setBalance", [treasuryAddress, "0x8ac7230489e80000"]);
    const treasury = await app!.inject({ method: "POST", url: "/v1/treasuries", headers: bearer(token), payload: { name: "Ops", chainFamily: "evm", network, address: treasuryAddress, governance: "direct" } });
    expect(treasury.statusCode).toBe(201);
    const treasuryId = treasury.json().data.id as string;
    const balances = await app!.inject({ method: "GET", url: `/v1/treasuries/${treasuryId}/balances`, headers: bearer(token) });
    expect(balances.json().data.balances.find((entry: { assetId: string }) => entry.assetId === nativeAsset).balanceBaseUnits).toBe(parseEther("10").toString());

    const policy = await app!.inject({ method: "POST", url: "/v1/policies", headers: bearer(token), payload: { name: "Vendors", definition: { maxPerTransactionBaseUnits: parseEther("2").toString(), maxDailyBaseUnits: parseEther("3").toString(), allowedNetworks: [network], allowedAssets: [nativeAsset], minApprovals: 2 } } });
    expect(policy.statusCode).toBe(201);
    const bound = await app!.inject({ method: "POST", url: `/v1/policies/${policy.json().data.id}/bindings`, headers: bearer(token), payload: { agentId } });
    expect(bound.statusCode).toBe(201);

    // The agent submits an intent with its key. Capabilities show what it may do.
    const capabilities = await app!.inject({ method: "GET", url: "/v1/agent/capabilities", headers: bearer(agentToken) });
    expect(capabilities.json().data.policies).toHaveLength(1);
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    const submitted = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `api-${crypto.randomUUID()}`, treasuryAccountId: treasuryId, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Pay vendor invoice 1842" } });
    expect(submitted.statusCode).toBe(202);
    const intentId = submitted.json().data.id as string;
    const replay = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: submitted.json().data.idempotencyKey, treasuryAccountId: treasuryId, assetId: nativeAsset, amountBaseUnits: parseEther("1").toString(), destination, purpose: "Pay vendor invoice 1842" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    const overLimit = await app!.inject({ method: "POST", url: "/v1/agent/intents", headers: bearer(agentToken), payload: { idempotencyKey: `api-${crypto.randomUUID()}`, treasuryAccountId: treasuryId, assetId: nativeAsset, amountBaseUnits: parseEther("5").toString(), destination, purpose: "Too large" } });
    await runtime!.worker.drain();
    const rejected = await app!.inject({ method: "GET", url: `/v1/agent/intents/${overLimit.json().data.id}`, headers: bearer(agentToken) });
    expect(rejected.json().data.intent.status).toBe("rejected");

    // Two wallet-signed approvals reach the policy's quorum.
    const pending = await app!.inject({ method: "GET", url: `/v1/intents/${intentId}`, headers: bearer(token) });
    expect(pending.json().data.intent.status).toBe("approval_required");
    expect(pending.json().data.approval.requiredApprovals).toBe(2);
    for (const [account, sessionToken] of [[owner, token], [approver, approverSession.session.token]] as const) {
      const messageResponse = await app!.inject({ method: "GET", url: `/v1/intents/${intentId}/approval-message/approved`, headers: bearer(sessionToken) });
      expect(messageResponse.statusCode).toBe(200);
      const { message, expectedIntentVersion, compiledHash, simulationHash } = messageResponse.json().data;
      const bad = await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { expectedIntentVersion, compiledHash, simulationHash, signature: await privateKeyToAccount(generatePrivateKey()).signMessage({ message }) } });
      expect(bad.statusCode).toBe(401);
      const good = await app!.inject({ method: "POST", url: `/v1/intents/${intentId}/approve`, headers: bearer(sessionToken), payload: { expectedIntentVersion, compiledHash, simulationHash, signature: await account.signMessage({ message }) } });
      expect(good.statusCode).toBe(202);
    }
    let status = "";
    for (let attempt = 0; attempt < 40 && status !== "reconciled"; attempt += 1) {
      await runtime!.worker.drain();
      status = (await app!.inject({ method: "GET", url: `/v1/intents/${intentId}`, headers: bearer(token) })).json().data.intent.status;
      if (status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(status).toBe("reconciled");
    expect(BigInt(await anvil("eth_getBalance", [destination, "latest"]) as string)).toBe(parseEther("1"));
    const ledger = await app!.inject({ method: "GET", url: "/v1/ledger/entries", headers: bearer(token) });
    expect(ledger.json().data.some((entry: { accountCode: string }) => entry.accountCode === "fee_expense")).toBe(true);
    const audit = await app!.inject({ method: "GET", url: "/v1/audit", headers: bearer(approverSession.session.token) });
    expect(audit.json().data.some((event: { action: string }) => event.action === "intent.approved")).toBe(true);

    // Freeze the organisation: agent submissions and approvals stop; revoke the key: agent is locked out.
    expect((await app!.inject({ method: "PATCH", url: "/v1/organization", headers: bearer(token), payload: { frozen: true } })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: "/v1/agent/capabilities", headers: bearer(agentToken) })).statusCode).toBe(401);
    expect((await app!.inject({ method: "PATCH", url: "/v1/organization", headers: bearer(token), payload: { frozen: false } })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: "/v1/agent/capabilities", headers: bearer(agentToken) })).statusCode).toBe(200);
    const keyId = credential.json().data.keyId as string;
    expect((await app!.inject({ method: "DELETE", url: `/v1/agents/${agentId}/credentials/${keyId}`, headers: bearer(token) })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: "/v1/agent/capabilities", headers: bearer(agentToken) })).statusCode).toBe(401);

    // Sessions: logout revokes; cookie requests need an allowed origin for mutations.
    expect((await app!.inject({ method: "POST", url: "/v1/auth/logout", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: "/v1/organization", headers: bearer(token) })).statusCode).toBe(401);
    const again = await signIn(owner);
    const cookie = `relay_session=${again.session.token}`;
    expect((await app!.inject({ method: "GET", url: "/v1/organization", headers: { cookie } })).statusCode).toBe(200);
    expect((await app!.inject({ method: "PATCH", url: "/v1/organization", headers: { cookie, origin: "https://evil.example" }, payload: { name: "x" } })).statusCode).toBe(403);
    expect((await app!.inject({ method: "PATCH", url: "/v1/organization", headers: { cookie, origin: uri }, payload: { name: "Renamed" } })).statusCode).toBe(200);
  }, 120_000);

  testIf("health reports what is configured, not what is hoped", async () => {
    const health = await app!.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().integrations.squads).toBe("not_configured");
    expect(health.json().integrations.safe).toBe("e2e_local");
    expect(health.json().integrations.evm).toContain("rpc_reachable");
    expect(health.json().integrations.solana).toBe("not_configured");
  });
});
