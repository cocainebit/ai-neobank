import Fastify from "fastify";
import cors from "@fastify/cors";
import { ApprovalError, MemoryControlPlaneStore, type ControlPlaneStore } from "@ai-neobank/database";
import { paymentIntentSchema, spendingPolicySchema } from "@ai-neobank/domain";
import { evaluatePaymentIntent } from "@ai-neobank/policy";
import { encryptSecret, exportDevelopmentSecret, generateSigner } from "@ai-neobank/signer";
import { z } from "zod";

const requestSchema = z.object({
  intent: paymentIntentSchema,
  policy: spendingPolicySchema,
  spentTodayBaseUnits: z.string().regex(/^\d+$/)
});

const organizationSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
});

const agentSchema = z.object({
  displayName: z.string().min(1).max(80),
  purpose: z.string().min(3).max(280),
  ownerPrincipalId: z.string().uuid().optional()
});

const agentStatusSchema = z.object({
  status: z.enum(["active", "frozen", "revoked"])
});

const organizationHeaders = z.object({
  "x-organization-id": z.string().uuid()
});

const treasurySchema = z.object({
  name: z.string().min(1).max(80),
  chainFamily: z.enum(["evm", "svm"]),
  network: z.string().regex(/^[a-z0-9]+:[a-zA-Z0-9-]+$/),
  address: z.string().min(20),
  governance: z.enum(["safe", "squads", "direct"])
}).superRefine((value, context) => {
  if (value.chainFamily === "evm" && !value.network.startsWith("eip155:")) context.addIssue({ code: "custom", message: "EVM treasury requires an eip155 network" });
  if (value.chainFamily === "svm" && !value.network.startsWith("solana:")) context.addIssue({ code: "custom", message: "Solana treasury requires a solana network" });
  if (value.chainFamily === "evm" && value.governance === "squads") context.addIssue({ code: "custom", message: "Squads is only valid for Solana" });
  if (value.chainFamily === "svm" && value.governance === "safe") context.addIssue({ code: "custom", message: "Safe is only valid for EVM" });
});

const signerSchema = z.object({
  chainFamily: z.enum(["evm", "svm"]),
  agentId: z.string().uuid().optional(),
  revealDevelopmentSecret: z.boolean().default(false)
});

const principalSchema = z.object({
  displayName: z.string().min(1).max(80),
  role: z.enum(["owner", "approver", "operator", "auditor", "developer"])
});

const approvalHeaders = organizationHeaders.extend({ "x-principal-id": z.string().uuid() });
const approvalSchema = z.object({
  expectedIntentVersion: z.number().int().positive(),
  compiledHash: z.string().regex(/^[a-f0-9]{64}$/),
  simulationHash: z.string().regex(/^[a-f0-9]{64}$/),
  signedPayload: z.string().min(16).max(8192).optional()
});

