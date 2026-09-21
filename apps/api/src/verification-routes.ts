import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PostgresControlPlaneStore, SqlRunner, VerificationCaseRecord } from "@ai-neobank/database";
import { VerificationCaseStore } from "@ai-neobank/database";
import { canonicalAddress, verifyWalletSignature } from "@ai-neobank/auth";
import {
  attestationStatement,
  canTransitionVerification,
  capabilityAccess,
  describeVerification,
  gatedCapabilities,
  verificationDecisionSchema,
  verificationProfileExclusions,
  verificationProfileRequirements,
  verificationProfileSchema,
  verificationRoles,
  verificationStartSchema,
  verificationSubmitCheck,
  type CapabilityDecision,
  type GatedCapability,
  type PrincipalRole,
  type VerificationProfile,
  type VerificationRequirement,
  type VerificationState,
  type VerificationStatus,
  type VerificationSubmission
} from "@ai-neobank/domain";
import { z } from "zod";

interface HumanContext { organizationId: string; principalId: string; role: PrincipalRole }

/**
 * Moves the organisation's verification status. The Postgres implementation is
 * below; the routes take it through this shape so the decisions they make can
 * be exercised without a database.
 */
export interface VerificationStateGateway {
  read(organizationId: string): Promise<VerificationSubject | null>;
  transition(organizationId: string, to: VerificationStatus, actorPrincipalId: string, input?: VerificationTransitionInput): Promise<VerificationSubject>;
  submitForReview(organizationId: string, actorPrincipalId: string, write: (tx: SqlRunner) => Promise<void>): Promise<VerificationSubject>;
}

/** The application itself: the draft and the signed submission. Same reason for the shape. */
export interface VerificationCaseGateway {
  read(organizationId: string): Promise<VerificationCaseRecord | null>;
  saveProfile(organizationId: string, profile: VerificationProfile): Promise<VerificationCaseRecord>;
  recordSubmission(
    organizationId: string,
    input: { statement: string; signature: string; address: string; chainFamily: "evm" | "svm"; submittedBy: string },
    db?: SqlRunner
  ): Promise<VerificationCaseRecord | null>;
  clearSubmission(organizationId: string, db?: SqlRunner): Promise<void>;
  walletsForPrincipal(organizationId: string, principalId: string): Promise<{ id: string; chainFamily: "evm" | "svm"; address: string }[]>;
}

export interface VerificationRouteContext {
  store: PostgresControlPlaneStore;
  human(request: FastifyRequest, reply: FastifyReply, roles?: PrincipalRole[]): HumanContext | null;
  /** Both halves of the storage. Left out in the server, where they are built from `store`. */
  gateways?: { state: VerificationStateGateway; cases: VerificationCaseGateway };
}

/** An organisation's verification state together with the freeze flag the gate also reads. */
export interface VerificationSubject extends VerificationState { frozen: boolean }

export interface VerificationTransitionInput {
  reason?: string;
  reference?: string;
  expiresAt?: string;
  /**
   * Runs inside the same transaction as the move. A case and its application
   * are two rows, and a half-applied move would leave a signature attached to a
   * case nobody submitted, so the writes go together or not at all.
   */
  alsoInTransaction?: (tx: SqlRunner) => Promise<void>;
}

