import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PostgresControlPlaneStore } from "@ai-neobank/database";
import {
  canTransitionVerification,
  capabilityAccess,
  describeVerification,
  gatedCapabilities,
  verificationDecisionSchema,
  verificationRoles,
  verificationStartSchema,
  type CapabilityDecision,
  type GatedCapability,
  type PrincipalRole,
  type VerificationState,
  type VerificationStatus
} from "@ai-neobank/domain";

interface HumanContext { organizationId: string; principalId: string; role: PrincipalRole }

export interface VerificationRouteContext {
  store: PostgresControlPlaneStore;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
}

/** An organisation's verification state together with the freeze flag the gate also reads. */
export interface VerificationSubject extends VerificationState { frozen: boolean }

export class VerificationError extends Error {
  constructor(readonly code: "organization_not_found" | "verification_transition_not_allowed", message: string) {
    super(message);
  }
}

type Db = PostgresControlPlaneStore["sql"];

const verificationColumns = `verification_status as "status", verification_provider as "provider", verification_reference as "reference", verification_method as "method",
  to_char(verification_started_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startedAt",
  to_char(verification_decided_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "decidedAt",
  verification_decided_by::text as "decidedBy", verification_reason as "reason",
  to_char(verification_expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt", frozen`;

/**
 * Reads and moves the organisation's verification case.
 *
 * It lives beside the routes while verification has no provider, and follows
 * the RotationStore shape so it can move into @ai-neobank/database unchanged.
 * It writes a state, a case reference, timestamps and a short reason, and
 * nothing else: raw identity documents are never accepted, so they are never
 * stored.
 */
export class VerificationStore {
  constructor(readonly sql: Db) {}

  async read(organizationId: string): Promise<VerificationSubject | null> {
    const rows = await this.sql.unsafe<VerificationSubject[]>(`select ${verificationColumns} from organizations where id = $1`, [organizationId]);
    return rows[0] ?? null;
  }