function invalid(reply: { code(statusCode: number): { send(body: unknown): unknown } }, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

export function buildApp(options: { store?: ControlPlaneStore; signerMasterKey?: Uint8Array; allowSoftwareSigners?: boolean } = {}) {
  const app = Fastify({ logger: true });
  const store = options.store ?? new MemoryControlPlaneStore();
  void app.register(cors, { origin: false });

  app.addHook("onClose", async () => store.close());

  app.get("/health", async (_request, reply) => {
    const database = await store.health().catch(() => false);
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "degraded",
      service: "api",
      database: database ? "ready" : "unavailable",
      integrations: {
        squads: "disabled_pending_verification",
        safe: "disabled_pending_verification",
        x402: "disabled_pending_verification"
      }
    });
  });

  app.get("/v1/organizations", async () => ({ data: await store.listOrganizations() }));

  app.post("/v1/organizations", async (request, reply) => {
    const parsed = organizationSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.flatten());
    const organization = await store.createOrganization(parsed.data);
    return reply.code(201).send({ data: organization });
  });

  app.get("/v1/principals", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    if (!headers.success) return invalid(reply, headers.error.flatten());
    return { data: await store.listPrincipals(headers.data["x-organization-id"]) };
  });

  app.post("/v1/principals", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = principalSchema.safeParse(request.body);
    if (!headers.success || !body.success) return invalid(reply, "Invalid organization or principal");
    const principal = await store.createHumanPrincipal(headers.data["x-organization-id"], body.data);
    return reply.code(201).send({ data: principal, warning: "Wallet proof is required before this endpoint can be enabled outside local development." });
  });

  app.get("/v1/agents", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    if (!headers.success) return invalid(reply, headers.error.flatten());
    return { data: await store.listAgents(headers.data["x-organization-id"]) };
  });

  app.post("/v1/agents", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = agentSchema.safeParse(request.body);
    if (!headers.success || !body.success) {
      return invalid(reply, { headers: headers.success ? undefined : headers.error.flatten(), body: body.success ? undefined : body.error.flatten() });
    }
    const agentInput = body.data.ownerPrincipalId
      ? { displayName: body.data.displayName, purpose: body.data.purpose, ownerPrincipalId: body.data.ownerPrincipalId }
      : { displayName: body.data.displayName, purpose: body.data.purpose };
    const agent = await store.createAgent(headers.data["x-organization-id"], agentInput);
    return reply.code(201).send({ data: agent });
  });

  app.patch<{ Params: { id: string } }>("/v1/agents/:id/status", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = agentStatusSchema.safeParse(request.body);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!headers.success || !body.success || !id.success) return invalid(reply, "Invalid organization, agent ID, or status");
    const agent = await store.setAgentStatus(headers.data["x-organization-id"], id.data, body.data.status);
    if (!agent) return reply.code(404).send({ error: "agent_not_found" });
    return { data: agent };
  });

  app.get("/v1/intents", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    if (!headers.success) return invalid(reply, headers.error.flatten());
    return { data: await store.listIntents(headers.data["x-organization-id"]) };
  });

  app.get("/v1/treasuries", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    if (!headers.success) return invalid(reply, headers.error.flatten());
    return { data: await store.listTreasuries(headers.data["x-organization-id"]) };
  });

  app.post("/v1/treasuries", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = treasurySchema.safeParse(request.body);
    if (!headers.success || !body.success) return invalid(reply, "Invalid organization or treasury");
    const treasury = await store.createTreasury(headers.data["x-organization-id"], body.data);
    return reply.code(201).send({ data: treasury });
  });

  app.get("/v1/signers", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    if (!headers.success) return invalid(reply, headers.error.flatten());
    return { data: await store.listSigners(headers.data["x-organization-id"]) };
  });

  app.post("/v1/signers", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = signerSchema.safeParse(request.body);
    if (!headers.success || !body.success) return invalid(reply, "Invalid organization or signer request");
    if (!options.allowSoftwareSigners || !options.signerMasterKey) {
      return reply.code(503).send({ error: "software_signers_disabled", message: "Configure an HSM/KMS signer in production or explicitly enable encrypted software signers for development." });
    }
    const generated = generateSigner(body.data.chainFamily);
    const encrypted = encryptSecret(generated.secret, options.signerMasterKey);
    const input = body.data.agentId
      ? { agentId: body.data.agentId, chainFamily: generated.family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion }
      : { chainFamily: generated.family, address: generated.address, encryptedSecret: encrypted.ciphertext, encryptionNonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion };
    const signer = await store.createSigner(headers.data["x-organization-id"], input);
    return reply.code(201).send({
      data: signer,
      developmentSecret: body.data.revealDevelopmentSecret ? exportDevelopmentSecret(generated) : undefined,
      warning: body.data.revealDevelopmentSecret ? "Shown once. Never send this value to an AI model or store it in application logs." : undefined
    });
  });

  app.post("/v1/intents", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const body = paymentIntentSchema.safeParse(request.body);
    if (!headers.success || !body.success) return invalid(reply, "Invalid organization or payment intent");
    if (headers.data["x-organization-id"] !== body.data.organizationId) {
      return reply.code(403).send({ error: "organization_mismatch" });
    }
    const result = await store.createIntent(body.data);
    return reply.code(result.created ? 202 : 200).send({ data: result.record, idempotentReplay: !result.created });
  });

  app.get<{ Params: { id: string } }>("/v1/intents/:id/approval", async (request, reply) => {
    const headers = organizationHeaders.safeParse(request.headers);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!headers.success || !id.success) return invalid(reply, "Invalid organization or intent ID");
    const approval = await store.getApprovalRequest(headers.data["x-organization-id"], id.data);
    if (!approval) return reply.code(404).send({ error: "approval_not_found" });
    return { data: approval };
  });

  for (const decision of ["approved", "rejected"] as const) {
    const path = decision === "approved" ? "/v1/intents/:id/approve" : "/v1/intents/:id/reject";
    app.post<{ Params: { id: string } }>(path, async (request, reply) => {
      const headers = approvalHeaders.safeParse(request.headers);
      const body = approvalSchema.safeParse(request.body);
      const id = z.string().uuid().safeParse(request.params.id);
      if (!headers.success || !body.success || !id.success) return invalid(reply, "Invalid approval request");
      try {
        const input = body.data.signedPayload
          ? { ...body.data, signedPayload: body.data.signedPayload, principalId: headers.data["x-principal-id"], decision }
          : { expectedIntentVersion: body.data.expectedIntentVersion, compiledHash: body.data.compiledHash, simulationHash: body.data.simulationHash, principalId: headers.data["x-principal-id"], decision };
        const result = await store.decideIntent(headers.data["x-organization-id"], id.data, input);
        return reply.code(result.idempotentReplay ? 200 : 202).send({ data: result });
      } catch (error) {
        if (!(error instanceof ApprovalError)) throw error;
        const status = error.code === "not_found" ? 404 : error.code === "not_eligible" ? 403 : error.code === "expired" ? 410 : 409;
        return reply.code(status).send({ error: error.code });
      }
    });
  }

  app.post("/v1/intents/evaluate", async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
    }

    const decision = evaluatePaymentIntent(parsed.data.intent, parsed.data.policy, {
      spentTodayBaseUnits: parsed.data.spentTodayBaseUnits,
      now: new Date()
    });

    return reply.code(decision.outcome === "rejected" ? 422 : 200).send({
      intentId: parsed.data.intent.id,
      policyId: parsed.data.policy.id,
      policyVersion: parsed.data.policy.version,
      decision
    });
  });

  return app;
}
