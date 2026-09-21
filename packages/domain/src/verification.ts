import { z } from "zod";
import type { PrincipalRole } from "./index.js";

/**
 * Verification (KYB) of the organisation behind a Relay account.
 *
 * Floatlane has no verification provider connected. Nothing in this module
 * checks an identity, and no identity document is ever accepted or stored: the
 * state below records what a person decided, when, and why, so the parts of the
 * product that must not run unverified have something real to read.
 */
export const verificationStatuses = ["unstarted", "started", "pending", "verified", "rejected", "expired"] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];
export const verificationStatusSchema = z.enum(verificationStatuses);

/**
 * How the current status was reached. Every decision in this build is "manual":
 * a person recorded it. "provider" exists for the day a real provider is wired
 * and is never written by this code.
 */
export const verificationMethods = ["manual", "provider"] as const;
export type VerificationMethod = (typeof verificationMethods)[number];

/** Everything Relay keeps about verification. No field here holds identity data. */
export interface VerificationState {
  status: VerificationStatus;
  /** Name of the provider that decided, when one ever does. Null while none is connected. */
  provider: string | null;
  /** The provider's own case reference, never a document number. */
  reference: string | null;
  method: VerificationMethod | null;
  startedAt: string | null;
  decidedAt: string | null;
  /** Principal who recorded the decision. */
  decidedBy: string | null;
  reason: string | null;
  expiresAt: string | null;
}

/**
 * The exact set of things that may be persisted about verification. A field
 * outside this list is identity data by definition and does not belong in Relay.
 */
export const verificationStoredFields = ["status", "provider", "reference", "method", "startedAt", "decidedAt", "decidedBy", "reason", "expiresAt"] as const;

/**
 * Legal next states. A case is started, may be sent for review, and ends in a
 * decision; a decided case is redone by starting a new one. There is no edge
 * into "verified" that a claim alone can take: reaching it is a recorded
 * decision by a named principal.
 */
export const verificationTransitions: Record<VerificationStatus, readonly VerificationStatus[]> = {
  unstarted: ["started"],
  started: ["pending", "verified", "rejected", "expired"],
  pending: ["verified", "rejected", "expired"],
  verified: ["expired"],
  rejected: ["started"],
  expired: ["started"]
};

export function canTransitionVerification(from: VerificationStatus, to: VerificationStatus): boolean {
  return verificationTransitions[from].includes(to);
}

/** What a caller may do to a verification case, and the roles allowed to do it. */
export const verificationActions = ["start", "decide"] as const;
export type VerificationAction = (typeof verificationActions)[number];
export const verificationRoles: Record<VerificationAction, readonly PrincipalRole[]> = { start: ["owner"], decide: ["owner"] };

export function canPerformVerification(action: VerificationAction, role: PrincipalRole): boolean {
  return verificationRoles[action].includes(role);
}

/**
 * A short note on the decision. Kept deliberately narrow: long digit runs are
 * document and identifier numbers, and a data URL is a scan of one. Neither is
 * a reason, and neither is stored.
 */
export const verificationReasonSchema = z.string().trim().min(3).max(500)
  .refine((value) => !/\d{6,}/.test(value), "Do not put document or identifier numbers in the reason")
  .refine((value) => !/data:[a-z]+\/[a-z0-9.+-]+/i.test(value), "Do not paste documents into the reason");

/** Body of a start request. Strict, so a caller cannot smuggle identity fields in. */
export const verificationStartSchema = z.strictObject({});

/**
 * Body of a decision. Strict for the same reason: anything that is not a state,
 * a case reference, a timestamp or a reason is refused at the boundary.
 */
export const verificationDecisionSchema = z.strictObject({
  status: z.enum(["pending", "verified", "rejected", "expired"]),
  reason: verificationReasonSchema.optional(),
  reference: z.string().trim().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional()
});
export type VerificationDecisionInput = z.infer<typeof verificationDecisionSchema>;

/**
 * Providers Relay is actually connected to: verification providers and the
 * providers a gated capability needs, such as a card issuer. Empty, and adding
 * a name here means writing the integration. There is no stub that pretends to
 * check or issue anything.
 */
export const connectedProviders: readonly string[] = [];

