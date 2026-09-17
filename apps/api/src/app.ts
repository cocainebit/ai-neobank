import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { ApprovalError, type PostgresControlPlaneStore, type PostgresJobQueue, type SessionRecord } from "@ai-neobank/database";
import { paymentIntentSchema, policyDefinitionSchema, spendingPolicySchema, tokenAssetId, type PrincipalRole } from "@ai-neobank/domain";
import { evaluatePaymentIntent } from "@ai-neobank/policy";
import { encryptSecret, exportDevelopmentSecret, generateSigner } from "@ai-neobank/signer";
import {
  buildApprovalMessage,
  buildSignInMessage,
  canonicalAddress,
  generateAgentKey,
  generateNonce,
  generateSessionToken,
  hashToken,
  isAgentToken,
  parseAgentToken,
  tokensMatch,
  verifySignIn,
  verifyWalletSignature
} from "@ai-neobank/auth";
import { EvmAdapter } from "@ai-neobank/evm-adapter";
import { SolanaAdapter } from "@ai-neobank/solana-adapter";
import type { ResolvedAsset } from "@ai-neobank/chain-core";
import { z } from "zod";

export interface AppOptions {
  store: PostgresControlPlaneStore;
  queue?: PostgresJobQueue;
  environment: "development" | "test" | "production";
  auth: { domain: string; uri: string; sessionTtlSeconds?: number; secureCookies?: boolean };
  /** Browser origin allowed to call with cookies. */
  webOrigin?: string;
  signerMasterKey?: Uint8Array;
  allowSoftwareSigners?: boolean;
  chains?: {
    evm?: { network: `eip155:${number}`; chainId: number; rpcUrl: string; confirmations?: number };
    solana?: { network: `solana:${string}`; rpcUrl: string; finality?: "confirmed" | "finalized" };
  };
  logger?: boolean;
}

type HumanAuth = { kind: "human"; organizationId: string; principalId: string; role: PrincipalRole; sessionId: string; walletId: string | null; tokenHash: string; viaCookie: boolean };
type AgentAuth = { kind: "agent"; organizationId: string; principalId: string; agentId: string; credentialId: string };
type Auth = HumanAuth | AgentAuth;

declare module "fastify" {
  interface FastifyRequest { auth?: Auth }
}

const cookieName = "relay_session";
const uuid = z.string().uuid();
const chainFamily = z.enum(["evm", "svm"]);
const humanRoles = z.enum(["owner", "approver", "operator", "auditor", "developer"]);

