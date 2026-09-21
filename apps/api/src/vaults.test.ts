import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { createPostgresJobQueue, createPostgresStore } from "@ai-neobank/database";
import { deploySafeProtocolFixture, type SafeContractAddresses } from "@ai-neobank/safe-adapter";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const evmRpc = process.env.EVM_RPC_URL;
const enabled = process.env.RUN_API_INTEGRATION === "1" && databaseUrl && evmRpc;
const testIf = enabled ? it : it.skip;
const masterKey = new Uint8Array(32).fill(11);
const evmNetwork = "eip155:31337" as const;
const domain = "relay.test";
const uri = "http://relay.test";
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil's default funded account

let contracts: SafeContractAddresses | undefined;
let app: ReturnType<typeof buildApp> | null = null;

beforeAll(async () => {
  if (!enabled) return;
  contracts = await deploySafeProtocolFixture(evmRpc!, 31337, deployerKey);
  app = buildApp({
    store: createPostgresStore(databaseUrl!),
    queue: createPostgresJobQueue(databaseUrl!),
    environment: "development",
    auth: { domain, uri },
    webOrigin: uri,
    signerMasterKey: masterKey,
    allowSoftwareSigners: true,
    chains: { evm: { rpcUrl: evmRpc!, chainId: 31337, network: evmNetwork, safeContracts: contracts } },
    logger: false
  });
  await app.ready();
}, 120_000);
afterAll(async () => { await app?.close(); });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.EVM_RPC_URL ?? ""] } } });

async function anvil(method: string, params: unknown[]) {
  const response = await fetch(evmRpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json() as { result: unknown }).result;
}

async function signIn(account: PrivateKeyAccount, organizationId?: string) {
  const challenge = await app!.inject({ method: "POST", url: "/v1/auth/challenges", payload: { chainFamily: "evm", address: account.address, chainReference: "31337" } });
  expect(challenge.statusCode).toBe(201);
  const { nonce, message } = challenge.json().data as { nonce: string; message: string };
  const verify = await app!.inject({ method: "POST", url: "/v1/auth/verify", payload: { chainFamily: "evm", address: account.address, nonce, signature: await account.signMessage({ message }), organizationId } });
  expect(verify.statusCode).toBe(200);
  return verify.json().data as { session: { token: string }; organization: { id: string }; principal: { id: string; role: string } };
}