/** Features that stay locked until the organisation is verified. Cards are the first. */
export const gatedCapabilities = ["cards"] as const;
export type GatedCapability = (typeof gatedCapabilities)[number];

export type CapabilityBlock =
  | "organization_not_found"
  | "organization_frozen"
  | "verification_required"
  | "verification_in_review"
  | "verification_rejected"
  | "verification_expired"
  | "provider_not_connected";

export type CapabilityDecision =
  | { capability: GatedCapability; allowed: true }
  | { capability: GatedCapability; allowed: false; code: CapabilityBlock; reason: string };

/** What a gated capability needs before it can do anything. */
const capabilityNeeds: Record<GatedCapability, { verification: boolean; provider: string }> = {
  cards: { verification: true, provider: "card_issuer" }
};

export interface CapabilitySubject {
  frozen: boolean;
  verification: Pick<VerificationState, "status">;
}

const blockForStatus: Record<Exclude<VerificationStatus, "verified">, { code: CapabilityBlock; reason: string }> = {
  unstarted: { code: "verification_required", reason: "Verification has not been started, so this stays locked. An owner can start it in Settings." },
  started: { code: "verification_in_review", reason: "Verification is open and has not been decided yet." },
  pending: { code: "verification_in_review", reason: "Verification is with a reviewer and has not been decided yet." },
  rejected: { code: "verification_rejected", reason: "Verification was rejected, so this stays locked. An owner can start it again." },
  expired: { code: "verification_expired", reason: "Verification has expired, so this stays locked until it is done again." }
};

/**
 * Whether a named capability is allowed for an organisation, and if not, why
 * not. Callers show the reason as it is: a locked feature says what is missing
 * rather than pretending to be temporarily empty.
 */
export function capabilityAccess(capability: GatedCapability, subject: CapabilitySubject): CapabilityDecision {
  const needs = capabilityNeeds[capability];
  if (subject.frozen) return { capability, allowed: false, code: "organization_frozen", reason: "The organisation is frozen, so nothing new can be opened." };
  if (needs.verification && subject.verification.status !== "verified") {
    const block = blockForStatus[subject.verification.status];
    return { capability, allowed: false, code: block.code, reason: block.reason };
  }
  if (!connectedProviders.includes(needs.provider)) {
    return { capability, allowed: false, code: "provider_not_connected", reason: "Verification is on file, but Floatlane has no card issuer connected. No card can be issued and there is none to show." };
  }
  return { capability, allowed: true };
}

/** The empty state: what is true before anything has been recorded. */
export function emptyVerificationState(): VerificationState {
  return { status: "unstarted", provider: null, reference: null, method: null, startedAt: null, decidedAt: null, decidedBy: null, reason: null, expiresAt: null };
}

/**
 * Copy for the console banner. It says plainly that no provider is connected,
 * so a verified organisation is never read as an identity somebody checked.
 */
export function describeVerification(state: VerificationState): { headline: string; detail: string; providerConnected: boolean; canStart: boolean } {
  const providerConnected = connectedProviders.length > 0;
  const unavailable = "Floatlane has no verification provider connected, so nothing here has been checked against a register. An owner can record a decision by hand, and it is stored as exactly that.";
  const canStart = verificationTransitions[state.status].includes("started");
  const headlines: Record<VerificationStatus, string> = {
    unstarted: "Verification has not been started",
    started: "Verification is open",
    pending: "Verification is with a reviewer",
    verified: "Verified by a recorded decision",
    rejected: "Verification was rejected",
    expired: "Verification has expired"
  };
  const details: Record<VerificationStatus, string> = {
    unstarted: `Restricted parts of the console stay locked until this is done. ${unavailable}`,
    started: `The case is open and nothing has been decided. ${unavailable}`,
    pending: `Somebody has to decide it; nothing decides it automatically. ${unavailable}`,
    verified: `Recorded by a person, not by a provider. ${unavailable}`,
    rejected: state.reason ? `Reason given: ${state.reason}` : "No reason was recorded.",
    expired: "Start verification again to unlock the restricted parts of the console."
  };
  return { headline: headlines[state.status], detail: details[state.status], providerConnected, canStart };
}