const challengeSchema = z.object({ chainFamily, address: z.string().min(20), chainReference: z.string().min(1).max(64).optional() });
const verifySchema = z.object({ chainFamily, address: z.string().min(20), nonce: z.string().min(8), signature: z.string().min(16), organizationId: uuid.optional() });
const switchSchema = z.object({ organizationId: uuid });
const organizationPatchSchema = z.object({ name: z.string().min(1).max(120).optional(), frozen: z.boolean().optional(), autonomousExecution: z.boolean().optional() });
const memberSchema = z.object({ displayName: z.string().min(1).max(80), role: humanRoles, wallet: z.object({ chainFamily, address: z.string().min(20) }) });
const memberStatusSchema = z.object({ status: z.enum(["active", "frozen", "revoked"]) });
const agentSchema = z.object({ displayName: z.string().min(1).max(80), purpose: z.string().min(3).max(280) });
const agentStatusSchema = z.object({ status: z.enum(["active", "frozen", "revoked"]) });
const credentialSchema = z.object({ label: z.string().min(1).max(80).optional() });
const policySchema = z.object({ name: z.string().min(1).max(80), definition: policyDefinitionSchema });
const policyVersionSchema = z.object({ definition: policyDefinitionSchema });
const bindingSchema = z.object({ agentId: uuid.optional(), treasuryAccountId: uuid.optional() }).refine((value) => !value.agentId !== !value.treasuryAccountId, "Bind to exactly one of agentId or treasuryAccountId");
const treasurySchema = z.object({
  name: z.string().min(1).max(80),
  chainFamily,
  network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/),
  address: z.string().min(20),
  governance: z.enum(["safe", "squads", "direct"])
}).superRefine((value, context) => {
  if (value.chainFamily === "evm" && !value.network.startsWith("eip155:")) context.addIssue({ code: "custom", message: "EVM treasury requires an eip155 network" });
  if (value.chainFamily === "svm" && !value.network.startsWith("solana:")) context.addIssue({ code: "custom", message: "Solana treasury requires a solana network" });
  if (value.chainFamily === "evm" && value.governance === "squads") context.addIssue({ code: "custom", message: "Squads is only valid for Solana" });
  if (value.chainFamily === "svm" && value.governance === "safe") context.addIssue({ code: "custom", message: "Safe is only valid for EVM" });
});
const treasuryStatusSchema = z.object({ status: z.enum(["active", "frozen"]) });
const assetSchema = z.object({ network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/), kind: z.enum(["erc20", "spl"]), address: z.string().min(20), symbol: z.string().min(1).max(16) });
const signerSchema = z.object({ chainFamily, agentId: uuid.optional(), revealDevelopmentSecret: z.boolean().default(false) });
const signerStatusSchema = z.object({ status: z.enum(["active", "frozen", "revoked"]) });
const intentInputSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  treasuryAccountId: uuid,
  kind: z.enum(["transfer", "x402"]).default("transfer"),
  assetId: z.string().min(1),
  amountBaseUnits: z.string().regex(/^\d+$/),
  destination: z.string().min(1),
  purpose: z.string().min(3).max(280),
  expiresAt: z.string().datetime().optional()
});
const decisionSchema = z.object({
  expectedIntentVersion: z.number().int().positive(),
  compiledHash: z.string().regex(/^[a-f0-9]{64}$/),
  simulationHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(16).max(8192).optional()
});
const evaluateSchema = z.object({ intent: paymentIntentSchema, policy: spendingPolicySchema, spentTodayBaseUnits: z.string().regex(/^\d+$/) });

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? true });
  const { store, queue } = options;
  const sessionTtl = options.auth.sessionTtlSeconds ?? 12 * 60 * 60;
  const allowedOrigins = new Set([options.webOrigin, options.auth.uri].filter((value): value is string => Boolean(value)).map((value) => new URL(value).origin));

  void app.register(cookie);
  void app.register(cors, { origin: options.webOrigin ? [options.webOrigin] : false, credentials: true });
  app.addHook("onClose", async () => { await store.close(); await queue?.close(); });

  const evmAdapter = options.chains?.evm ? new EvmAdapter(options.chains.evm) : null;
  const solanaAdapter = options.chains?.solana ? new SolanaAdapter(options.chains.solana) : null;
  const adapterFor = (family: "evm" | "svm", network: string) => {
    const adapter = family === "evm" ? evmAdapter : solanaAdapter;
    if (!adapter || adapter.network !== network) return null;
    return adapter;
  };
  const chainReference = (family: "evm" | "svm") => family === "evm"
    ? String(options.chains?.evm?.chainId ?? 1)
    : (options.chains?.solana?.network.split(":")[1] ?? "mainnet");

  // Authentication

  app.decorateRequest("auth", undefined);
  app.addHook("preHandler", async (request) => {
    const header = request.headers.authorization;
    let token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    let viaCookie = false;
    if (!token && request.cookies[cookieName]) { token = request.cookies[cookieName]; viaCookie = true; }
    if (!token) return;
    if (isAgentToken(token)) {
      const parsed = parseAgentToken(token);
      if (!parsed) return;
      const credential = await store.findAgentCredential(parsed.keyId);
      if (!credential || credential.status !== "active" || !tokensMatch(credential.secretHash, hashToken(parsed.secret))) return;
      if (credential.agentStatus !== "active" || credential.organizationFrozen) return;
      await store.touchAgentCredential(credential.id);
      request.auth = { kind: "agent", organizationId: credential.organizationId, principalId: credential.principalId, agentId: credential.agentId, credentialId: credential.id };
      return;
    }
    const tokenHash = hashToken(token);
    const session = await store.getSession(tokenHash);
    if (!session || session.principalStatus !== "active") return;
    request.auth = { kind: "human", organizationId: session.organizationId, principalId: session.principalId, role: session.role, sessionId: session.sessionId, walletId: session.walletId, tokenHash, viaCookie };
  });

  function human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanAuth | null {
    const auth = request.auth;
    if (!auth || auth.kind !== "human") { void reply.code(401).send({ error: "unauthenticated" }); return null; }
    if (auth.viaCookie && request.method !== "GET") {
      const origin = request.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) { void reply.code(403).send({ error: "origin_not_allowed" }); return null; }
    }
    if (roles && !roles.includes(auth.role)) { void reply.code(403).send({ error: "forbidden", required: roles }); return null; }
    return auth;
  }

  function agent(request: FastifyRequest, reply: FastifyReply): AgentAuth | null {
    const auth = request.auth;
    if (!auth || auth.kind !== "agent") { void reply.code(401).send({ error: "agent_unauthenticated" }); return null; }
    return auth;
  }

  async function frozenGuard(reply: FastifyReply, organizationId: string): Promise<boolean> {
    const organization = await store.getOrganization(organizationId);
    if (organization?.frozen) { void reply.code(423).send({ error: "organization_frozen" }); return true; }
    return false;
  }

  function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
    void reply.setCookie(cookieName, token, { path: "/", httpOnly: true, sameSite: "lax", secure: options.auth.secureCookies ?? options.environment === "production", expires });
  }

  async function issueSession(reply: FastifyReply, membership: { organizationId: string; principalId: string; walletId: string | null }) {
    const token = generateSessionToken();
    const expires = new Date(Date.now() + sessionTtl * 1000);
    await store.createSession({ organizationId: membership.organizationId, principalId: membership.principalId, walletId: membership.walletId, tokenHash: hashToken(token), expiresAt: expires });
    setSessionCookie(reply, token, expires);
    return { token, expiresAt: expires.toISOString() };
  }

  // Health

  app.get("/health", async (_request, reply) => {
    const database = await store.health().catch(() => false);
    const [evmHealth, solanaHealth] = await Promise.all([
      evmAdapter ? evmAdapter.health().then((health) => (health.ok ? `rpc_reachable:${health.network}` : "chain_id_mismatch")).catch(() => "rpc_unreachable") : "not_configured",
      solanaAdapter ? solanaAdapter.health().then((health) => `rpc_reachable:${health.network}`).catch(() => "rpc_unreachable") : "not_configured"
    ]);
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "degraded",
      service: "api",
      environment: options.environment,
      database: database ? "ready" : "unavailable",
      integrations: {
        evm: evmHealth,
        solana: solanaHealth,
        directExecution: "e2e_local",
        safe: "adapter_standalone_not_wired",
        squads: "not_implemented",
        x402: "not_implemented",
        softwareSigners: options.allowSoftwareSigners && options.signerMasterKey ? "enabled_development_only" : "disabled"
      }
    });
  });

  // Auth routes

  app.post("/v1/auth/challenges", async (request, reply) => {
    const body = challengeSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    let address: string;
    try { address = canonicalAddress(body.data.chainFamily, body.data.address); } catch { return invalid(reply, "Invalid address"); }
    const nonce = generateNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
    const message = buildSignInMessage({ chainFamily: body.data.chainFamily, address, domain: options.auth.domain, uri: options.auth.uri, nonce, issuedAt, expiresAt, chainReference: body.data.chainReference ?? chainReference(body.data.chainFamily) });
    await store.createChallenge({ nonce, chainFamily: body.data.chainFamily, address, domain: options.auth.domain, message, expiresAt: expiresAt.toISOString() });
    return reply.code(201).send({ data: { nonce, message, expiresAt: expiresAt.toISOString() } });
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const body = verifySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const challenge = await store.consumeChallenge(body.data.nonce);
    if (!challenge) return reply.code(401).send({ error: "challenge_invalid" });
    let address: string;
    try { address = canonicalAddress(body.data.chainFamily, body.data.address); } catch { return invalid(reply, "Invalid address"); }
    if (challenge.chainFamily !== body.data.chainFamily || challenge.address !== address) return reply.code(401).send({ error: "challenge_mismatch" });
    const verified = await verifySignIn({ chainFamily: body.data.chainFamily, address, message: challenge.message, signature: body.data.signature, domain: options.auth.domain, nonce: body.data.nonce });
    if (!verified.ok) return reply.code(401).send({ error: "signature_invalid", reason: verified.reason });
    let memberships = await store.findMemberships(body.data.chainFamily, address);
    if (memberships.length === 0) {
      const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
      memberships = [await store.bootstrapOwner({ chainFamily: body.data.chainFamily, address, displayName: short, organizationName: `${short} workspace`, slug: `org-${generateNonce().slice(0, 12)}` })];
    }
    const active = memberships.filter((membership) => membership.principalStatus === "active");
    if (active.length === 0) return reply.code(403).send({ error: "no_active_membership" });
    const chosen = (body.data.organizationId && active.find((membership) => membership.organizationId === body.data.organizationId)) || active[0]!;
    const session = await issueSession(reply, chosen);
    return reply.code(200).send({ data: { session, principal: { id: chosen.principalId, role: chosen.role, displayName: chosen.displayName }, organization: { id: chosen.organizationId, name: chosen.organizationName, slug: chosen.organizationSlug }, memberships: active.map((membership) => ({ organizationId: membership.organizationId, organizationName: membership.organizationName, role: membership.role })) } });
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const auth = request.auth;
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    const organization = await store.getOrganization(auth.organizationId);
    if (auth.kind === "agent") return { data: { kind: "agent", organization, agentId: auth.agentId, principalId: auth.principalId } };
    const members = await store.listMembers(auth.organizationId);
    const me = members.find((member) => member.id === auth.principalId);
    const wallet = me?.wallets.find((candidate) => candidate.id === auth.walletId) ?? me?.wallets[0] ?? null;
    const memberships = wallet ? await store.findMemberships(wallet.chainFamily, wallet.address) : [];
    return { data: { kind: "human", organization, principal: me ? { id: me.id, role: me.role, displayName: me.displayName, status: me.status } : null, wallet, memberships: memberships.map((membership) => ({ organizationId: membership.organizationId, organizationName: membership.organizationName, role: membership.role })) } };
  });

  app.post("/v1/auth/switch", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const body = switchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const members = await store.listMembers(auth.organizationId);
    const wallet = members.find((member) => member.id === auth.principalId)?.wallets.find((candidate) => candidate.id === auth.walletId);
    if (!wallet) return reply.code(403).send({ error: "no_wallet_bound" });
    const target = (await store.findMemberships(wallet.chainFamily, wallet.address)).find((membership) => membership.organizationId === body.data.organizationId && membership.principalStatus === "active");
    if (!target) return reply.code(403).send({ error: "not_a_member" });
    await store.revokeSession(auth.tokenHash);
    const session = await issueSession(reply, target);
    return { data: { session, organization: { id: target.organizationId, name: target.organizationName }, principal: { id: target.principalId, role: target.role } } };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    await store.revokeSession(auth.tokenHash);
    void reply.clearCookie(cookieName, { path: "/" });
    return { data: { ok: true } };
  });

  // Organisation and members

  app.get("/v1/organization", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.getOrganization(auth.organizationId) };
  });

  app.patch("/v1/organization", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = organizationPatchSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const patch = Object.fromEntries(Object.entries(body.data).filter(([, value]) => value !== undefined)) as { name?: string; frozen?: boolean; autonomousExecution?: boolean };
    return { data: await store.updateOrganization(auth.organizationId, patch, auth.principalId) };
  });

  app.get("/v1/members", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.listMembers(auth.organizationId) };
  });

  app.post("/v1/members", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = memberSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    let address: string;
    try { address = canonicalAddress(body.data.wallet.chainFamily, body.data.wallet.address); } catch { return invalid(reply, "Invalid wallet address"); }
    try {
      const member = await store.addMember(auth.organizationId, { displayName: body.data.displayName, role: body.data.role, wallet: { chainFamily: body.data.wallet.chainFamily, address } }, auth.principalId);
      return reply.code(201).send({ data: member });
    } catch (error) {
      if (error instanceof Error && error.message.includes("human_wallets_organization_id_chain_family_address_key")) return reply.code(409).send({ error: "wallet_already_member" });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/members/:id", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = memberStatusSchema.safeParse(request.body);
    const id = uuid.safeParse(request.params.id);
    if (!body.success || !id.success) return invalid(reply, "Invalid member or status");
    if (id.data === auth.principalId && body.data.status !== "active") return reply.code(409).send({ error: "cannot_disable_self" });
    const member = await store.setPrincipalStatus(auth.organizationId, id.data, body.data.status, auth.principalId);
    if (!member) return reply.code(404).send({ error: "member_not_found" });
    return { data: member };
  });

  // Agents and credentials

  app.get("/v1/agents", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.listAgents(auth.organizationId) };
  });

  app.post("/v1/agents", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    const body = agentSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const created = await store.createAgent(auth.organizationId, { displayName: body.data.displayName, purpose: body.data.purpose, ownerPrincipalId: auth.principalId }, auth.principalId);
    return reply.code(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/v1/agents/:id/status", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = agentStatusSchema.safeParse(request.body);
    const id = uuid.safeParse(request.params.id);
    if (!body.success || !id.success) return invalid(reply, "Invalid agent ID or status");
    const updated = await store.setAgentStatus(auth.organizationId, id.data, body.data.status, auth.principalId);
    if (!updated) return reply.code(404).send({ error: "agent_not_found" });
    return { data: updated };
  });

  app.get<{ Params: { id: string } }>("/v1/agents/:id/credentials", async (request, reply) => {
    const auth = human(request, reply, ["owner", "developer"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid agent ID");
    return { data: await store.listAgentCredentials(auth.organizationId, id.data) };
  });

  app.post<{ Params: { id: string } }>("/v1/agents/:id/credentials", async (request, reply) => {
    const auth = human(request, reply, ["owner", "developer"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = credentialSchema.safeParse(request.body ?? {});
    if (!id.success || !body.success) return invalid(reply, "Invalid agent ID or label");
    const target = await store.getAgent(auth.organizationId, id.data);
    if (!target) return reply.code(404).send({ error: "agent_not_found" });
    if (target.status === "revoked") return reply.code(409).send({ error: "agent_revoked" });
    const key = generateAgentKey();
    const credential = await store.createAgentCredential(auth.organizationId, id.data, { keyId: key.keyId, secretHash: hashToken(key.secret), ...(body.data.label ? { label: body.data.label } : {}), createdBy: auth.principalId });
    return reply.code(201).send({ data: credential, token: key.token, warning: "Shown once. Give it to the agent runtime; never to a model prompt." });
  });

  app.delete<{ Params: { id: string; keyId: string } }>("/v1/agents/:id/credentials/:keyId", async (request, reply) => {
    const auth = human(request, reply, ["owner", "developer"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid agent ID");
    const revoked = await store.revokeAgentCredential(auth.organizationId, id.data, request.params.keyId, auth.principalId);
    if (!revoked) return reply.code(404).send({ error: "credential_not_found" });
    return { data: { ok: true } };
  });

  // Policies

  app.get("/v1/policies", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.listPolicies(auth.organizationId) };
  });

  app.post("/v1/policies", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = policySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    return reply.code(201).send({ data: await store.createPolicy(auth.organizationId, { name: body.data.name, definition: body.data.definition, createdBy: auth.principalId }) });
  });

  app.post<{ Params: { id: string } }>("/v1/policies/:id/versions", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = policyVersionSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid policy ID or definition");
    const updated = await store.addPolicyVersion(auth.organizationId, id.data, body.data.definition, auth.principalId);
    if (!updated) return reply.code(404).send({ error: "policy_not_found" });
    return reply.code(201).send({ data: updated });
  });

  app.post<{ Params: { id: string } }>("/v1/policies/:id/bindings", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = bindingSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid policy ID or binding");
    const bound = await store.bindPolicy(auth.organizationId, { policyId: id.data, ...(body.data.agentId ? { agentId: body.data.agentId } : {}), ...(body.data.treasuryAccountId ? { treasuryAccountId: body.data.treasuryAccountId } : {}) }, auth.principalId);
    if (!bound) return reply.code(404).send({ error: "policy_not_found" });
    return reply.code(201).send({ data: bound });
  });

  // Treasuries and assets

  app.get("/v1/treasuries", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.listTreasuries(auth.organizationId) };
  });

  app.post("/v1/treasuries", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = treasurySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    let address: string;
    try { address = canonicalAddress(body.data.chainFamily, body.data.address); } catch { return invalid(reply, "Invalid treasury address"); }
    await store.ensureNativeAsset(body.data.network, body.data.chainFamily);
    const created = await store.createTreasury(auth.organizationId, { ...body.data, address }, auth.principalId);
    return reply.code(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/v1/treasuries/:id/status", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = treasuryStatusSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid treasury ID or status");
    const updated = await store.setTreasuryStatus(auth.organizationId, id.data, body.data.status, auth.principalId);
    if (!updated) return reply.code(404).send({ error: "treasury_not_found" });
    return { data: updated };
  });

  app.get<{ Params: { id: string } }>("/v1/treasuries/:id/balances", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid treasury ID");
    const treasury = await store.getTreasury(auth.organizationId, id.data);
    if (!treasury) return reply.code(404).send({ error: "treasury_not_found" });
    const adapter = adapterFor(treasury.chainFamily, treasury.network);
    if (!adapter) return reply.code(503).send({ error: "network_not_configured", network: treasury.network });
    const assets = await store.listAssets(treasury.network);
    const balances = await Promise.all(assets.map(async (asset) => {
      const resolved: ResolvedAsset = asset.kind === "native" ? { kind: "native", decimals: asset.decimals } : asset.kind === "erc20" ? { kind: "erc20", address: asset.address ?? "", decimals: asset.decimals } : { kind: "spl", mint: asset.address ?? "", decimals: asset.decimals };
      const balance = await adapter.getBalance(treasury.address, resolved).catch(() => null);
      return { assetId: asset.id, symbol: asset.symbol, decimals: asset.decimals, kind: asset.kind, balanceBaseUnits: balance?.toString() ?? null, source: "chain" };
    }));
    return { data: { treasury, balances, observedAt: new Date().toISOString() } };
  });

  app.get("/v1/assets", async (request, reply) => {
    const auth = request.auth;
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    const network = z.string().optional().parse((request.query as { network?: string }).network);
    return { data: await store.listAssets(network) };
  });

  app.post("/v1/assets", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = assetSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const family = body.data.kind === "erc20" ? "evm" : "svm";
    const adapter = adapterFor(family, body.data.network);
    if (!adapter) return reply.code(503).send({ error: "network_not_configured", network: body.data.network });
    let address: string;
    try { address = canonicalAddress(family, body.data.address); } catch { return invalid(reply, "Invalid token address"); }
    let decimals: number;
    try {
      decimals = family === "evm" ? await (adapter as EvmAdapter).readTokenDecimals(address) : await (adapter as SolanaAdapter).readMintDecimals(address);
    } catch {
      return reply.code(422).send({ error: "token_not_found_on_chain" });
    }
    const asset = await store.upsertAsset({ id: tokenAssetId(body.data.network, body.data.kind, address), network: body.data.network, chainFamily: family, kind: body.data.kind, address, symbol: body.data.symbol, decimals });
    return reply.code(201).send({ data: asset });
  });

  // Signers (development custody only)

  app.get("/v1/signers", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    return { data: await store.listSigners(auth.organizationId) };
  });

  app.post("/v1/signers", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const body = signerSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    if (options.environment === "production" || !options.allowSoftwareSigners || !options.signerMasterKey) {
      return reply.code(503).send({ error: "software_signers_disabled", message: "Encrypted software signers are a local development harness. Production custody is Safe, Squads, or an HSM/KMS signer." });
    }
    if (body.data.revealDevelopmentSecret && options.environment !== "development") return reply.code(403).send({ error: "secret_export_disabled_outside_development" });
    const generated = generateSigner(body.data.chainFamily);
    const encrypted = encryptSecret(generated.secret, options.signerMasterKey);
    const created = await store.createSigner(auth.organizationId, { ...(body.data.agentId ? { agentId: body.data.agentId } : {}), chainFamily: generated.family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }, auth.principalId);
    const response: Record<string, unknown> = { data: created };
    if (body.data.revealDevelopmentSecret) {
      response.developmentSecret = exportDevelopmentSecret(generated);
      response.warning = "Shown once. Never send this value to an AI model or store it in application logs.";
    }
    generated.secret.fill(0);
    return reply.code(201).send(response);
  });

  app.patch<{ Params: { id: string } }>("/v1/signers/:id/status", async (request, reply) => {
    const auth = human(request, reply, ["owner"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const body = signerStatusSchema.safeParse(request.body);
    if (!id.success || !body.success) return invalid(reply, "Invalid signer ID or status");
    const updated = await store.setSignerStatus(auth.organizationId, id.data, body.data.status, auth.principalId);
    if (!updated) return reply.code(404).send({ error: "signer_not_found" });
    return { data: updated };
  });

  // Intents

  async function submitIntent(reply: FastifyReply, organizationId: string, requesterId: string, body: unknown) {
    const parsed = intentInputSchema.safeParse(body);
    if (!parsed.success) return invalid(reply, parsed.error.flatten());
    const treasury = await store.getTreasury(organizationId, parsed.data.treasuryAccountId);
    if (!treasury) return reply.code(404).send({ error: "treasury_not_found" });
    let destination: string;
    try { destination = canonicalAddress(treasury.chainFamily, parsed.data.destination); } catch { return invalid(reply, "Destination is not a valid address for the treasury's chain"); }
    const intent = paymentIntentSchema.safeParse({
      id: crypto.randomUUID(),
      idempotencyKey: parsed.data.idempotencyKey,
      organizationId,
      treasuryAccountId: treasury.id,
      requesterId,
      network: treasury.network,
      assetId: parsed.data.assetId,
      amountBaseUnits: parsed.data.amountBaseUnits,
      destination,
      purpose: parsed.data.purpose,
      expiresAt: parsed.data.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      kind: parsed.data.kind
    });
    if (!intent.success) return invalid(reply, intent.error.flatten());
    const result = await store.createIntent(intent.data);
    return reply.code(result.created ? 202 : 200).send({ data: result.record, idempotentReplay: !result.created });
  }

  app.get("/v1/intents", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const query = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    return { data: await store.listIntents(auth.organizationId, { ...(query.data.status ? { status: query.data.status } : {}), ...(query.data.limit ? { limit: query.data.limit } : {}) }) };
  });

  app.post("/v1/intents", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    if (await frozenGuard(reply, auth.organizationId)) return;
    return submitIntent(reply, auth.organizationId, auth.principalId, request.body);
  });

  app.get<{ Params: { id: string } }>("/v1/intents/:id", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid intent ID");
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail) return reply.code(404).send({ error: "intent_not_found" });
    return { data: detail };
  });

  app.get<{ Params: { id: string; decision: string } }>("/v1/intents/:id/approval-message/:decision", async (request, reply) => {
    const auth = human(request, reply, ["owner", "approver"]); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    const decision = z.enum(["approved", "rejected"]).safeParse(request.params.decision);
    if (!id.success || !decision.success) return invalid(reply, "Invalid intent ID or decision");
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail?.approval?.compiledHash || !detail.approval.simulationHash) return reply.code(404).send({ error: "approval_not_found" });
    const message = buildApprovalMessage({ domain: options.auth.domain, intentId: id.data, version: detail.intent.version, decision: decision.data, compiledHash: detail.approval.compiledHash, simulationHash: detail.approval.simulationHash });
    return { data: { message, expectedIntentVersion: detail.intent.version, compiledHash: detail.approval.compiledHash, simulationHash: detail.approval.simulationHash } };
  });

  for (const decision of ["approved", "rejected"] as const) {
    const path = decision === "approved" ? "/v1/intents/:id/approve" : "/v1/intents/:id/reject";
    app.post<{ Params: { id: string } }>(path, async (request, reply) => {
      const auth = human(request, reply, ["owner", "approver"]); if (!auth) return;
      const body = decisionSchema.safeParse(request.body);
      const id = uuid.safeParse(request.params.id);
      if (!body.success || !id.success) return invalid(reply, "Invalid approval request");
      let signedPayload: string | undefined;
      if (body.data.signature) {
        const members = await store.listMembers(auth.organizationId);
        const wallet = members.find((member) => member.id === auth.principalId)?.wallets.find((candidate) => candidate.id === auth.walletId);
        if (!wallet) return reply.code(403).send({ error: "no_wallet_bound" });
        const message = buildApprovalMessage({ domain: options.auth.domain, intentId: id.data, version: body.data.expectedIntentVersion, decision, compiledHash: body.data.compiledHash, simulationHash: body.data.simulationHash });
        if (!(await verifyWalletSignature({ chainFamily: wallet.chainFamily, address: wallet.address, message, signature: body.data.signature }))) return reply.code(401).send({ error: "approval_signature_invalid" });
        signedPayload = JSON.stringify({ chainFamily: wallet.chainFamily, address: wallet.address, message, signature: body.data.signature });
      }
      try {
        const result = await store.decideIntent(auth.organizationId, id.data, { principalId: auth.principalId, decision, expectedIntentVersion: body.data.expectedIntentVersion, compiledHash: body.data.compiledHash, simulationHash: body.data.simulationHash, ...(signedPayload ? { signedPayload } : {}) });
        return reply.code(result.idempotentReplay ? 200 : 202).send({ data: result });
      } catch (error) {
        if (!(error instanceof ApprovalError)) throw error;
        const status = error.code === "not_found" ? 404 : error.code === "not_eligible" ? 403 : error.code === "expired" ? 410 : error.code === "frozen" ? 423 : 409;
        return reply.code(status).send({ error: error.code });
      }
    });
  }

  app.post("/v1/intents/evaluate", async (request, reply) => {
    const auth = request.auth;
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = evaluateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.flatten());
    const decision = evaluatePaymentIntent(parsed.data.intent, parsed.data.policy, { spentTodayBaseUnits: parsed.data.spentTodayBaseUnits, now: new Date() });
    return reply.code(decision.outcome === "rejected" ? 422 : 200).send({ intentId: parsed.data.intent.id, policyId: parsed.data.policy.id, policyVersion: parsed.data.policy.version, decision });
  });

  // Agent API

  app.post("/v1/agent/intents", async (request, reply) => {
    const auth = agent(request, reply); if (!auth) return;
    return submitIntent(reply, auth.organizationId, auth.principalId, request.body);
  });

  app.get("/v1/agent/intents", async (request, reply) => {
    const auth = agent(request, reply); if (!auth) return;
    return { data: await store.listIntents(auth.organizationId, { requesterId: auth.principalId }) };
  });

  app.get<{ Params: { id: string } }>("/v1/agent/intents/:id", async (request, reply) => {
    const auth = agent(request, reply); if (!auth) return;
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return invalid(reply, "Invalid intent ID");
    const detail = await store.getIntent(auth.organizationId, id.data);
    if (!detail || detail.intent.requesterId !== auth.principalId) return reply.code(404).send({ error: "intent_not_found" });
    return { data: { intent: detail.intent, events: detail.events, execution: detail.execution, approval: detail.approval ? { status: detail.approval.status, approvals: detail.approval.approvals, requiredApprovals: detail.approval.requiredApprovals, expiresAt: detail.approval.expiresAt } : null } };
  });

  app.get("/v1/agent/capabilities", async (request, reply) => {
    const auth = agent(request, reply); if (!auth) return;
    const [agentRecord, treasuries, policies] = await Promise.all([store.getAgent(auth.organizationId, auth.agentId), store.listTreasuries(auth.organizationId), store.listPolicies(auth.organizationId)]);
    const bound = policies.filter((policy) => policy.bindings.some((binding) => binding.agentId === auth.agentId));
    const networks = [...new Set(treasuries.map((treasury) => treasury.network))];
    const assets = (await Promise.all(networks.map((network) => store.listAssets(network)))).flat();
    return { data: { agent: agentRecord, treasuries: treasuries.filter((treasury) => treasury.status === "active"), policies: bound.map((policy) => ({ id: policy.id, name: policy.name, version: policy.latest.version, definition: policy.latest.definition })), assets } };
  });

  // Ledger, audit, operations

  app.get("/v1/ledger/entries", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const query = z.object({ treasuryAccountId: uuid.optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    return { data: await store.listLedgerEntries(auth.organizationId, { ...(query.data.treasuryAccountId ? { treasuryAccountId: query.data.treasuryAccountId } : {}), ...(query.data.limit ? { limit: query.data.limit } : {}) }) };
  });

  app.get("/v1/ledger/balances", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    return { data: await store.listLedgerBalances(auth.organizationId) };
  });

  app.get("/v1/audit", async (request, reply) => {
    const auth = human(request, reply, ["owner", "auditor", "approver", "operator", "developer"]); if (!auth) return;
    return { data: await store.listAuditEvents(auth.organizationId) };
  });

  app.get("/v1/jobs", async (request, reply) => {
    const auth = human(request, reply, ["owner", "operator"]); if (!auth) return;
    if (!queue) return reply.code(503).send({ error: "queue_not_configured" });
    const query = z.object({ status: z.string().optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, query.error.flatten());
    const jobs = await queue.listJobs({ ...(query.data.status ? { status: query.data.status } : {}) });
    return { data: jobs.filter((job) => job.organizationId === auth.organizationId).map(({ payload, ...job }) => ({ ...job, intentId: payload.intentId ?? null })) };
  });

  return app;
}

export type { SessionRecord };