  /**
   * Moves the case, refusing a transition the state machine does not allow.
   * Starting clears the previous decision, because a new case has not been
   * decided. Every other move is a decision, so it records the principal who
   * made it; the provider stays null, since no provider decided anything.
   */
  async transition(organizationId: string, to: VerificationStatus, actorPrincipalId: string, input: { reason?: string; reference?: string; expiresAt?: string } = {}): Promise<VerificationSubject> {
    return this.sql.begin(async (tx) => {
      const current = await tx<{ status: VerificationStatus; reference: string | null }[]>`
        select verification_status as "status", verification_reference as "reference" from organizations where id = ${organizationId} for update
      `;
      const from = current[0];
      if (!from) throw new VerificationError("organization_not_found", "Organisation not found");
      if (!canTransitionVerification(from.status, to)) {
        throw new VerificationError("verification_transition_not_allowed", `Verification cannot go from ${from.status} to ${to}`);
      }
      const reference = input.reference ?? (to === "started" ? null : from.reference);
      const rows = to === "started"
        ? await tx.unsafe<VerificationSubject[]>(
            `update organizations set verification_status = 'started', verification_started_at = now(), verification_provider = null,
               verification_reference = $2, verification_method = null, verification_decided_at = null, verification_decided_by = null,
               verification_reason = null, verification_expires_at = null, updated_at = now()
             where id = $1 returning ${verificationColumns}`,
            [organizationId, reference]
          )
        : await tx.unsafe<VerificationSubject[]>(
            `update organizations set verification_status = $2, verification_method = 'manual', verification_provider = null,
               verification_reference = $3, verification_reason = $4, verification_expires_at = $5,
               verification_decided_at = now(), verification_decided_by = $6, updated_at = now()
             where id = $1 returning ${verificationColumns}`,
            [organizationId, to, reference, input.reason ?? null, input.expiresAt ?? null, actorPrincipalId]
          );
      const subject = rows[0];
      if (!subject) throw new VerificationError("organization_not_found", "Organisation not found");
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${actorPrincipalId}, ${to === "started" ? "verification.started" : "verification.decided"}, 'organization', ${organizationId},
          encode(digest(${`${from.status}>${to}`}, 'sha256'), 'hex'),
          ${tx.json({ from: from.status, to, method: to === "started" ? null : "manual", reason: input.reason ?? null, reference: reference ?? null })})
      `;
      return subject;
    });
  }
}

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "invalid_request", details });
}

function verificationFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof VerificationError) {
    return reply.code(error.code === "organization_not_found" ? 404 : 409).send({ error: error.code, message: error.message });
  }
  throw error;
}

/** A refusal carries the repo's usual code for its kind: frozen, missing, not configured, or not allowed. */
export function capabilityStatusCode(code: Extract<CapabilityDecision, { allowed: false }>["code"]): number {
  if (code === "organization_not_found") return 404;
  if (code === "organization_frozen") return 423;
  if (code === "provider_not_connected") return 503;
  return 403;
}

export interface VerificationViewBody extends VerificationState {
  /** When the decision was recorded. The same instant as decidedAt, under the name the console reads. */
  reviewedAt: string | null;
  verification: VerificationState;
  banner: ReturnType<typeof describeVerification>;
  capabilities: Record<GatedCapability, CapabilityDecision>;
}

/**
 * What the console reads for the banner and for the locked parts of the
 * navigation. The state is flat at the top so a reader can take one field, and
 * repeated under `verification` with the gate's decision beside it. There is no
 * requirements list: no provider has stated one, so none is sent.
 */
export function verificationView(subject: VerificationSubject): VerificationViewBody {
  const { frozen, ...verification } = subject;
  const capabilities = {} as Record<GatedCapability, CapabilityDecision>;
  for (const capability of gatedCapabilities) capabilities[capability] = capabilityAccess(capability, { frozen, verification });
  return { ...verification, reviewedAt: verification.decidedAt, verification, banner: describeVerification(verification), capabilities };
}

/**
 * Server-side gate for a restricted feature, in the shape of frozenGuard: it
 * returns true when the caller was refused and the reply has been sent. The
 * refusal carries the reason, so the console can say what is missing instead of
 * showing an empty page.
 */
export async function capabilityGuard(reply: FastifyReply, store: PostgresControlPlaneStore, organizationId: string, capability: GatedCapability): Promise<boolean> {
  const decision = await capabilityDecision(store, organizationId, capability);
  if (decision.allowed) return false;
  void reply.code(capabilityStatusCode(decision.code)).send({ error: decision.code, message: decision.reason, capability: decision.capability });
  return true;
}

/** The same decision without the reply, for callers that describe a locked feature rather than refuse a call. */
export async function capabilityDecision(store: PostgresControlPlaneStore, organizationId: string, capability: GatedCapability): Promise<CapabilityDecision> {
  const subject = await new VerificationStore(store.sql).read(organizationId);
  if (!subject) return { capability, allowed: false, code: "organization_not_found", reason: "The organisation could not be read, so nothing is unlocked." };
  const { frozen, ...verification } = subject;
  return capabilityAccess(capability, { frozen, verification });
}

/**
 * Verification (KYB) for the organisation. Floatlane has no verification
 * provider connected, so nothing here checks an identity: an owner records a
 * decision by hand and Relay stores it as exactly that, with who decided and
 * when. Restricted features read the gate rather than the status directly, so
 * a feature that is still missing its own provider stays honest about it.
 */
export function registerVerificationRoutes(app: FastifyInstance, context: VerificationRouteContext): void {
  const { store, human } = context;
  const verification = new VerificationStore(store.sql);

  app.get("/v1/verification", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const subject = await verification.read(auth.organizationId);
    if (!subject) return reply.code(404).send({ error: "organization_not_found" });
    return { data: verificationView(subject) };
  });

  /** Opening a case takes no details, because there is nowhere to send them. Both paths are the same call. */
  for (const path of ["/v1/verification", "/v1/verification/start"]) {
    app.post(path, async (request, reply) => {
      const auth = human(request, reply, [...verificationRoles.start]); if (!auth) return;
      const body = verificationStartSchema.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, body.error.flatten());
      try {
        return reply.code(201).send({ data: verificationView(await verification.transition(auth.organizationId, "started", auth.principalId)) });
      } catch (error) { return verificationFailure(reply, error); }
    });
  }

  /**
   * The one honest way to a decided state in this build: a person decides, and
   * the record says it was manual. Nothing is checked against a register here.
   */
  app.post("/v1/verification/decision", async (request, reply) => {
    const auth = human(request, reply, [...verificationRoles.decide]); if (!auth) return;
    const body = verificationDecisionSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const { status, reason, reference, expiresAt } = body.data;
    try {
      const subject = await verification.transition(auth.organizationId, status, auth.principalId, {
        ...(reason ? { reason } : {}), ...(reference ? { reference } : {}), ...(expiresAt ? { expiresAt } : {})
      });
      return { data: verificationView(subject) };
    } catch (error) { return verificationFailure(reply, error); }
  });
}