export class VerificationError extends Error {
  constructor(readonly code: "organization_not_found" | "verification_transition_not_allowed" | "verification_application_missing", message: string) {
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
export class VerificationStore implements VerificationStateGateway {
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
  async transition(organizationId: string, to: VerificationStatus, actorPrincipalId: string, input: VerificationTransitionInput = {}): Promise<VerificationSubject> {
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
      await input.alsoInTransaction?.(tx);
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${actorPrincipalId}, ${to === "started" ? "verification.started" : "verification.decided"}, 'organization', ${organizationId},
          encode(digest(${`${from.status}>${to}`}, 'sha256'), 'hex'),
          ${tx.json({ from: from.status, to, method: to === "started" ? null : "manual", reason: input.reason ?? null, reference: reference ?? null })})
      `;
      return subject;
    });
  }

  /**
   * Sends an open case to a reviewer: started to pending, with the submission
   * written in the same transaction.
   *
   * Submitting is not deciding, so this touches none of the decision columns.
   * The applicant is recorded as the person who submitted it, in the audit
   * trail and on the application row, and nobody is recorded as having decided
   * anything until somebody has.
   */
  async submitForReview(organizationId: string, actorPrincipalId: string, write: (tx: SqlRunner) => Promise<void>): Promise<VerificationSubject> {
    return this.sql.begin(async (tx) => {
      const current = await tx<{ status: VerificationStatus }[]>`
        select verification_status as "status" from organizations where id = ${organizationId} for update
      `;
      const from = current[0];
      if (!from) throw new VerificationError("organization_not_found", "Organisation not found");
      if (!canTransitionVerification(from.status, "pending")) {
        throw new VerificationError("verification_transition_not_allowed", `Verification cannot go from ${from.status} to pending`);
      }
      await write(tx);
      const rows = await tx.unsafe<VerificationSubject[]>(
        `update organizations set verification_status = 'pending', updated_at = now() where id = $1 returning ${verificationColumns}`,
        [organizationId]
      );
      const subject = rows[0];
      if (!subject) throw new VerificationError("organization_not_found", "Organisation not found");
      await tx`
        insert into audit_events (organization_id, actor_principal_id, action, resource_type, resource_id, payload_hash, data)
        values (${organizationId}, ${actorPrincipalId}, 'verification.submitted', 'organization', ${organizationId},
          encode(digest(${`${from.status}>pending`}, 'sha256'), 'hex'),
          ${tx.json({ from: from.status, to: "pending", method: null, submittedBy: actorPrincipalId })})
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
  /** The draft, as the owner last saved it. Null before anything has been filled in. */
  profile: VerificationProfile | null;
  /** What the application asks for and why, so the console never writes its own copy of the form. */
  requirements: readonly VerificationRequirement[];
  /** What the application is not, in the domain's words, for the same reason. */
  exclusions: readonly string[];
  /**
   * Who signed the application, when, and the exact words they signed, once it
   * has been submitted. The signature itself stays on the server.
   */
  submission: VerificationSubmission | null;
}

/**
 * What the console reads for the banner, for the locked parts of the
 * navigation, and for the application itself. The state is flat at the top so a
 * reader can take one field, and repeated under `verification` with the gate's
 * decision beside it.
 *
 * The requirements are what this build asks for, not a provider's list: no
 * provider has stated one, because none is connected.
 */
export function verificationView(subject: VerificationSubject, application?: VerificationCaseRecord | null): VerificationViewBody {
  const { frozen, ...verification } = subject;
  const capabilities = {} as Record<GatedCapability, CapabilityDecision>;
  for (const capability of gatedCapabilities) capabilities[capability] = capabilityAccess(capability, { frozen, verification });
  const submission = application?.submission
    ? {
        submittedAt: application.submission.submittedAt,
        submittedBy: application.submission.submittedBy,
        attestationAddress: application.submission.attestationAddress,
        statement: application.submission.statement
      }
    : null;
  return {
    ...verification,
    reviewedAt: verification.decidedAt,
    verification,
    banner: describeVerification(verification),
    capabilities,
    profile: storedProfile(application),
    requirements: verificationProfileRequirements,
    exclusions: verificationProfileExclusions,
    submission
  };
}

/**
 * The draft as it was stored. It went in through the profile schema, so it is
 * handed back as it is rather than re-parsed: re-parsing would quietly drop a
 * half-finished draft that the owner is still working on.
 */
function storedProfile(application?: VerificationCaseRecord | null): VerificationProfile | null {
  return (application?.profile as VerificationProfile | undefined) ?? null;
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

/** Body of a submission. Nothing else is accepted: the statement is the server's to build. */
const verificationSubmitSchema = z.strictObject({
  address: z.string().trim().min(20).max(120),
  signature: z.string().trim().min(16).max(500)
});

/**
 * Whether the draft may still be edited. An open case is the only place it can
 * be: everywhere else there is either a signature or a recorded decision
 * standing against those exact facts, and editing the facts underneath one
 * would leave the console showing an attestation beside words it does not
 * cover. Starting again clears the old signature and keeps the draft, so the
 * way to change the facts is to open a new case.
 */
function profileLock(status: VerificationStatus): { code: string; message: string } | null {
  if (status === "started") return null;
  const messages: Record<Exclude<VerificationStatus, "started">, string> = {
    unstarted: "Verification has not been started, so there is no application to fill in. An owner can start it first.",
    pending: "This application is with a reviewer. The signed attestation covers these exact facts, so they cannot be edited. Start verification again to change them.",
    verified: "A recorded decision is on file against these exact facts, so they cannot be edited. Start verification again to replace it.",
    rejected: "This case was decided against the facts that were signed. Start verification again to edit them: that opens a new case and drops the old signature.",
    expired: "This case has expired against the facts that were signed. Start verification again to edit them: that opens a new case and drops the old signature."
  };
  return { code: status === "unstarted" ? "verification_not_started" : "verification_profile_locked", message: messages[status] };
}

/**
 * The exact text the owner signs, built by the server from what the server
 * holds: the stored profile, this organisation, the principal submitting it,
 * and the moment the case was opened. Nothing the client sends goes into it,
 * which is what makes checking a signature against it worth anything.
 *
 * The case's own start is the moment, not the time of the call, so the text
 * handed out to be signed and the text checked against the signature are the
 * same bytes.
 */
function statementFor(subject: VerificationSubject, profile: VerificationProfile, organizationId: string, principalId: string): string | null {
  if (!subject.startedAt) return null;
  return attestationStatement({ profile, organizationId, principalId, at: subject.startedAt });
}

/** The wallet this address is, among the ones bound to the principal. Nothing else may sign. */
function boundWallet<T extends { chainFamily: "evm" | "svm"; address: string }>(wallets: T[], address: string): T | null {
  for (const wallet of wallets) {
    try {
      const canonical = canonicalAddress(wallet.chainFamily, address);
      if (canonical === wallet.address) return wallet;
      // Stored EVM addresses are checksummed, but an older row may not be; base58 is case sensitive and is compared as it is.
      if (wallet.chainFamily === "evm" && canonical.toLowerCase() === wallet.address.toLowerCase()) return wallet;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Verification (KYB) for the organisation. Floatlane has no verification
 * provider connected, so nothing here checks an identity: an owner fills in
 * what the business is, signs a statement saying those facts are true and that
 * nobody has checked them, and a named person records a decision. Relay stores
 * it as exactly that. Restricted features read the gate rather than the status
 * directly, so a feature that is still missing its own provider stays honest
 * about it.
 */
export function registerVerificationRoutes(app: FastifyInstance, context: VerificationRouteContext): void {
  const { store, human } = context;
  const verification = context.gateways?.state ?? new VerificationStore(store.sql);
  const cases = context.gateways?.cases ?? new VerificationCaseStore(store.sql);

  app.get("/v1/verification", async (request, reply) => {
    const auth = human(request, reply); if (!auth) return;
    const subject = await verification.read(auth.organizationId);
    if (!subject) return reply.code(404).send({ error: "organization_not_found" });
    return { data: verificationView(subject, await cases.read(auth.organizationId)) };
  });

  /**
   * Opening a case takes no details, because the details are the application
   * that follows. A case that was rejected or has expired can be started again:
   * the old signature goes with it, since a new case is a new attestation, and
   * the entity facts stay as a draft because retyping them would only invite a
   * typo.
   */
  for (const path of ["/v1/verification", "/v1/verification/start"]) {
    app.post(path, async (request, reply) => {
      const auth = human(request, reply, [...verificationRoles.start]); if (!auth) return;
      const body = verificationStartSchema.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, body.error.flatten());
      try {
        const subject = await verification.transition(auth.organizationId, "started", auth.principalId, {
          alsoInTransaction: (tx) => cases.clearSubmission(auth.organizationId, tx)
        });
        return reply.code(201).send({ data: verificationView(subject, await cases.read(auth.organizationId)) });
      } catch (error) { return verificationFailure(reply, error); }
    });
  }

  /** The draft. Entity facts only: the schema refuses anything else at the boundary. */
  app.put("/v1/verification/profile", async (request, reply) => {
    const auth = human(request, reply, [...verificationRoles.start]); if (!auth) return;
    const body = verificationProfileSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const subject = await verification.read(auth.organizationId);
    if (!subject) return reply.code(404).send({ error: "organization_not_found" });
    const locked = profileLock(subject.status);
    if (locked) return reply.code(409).send({ error: locked.code, message: locked.message });
    const application = await cases.saveProfile(auth.organizationId, body.data);
    return { data: verificationView(subject, application) };
  });

  /** The statement to sign. The server builds it; a client never supplies one. */
  app.get("/v1/verification/attestation", async (request, reply) => {
    const auth = human(request, reply, [...verificationRoles.start]); if (!auth) return;
    const subject = await verification.read(auth.organizationId);
    if (!subject) return reply.code(404).send({ error: "organization_not_found" });
    const application = await cases.read(auth.organizationId);
    const check = verificationSubmitCheck({ status: subject.status, profile: application?.profile });
    if (!check.ok) return reply.code(409).send({ error: check.code, message: check.reason });
    const statement = statementFor(subject, application?.profile as VerificationProfile, auth.organizationId, auth.principalId);
    if (!statement) return reply.code(409).send({ error: "verification_not_started", message: "The case has no start, so there is no moment to sign against." });
    return { data: { statement } };
  });

  /**
   * Submitting the application. The owner signs the statement with a wallet
   * that is already bound to them; the server rebuilds that statement from what
   * it holds and checks the signature against what it built, never against
   * anything that arrived with the request. The same check as sign-in, for both
   * chain families the console supports.
   */
  app.post("/v1/verification/submit", async (request, reply) => {
    const auth = human(request, reply, [...verificationRoles.start]); if (!auth) return;
    const body = verificationSubmitSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const subject = await verification.read(auth.organizationId);
    if (!subject) return reply.code(404).send({ error: "organization_not_found" });
    const application = await cases.read(auth.organizationId);
    const check = verificationSubmitCheck({ status: subject.status, profile: application?.profile });
    if (!check.ok) return reply.code(409).send({ error: check.code, message: check.reason });

    const wallets = await cases.walletsForPrincipal(auth.organizationId, auth.principalId);
    const wallet = boundWallet(wallets, body.data.address);
    if (!wallet) {
      return reply.code(403).send({ error: "wallet_not_bound_to_principal", message: "Sign the attestation with a wallet that is bound to you. No other wallet can submit on your behalf." });
    }
    const statement = statementFor(subject, application?.profile as VerificationProfile, auth.organizationId, auth.principalId);
    if (!statement) return reply.code(409).send({ error: "verification_not_started", message: "The case has no start, so there is no moment to sign against." });
    const signed = await verifyWalletSignature({ chainFamily: wallet.chainFamily, address: wallet.address, message: statement, signature: body.data.signature });
    if (!signed) {
      return reply.code(401).send({ error: "attestation_signature_invalid", message: "That signature does not cover the statement this server built for this application." });
    }

    try {
      const moved = await verification.submitForReview(auth.organizationId, auth.principalId, async (tx) => {
        const saved = await cases.recordSubmission(
          auth.organizationId,
          { statement, signature: body.data.signature, address: wallet.address, chainFamily: wallet.chainFamily, submittedBy: auth.principalId },
          tx
        );
        if (!saved) throw new VerificationError("verification_application_missing", "There is no application to submit.");
      });
      return { data: verificationView(moved, await cases.read(auth.organizationId)) };
    } catch (error) { return verificationFailure(reply, error); }
  });

  /**
   * The one honest way to a decided state in this build: a person decides, and
   * the record says it was manual. Nothing is checked against a register here.
   *
   * It records decisions and nothing else. "With a reviewer" is not a decision:
   * a case is there because its owner submitted it and signed the attestation,
   * so asking for it here is refused by name rather than by a schema error. Left
   * open it would stamp a decider and a decision time on a case nobody decided,
   * show the console a submission that never happened, and lock the draft behind
   * a signature that does not exist.
   */
  app.post("/v1/verification/decision", async (request, reply) => {
    const auth = human(request, reply, [...verificationRoles.decide]); if (!auth) return;
    if ((request.body as { status?: unknown } | null | undefined)?.status === "pending") {
      return reply.code(409).send({
        error: "verification_not_submitted",
        message: "A case goes to a reviewer when its owner submits it and signs the attestation. It cannot be put there by hand, because that would show a submission nobody made."
      });
    }
    const body = verificationDecisionSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error.flatten());
    const { status, reason, reference, expiresAt } = body.data;
    try {
      const subject = await verification.transition(auth.organizationId, status, auth.principalId, {
        ...(reason ? { reason } : {}), ...(reference ? { reference } : {}), ...(expiresAt ? { expiresAt } : {})
      });
      return { data: verificationView(subject, await cases.read(auth.organizationId)) };
    } catch (error) { return verificationFailure(reply, error); }
  });
}