describe("verification gates the restricted parts of the console", () => {
  testIf("an unstarted organisation is locked, a recorded decision unlocks the gate, and cards still have no issuer behind them", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const session = await signIn(owner);
    const token = session.session.token;

    // Nothing has been started, and the console is told exactly that.
    const unstarted = await app!.inject({ method: "GET", url: "/v1/verification", headers: bearer(token) });
    expect(unstarted.statusCode).toBe(200);
    expect(unstarted.json().data).toMatchObject({ status: "unstarted", provider: null, method: null, decidedAt: null, decidedBy: null });
    expect(unstarted.json().data.banner.providerConnected).toBe(false);
    expect(unstarted.json().data.capabilities.cards).toMatchObject({ allowed: false, code: "verification_required" });

    // The cards route answers rather than failing, and it invents nothing.
    const locked = await app!.inject({ method: "GET", url: "/v1/cards", headers: bearer(token) });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().data).toMatchObject({ provider: null, cards: [] });
    expect(locked.json().data.capability).toMatchObject({ allowed: false, code: "verification_required" });
    expect((await app!.inject({ method: "POST", url: "/v1/cards", headers: bearer(token), payload: {} })).statusCode).toBe(403);

    // There is no edge into a decided state from an unstarted case.
    const skipped = await app!.inject({ method: "POST", url: "/v1/verification/decision", headers: bearer(token), payload: { status: "verified", reason: "Checked by hand" } });
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json().error).toBe("verification_transition_not_allowed");

    const started = await app!.inject({ method: "POST", url: "/v1/verification", headers: bearer(token), payload: {} });
    expect(started.statusCode).toBe(201);
    expect(started.json().data.status).toBe("started");

    // Identity data is refused at the boundary, so it is never stored.
    const withDocumentNumber = await app!.inject({ method: "POST", url: "/v1/verification/decision", headers: bearer(token), payload: { status: "verified", reason: "Passport 1234567890 checked" } });
    expect(withDocumentNumber.statusCode).toBe(400);
    const withExtraField = await app!.inject({ method: "POST", url: "/v1/verification/decision", headers: bearer(token), payload: { status: "verified", reason: "Checked by hand", documentImage: "data:image/png;base64,AAAA" } });
    expect(withExtraField.statusCode).toBe(400);

    // Only an owner records a decision.
    const approver = privateKeyToAccount(generatePrivateKey());
    expect((await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Second signer", role: "approver", wallet: { chainFamily: "evm", address: approver.address } } })).statusCode).toBe(201);
    const approverSession = await signIn(approver, session.organization.id);
    expect((await app!.inject({ method: "POST", url: "/v1/verification/decision", headers: bearer(approverSession.session.token), payload: { status: "verified", reason: "Checked by hand" } })).statusCode).toBe(403);

    const decided = await app!.inject({ method: "POST", url: "/v1/verification/decision", headers: bearer(token), payload: { status: "verified", reason: "Checked by hand against the register" } });
    expect(decided.statusCode).toBe(200);
    // A person decided it, and the record says so: no provider decided anything.
    expect(decided.json().data).toMatchObject({ status: "verified", method: "manual", provider: null, decidedBy: session.principal.id });
    expect(decided.json().data.decidedAt).not.toBeNull();

    // Verified, and still nothing to show: the issuer is the thing that is missing now.
    const verified = await app!.inject({ method: "GET", url: "/v1/cards", headers: bearer(token) });
    expect(verified.json().data).toMatchObject({ provider: null, cards: [] });
    expect(verified.json().data.capability).toMatchObject({ allowed: false, code: "provider_not_connected" });
    const ordered = await app!.inject({ method: "POST", url: "/v1/cards", headers: bearer(token), payload: {} });
    expect(ordered.statusCode).toBe(503);
    expect(ordered.json().error).toBe("provider_not_connected");
  }, 120_000);
});

describe("creating a vault from the console", () => {
  testIf("Relay prepares it, the owner's wallet deploys it, and it is recorded only once the chain agrees", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const second = privateKeyToAccount(generatePrivateKey());
    await anvil("anvil_setBalance", [owner.address, "0x56bc75e2d63100000"]);
    const session = await signIn(owner);
    const token = session.session.token;
    expect((await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Second signer", role: "approver", wallet: { chainFamily: "evm", address: second.address } } })).statusCode).toBe(201);

    const executor = (await app!.inject({ method: "POST", url: "/v1/signers", headers: bearer(token), payload: { chainFamily: "evm" } })).json().data as { id: string; address: string };
    const owners = [owner.address, second.address];

    // A key that could both submit and approve is refused before anything is deployed.
    const conflicted = await app!.inject({ method: "POST", url: "/v1/vaults/prepare", headers: bearer(token), payload: { governance: "safe", network: evmNetwork, owners: [...owners, executor.address], threshold: 2, executorSignerId: executor.id } });
    expect(conflicted.statusCode).toBe(422);
    expect(conflicted.json().problems).toContain("executor_must_not_be_an_owner");

    const prepared = await app!.inject({ method: "POST", url: "/v1/vaults/prepare", headers: bearer(token), payload: { governance: "safe", network: evmNetwork, owners, threshold: 2, executorSignerId: executor.id } });
    expect(prepared.statusCode).toBe(200);
    const plan = prepared.json().data as { predictedAddress: string; saltNonce: string; transaction: { to: string; data: string; value: string } };

    const statusUrl = `/v1/vaults/status?governance=safe&network=${encodeURIComponent(evmNetwork)}&address=${plan.predictedAddress}`;
    const before = await app!.inject({ method: "GET", url: statusUrl, headers: bearer(token) });
    expect(before.json().data).toMatchObject({ deployed: false, observed: null, treasury: null });

    // Nothing is recorded until the vault exists.
    const early = await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(token), payload: { name: "Ops", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 2, saltNonce: plan.saltNonce } });
    expect(early.statusCode).toBe(422);
    expect(early.json().error).toBe("safe_not_found_on_chain");

    // The owner's own wallet deploys it. Relay never sends this transaction.
    const publicClient = createPublicClient({ chain, transport: http(evmRpc) });
    const wallet = createWalletClient({ account: owner, chain, transport: http(evmRpc) });
    const hash = await wallet.sendTransaction({ account: owner, to: plan.transaction.to as Address, data: plan.transaction.data as Hex, value: BigInt(plan.transaction.value) });
    expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");

    const after = await app!.inject({ method: "GET", url: statusUrl, headers: bearer(token) });
    expect(after.json().data).toMatchObject({ deployed: true, treasury: null });
    expect(after.json().data.observed).toMatchObject({ governance: "safe", threshold: 2 });

    // What is recorded has to be what the chain shows, checked two ways.
    const wrongSalt = await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(token), payload: { name: "Ops", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 1, saltNonce: plan.saltNonce } });
    expect(wrongSalt.statusCode).toBe(422);
    expect(wrongSalt.json().error).toBe("vault_address_does_not_match_plan");
    const wrongThreshold = await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(token), payload: { name: "Ops", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 1 } });
    expect(wrongThreshold.statusCode).toBe(422);
    expect(wrongThreshold.json().error).toBe("threshold_does_not_match_plan");

    // Somebody who is not an owner of this Safe cannot record it either.
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await app!.inject({ method: "POST", url: "/v1/members", headers: bearer(token), payload: { displayName: "Not an owner", role: "owner", wallet: { chainFamily: "evm", address: stranger.address } } })).statusCode).toBe(201);
    const strangerSession = await signIn(stranger, session.organization.id);
    const refused = await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(strangerSession.session.token), payload: { name: "Ops", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 2, saltNonce: plan.saltNonce } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("registering_wallet_is_not_an_owner");

    const recorded = await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(token), payload: { name: "Ops", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 2, saltNonce: plan.saltNonce } });
    expect(recorded.statusCode).toBe(201);
    const treasury = recorded.json().data as { id: string; governance: string };
    expect(treasury.governance).toBe("safe");
    expect(recorded.json().data.observedConfiguration).toMatchObject({ threshold: 2 });
    expect((await app!.inject({ method: "POST", url: "/v1/vaults", headers: bearer(token), payload: { name: "Ops again", governance: "safe", network: evmNetwork, address: plan.predictedAddress, executorSignerId: executor.id, owners, threshold: 2, saltNonce: plan.saltNonce } })).json().error).toBe("vault_already_registered");

    const listed = await app!.inject({ method: "GET", url: statusUrl, headers: bearer(token) });
    expect(listed.json().data.treasury).toMatchObject({ id: treasury.id, governance: "safe" });

    // A Safe has no time lock of its own, and Relay says so rather than inventing one.
    const lock = await app!.inject({ method: "GET", url: `/v1/treasuries/${treasury.id}/time-lock`, headers: bearer(token) });
    expect(lock.statusCode).toBe(200);
    expect(lock.json().data).toMatchObject({ governance: "safe", source: "none", seconds: 0, enforcedOnChain: false, changeable: false });
    expect(lock.json().data.evidence.source).toBe("chain");
    const setLock = await app!.inject({ method: "POST", url: `/v1/treasuries/${treasury.id}/time-lock`, headers: bearer(token), payload: { seconds: 3600 } });
    expect(setLock.statusCode).toBe(422);
    expect(setLock.json().error).toBe("safe_time_lock_unavailable");

    // The rejection route is mounted and scoped to this organisation's payments.
    const unknownIntent = await app!.inject({ method: "GET", url: "/v1/intents/00000000-0000-4000-8000-000000000000/rejection-transaction", headers: bearer(token) });
    expect(unknownIntent.statusCode).toBe(404);
    expect(unknownIntent.json().error).toBe("intent_not_found");
    expect((await app!.inject({ method: "GET", url: "/v1/intents/00000000-0000-4000-8000-000000000000/rejection-transaction" })).statusCode).toBe(401);
  }, 180_000);
});
