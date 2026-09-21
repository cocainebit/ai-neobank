import { z } from "zod";
import type { PrincipalRole } from "./primitives.js";

/**
 * Verification (KYB) of the organisation behind a Relay account.
 *
 * Floatlane has no verification provider connected. Nothing in this module
 * checks an identity, and no identity document is ever accepted or stored: the
 * state below records what a person decided, when, and why, so the parts of the
 * product that must not run unverified have something real to read.
 *
 * What is stored, and why it is not identity data
 *
 * The application collects facts about the entity and nothing else: legal name,
 * entity type, registration number, jurisdiction, registered address, website,
 * and a description of the business in the applicant's own words. Every one of
 * those, the description aside, is what a company register already publishes
 * about the company. They describe a legal person that exists on a public
 * record, not a human being: none of them is a natural person's name, date of
 * birth, government identifier, document, scan or photograph, and
 * `verificationProfileSchema` is strict so no field can carry one in.
 *
 * The people behind the business are deliberately absent. Control persons are
 * disclosed to a verification provider on the day one exists, and until then
 * this product asks for none of them, which is why the attestation says so in
 * the text the owner signs.
 *
 * The owner attests to those facts with their wallet. A signature is not a
 * check either: it records who said the facts are true. "Verified" in this
 * product means a named person read that statement and recorded a decision.
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
 * A data URL, which is how a scan arrives as text.
 *
 * Written to the grammar rather than to the common case, because the media type
 * is optional in that grammar and both `data:;base64,` and `data:,` are whole
 * working data URLs with no media type in them. A rule that insisted on a
 * `type/subtype` let a scan through under either spelling, so this matches the
 * scheme, whatever media type and parameters are or are not there, and the
 * comma that separates them from the payload.
 */
const dataUrl = /data:[a-z0-9.+\/-]*(?:;[a-z0-9.+=-]*)*,/i;

/**
 * The rule every free-text field in this module obeys: long digit runs are
 * document and identifier numbers, and a data URL is a scan of one. Neither
 * belongs in prose a person typed, so neither is accepted and neither is
 * stored. `label` only names the field in the message.
 *
 * Fields whose whole point is a number from a register, such as the company
 * number or the postal code, are not free text and do not use this. They are
 * held to a narrow character set instead, which no document number narrative
 * and no data URL can pass.
 *
 * What this does not do: it cannot keep a person's name, a date of birth or a
 * separated identifier such as 123-45-6789 out of a sentence, because those are
 * shaped like ordinary prose. Nothing in this product asks for any of them, and
 * no field is named for one, which is what actually keeps them out. These two
 * rules refuse the pasted document, not the typed word.
 */
function freeText(label: string, min: number, max: number) {
  return z.string().trim().min(min).max(max)
    .refine((value) => !/\d{6,}/.test(value), `Do not put document or identifier numbers in the ${label}`)
    .refine((value) => !dataUrl.test(value), `Do not paste documents into the ${label}`);
}

/**
 * A short note on the decision. Kept deliberately narrow: long digit runs are
 * document and identifier numbers, and a data URL is a scan of one. Neither is
 * a reason, and neither is stored.
 */
export const verificationReasonSchema = freeText("reason", 3, 500);

/** Body of a start request. Strict, so a caller cannot smuggle identity fields in. */
export const verificationStartSchema = z.strictObject({});

/**
 * The reviewer's own reference for the case. A reference is an identifier, so
 * the free-text rule above cannot apply to it: a run of digits is what most
 * references are. A narrow character set does that work instead, and it is what
 * keeps a pasted document out of the one decision field that may hold digits: a
 * data URL carries a colon, a semicolon and a comma, and none of the three fits
 * through here.
 */
export const verificationReferenceSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._#\/-]*$/, "A case reference is letters, digits and simple punctuation. It is not a document and not a pasted file");

/**
 * The states a decision may move a case to: the three a person can actually
 * decide. "pending" is deliberately not one of them. A case is with a reviewer
 * because its owner submitted it with a signed attestation, so recording that
 * state by hand would show a submission that never happened, stamp a decider on
 * a case nobody has decided, and lock the draft behind a signature that does not
 * exist. The way into "pending" is the submit route, and only that.
 */
export const verificationDecisionStatuses = ["verified", "rejected", "expired"] as const;
export type VerificationDecisionStatus = (typeof verificationDecisionStatuses)[number];

/**
 * Body of a decision. Strict for the same reason: anything that is not a state,
 * a case reference, a timestamp or a reason is refused at the boundary.
 */
export const verificationDecisionSchema = z.strictObject({
  status: z.enum(verificationDecisionStatuses),
  reason: verificationReasonSchema.optional(),
  reference: verificationReferenceSchema.optional(),
  expiresAt: z.string().datetime().optional()
});
export type VerificationDecisionInput = z.infer<typeof verificationDecisionSchema>;

/**
 * The entity types the application offers. A closed list: the console renders
 * it, and a free-text type is only a place to type something nobody can read
 * back. Anything unusual is said in the applicant's own words further down.
 */
export const entityTypes = ["company", "partnership", "sole_trader", "trust", "foundation", "nonprofit", "cooperative", "other"] as const;
export type EntityType = (typeof entityTypes)[number];
export const entityTypeSchema = z.enum(entityTypes);

/** How each type is written out, in the console and in the signed statement. */
export const entityTypeLabels: Record<EntityType, string> = {
  company: "Company",
  partnership: "Partnership",
  sole_trader: "Sole trader",
  trust: "Trust",
  foundation: "Foundation",
  nonprofit: "Non-profit",
  cooperative: "Cooperative",
  other: "Other"
};

/**
 * An identifier a register issued: the company number, the postal code. Digits
 * are the whole point of these, so the free-text rule cannot apply. A narrow
 * character set does the same work instead: prose, an email address and a data
 * URL all fail it, so nothing but the identifier fits through.
 */
function registerIdentifier(label: string, max: number) {
  return z.string().trim().min(1).max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 .\/-]*$/, `Write the ${label} as it appears on the register`);
}

/**
 * Where the entity is registered: an ISO 3166-1 country code, with the
 * subdivision after it where the subdivision is the register, as in US-DE.
 * Normalised to upper case so the same jurisdiction always signs as the same
 * bytes, and normalising again changes nothing.
 */
export const jurisdictionSchema = z.string().trim()
  .regex(/^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/, "Use a country code, and add the subdivision where that is the register, as in US-DE")
  .transform((value) => value.toUpperCase());

export const countryCodeSchema = z.string().trim()
  .regex(/^[A-Za-z]{2}$/, "Use a two letter country code")
  .transform((value) => value.toUpperCase());

/**
 * The website, as an address a person can open. Held to http or https on
 * purpose: a data URL is a document, and this field is not a place to put one.
 */
export const verificationWebsiteSchema = z.string().trim().min(4).max(200)
  .refine((value) => /^https?:\/\/[^\s"'<>]+$/i.test(value), "Give the website as an http or https address")
  .refine((value) => !dataUrl.test(value), "Do not paste documents into the website");

/**
 * The number the register issued. Narrow on purpose, and it has to hold a
 * digit: that is what keeps a person's name out of a field that is meant for
 * the register's own identifier.
 */
export const registrationNumberSchema = registerIdentifier("registration number", 50)
  .refine((value) => /\d/.test(value), "A registration number carries a digit. This field is for the register's number, not for anybody's name");

/** The registered address, as the register holds it. A place, not a person. */
export const verificationAddressSchema = z.strictObject({
  line1: freeText("address", 2, 120),
  line2: freeText("address", 1, 120).optional(),
  city: freeText("city", 1, 80),
  region: freeText("region", 1, 80).optional(),
  postalCode: registerIdentifier("postal code", 16),
  country: countryCodeSchema
});
export type VerificationAddress = z.infer<typeof verificationAddressSchema>;

/**
 * What the application asks for: facts about the entity, every one of them
 * something a company register already publishes, plus the applicant's own
 * description of the business. Strict, so a caller cannot smuggle a control
 * person, a date of birth or a document in beside them.
 */
export const verificationProfileSchema = z.strictObject({
  /**
   * The entity's registered name. For a sole trader that name is a person's
   * name, because that is what the register holds: it is still the name of the
   * business applying, not a control person collected on the side, and it is
   * the only place in this module where the two can coincide.
   */
  legalName: freeText("legal name", 2, 200),
  entityType: entityTypeSchema,
  registrationNumber: registrationNumberSchema,
  jurisdiction: jurisdictionSchema,
  registeredAddress: verificationAddressSchema,
  website: verificationWebsiteSchema.optional(),
  businessDescription: freeText("description", 20, 1000)
});
export type VerificationProfile = z.infer<typeof verificationProfileSchema>;
/** A profile as a caller writes it, before jurisdiction and country are normalised. */
export type VerificationProfileInput = z.input<typeof verificationProfileSchema>;

/** One thing the application asks for, and why it asks. */
export interface VerificationRequirement {
  /** Dotted path into the profile, so the console binds an input to it rather than inventing its own name. */
  field: string;
  label: string;
  /** Why it is asked for. Shown as it is. */
  why: string;
  required: boolean;
  /** The shape of an answer, where the shape is not obvious. Never a figure presented as a fact. */
  format?: string;
  /** The closed set of answers, where there is one. */
  options?: readonly { value: string; label: string }[];
}

/**
 * Everything the application asks for, in the order it is asked, with the
 * reason beside it. The console reads this rather than writing its own copy,
 * so what the form says and what the schema accepts cannot drift apart.
 */
export const verificationProfileRequirements: readonly VerificationRequirement[] = [
  { field: "legalName", label: "Legal name", why: "The name the entity is registered under, including the suffix such as Ltd, GmbH or LLC. A trading name is not this.", required: true },
  { field: "entityType", label: "Entity type", why: "What kind of legal entity it is.", required: true, options: entityTypes.map((value) => ({ value, label: entityTypeLabels[value] })) },
  { field: "registrationNumber", label: "Registration number", why: "The number the register issued to the entity, written as the register writes it.", required: true },
  { field: "jurisdiction", label: "Jurisdiction", why: "The register the entity is on.", required: true, format: "A country code, with the subdivision where that is the register, as in US-DE" },
  { field: "registeredAddress.line1", label: "Registered address", why: "The address on the register. Not where anybody lives.", required: true },
  { field: "registeredAddress.line2", label: "Address line 2", why: "The rest of the address, if there is more of it.", required: false },
  { field: "registeredAddress.city", label: "City", why: "The city on the register.", required: true },
  { field: "registeredAddress.region", label: "State or region", why: "The state, province or region, where the address has one.", required: false },
  { field: "registeredAddress.postalCode", label: "Postal code", why: "The postal code on the register.", required: true },
  { field: "registeredAddress.country", label: "Country", why: "The country of the registered address.", required: true, format: "A two letter country code" },
  { field: "website", label: "Website", why: "Somewhere a reviewer can read about the business in its own words.", required: false, format: "An http or https address" },
  { field: "businessDescription", label: "What the business does", why: "In your own words: what it sells, to whom, and what it will use Relay for. This is what a reviewer actually reads.", required: true }
];

/**
 * What the application does not ask for, and what happens to what it does ask
 * for. The console shows these beside the form so nobody reads it as a check.
 */
export const verificationProfileExclusions: readonly string[] = [
  "Nothing here is checked. Floatlane has no verification provider connected, so no register is queried and no answer is confirmed against one.",
  "No document, scan or photograph is asked for, accepted or stored, and there is no field that can carry one.",
  "The people behind the business are not collected here. Control persons are disclosed to a verification provider on the day one exists, not to this form.",
  "Verified here means a named person read the signed statement and recorded a decision under their own name. It means nothing else."
];

/** Names the text a signature covers, so a later version cannot be mistaken for this one. */
export const attestationStatementVersion = "relay-verification-attestation/1";

export interface AttestationInput {
  profile: VerificationProfile;
  organizationId: string;
  principalId: string;
  /** The moment the statement is made, as an instant or an ISO timestamp. */
  at: string | Date;
}

/** The registered address on one line, in register order, skipping the parts that were not given. */
function addressLine(address: VerificationAddress): string {
  return [address.line1, address.line2, address.city, address.region, address.postalCode, address.country].filter((part): part is string => Boolean(part)).join(", ");
}

/**
 * The exact text the owner signs to submit the application.
 *
 * It is a document, not a caption: it names the entity, says what the signer is
 * attesting, says that Floatlane has checked none of it and holds no licence,
 * and says that verification here is a decision a named person records. The
 * organisation, the principal and the moment are in the text, so a signature
 * over one submission cannot be presented as a signature over another.
 *
 * Deterministic by construction: the profile is parsed first, so trimming and
 * case normalisation happen before any byte is written, and the same inputs
 * always produce the same bytes. Downstream that is the whole point, since the
 * server rebuilds this text itself and checks the signature against what it
 * built, never against anything the client sent.
 */
export function attestationStatement(input: AttestationInput): string {
  const parsed = verificationProfileSchema.safeParse(input.profile);
  if (!parsed.success) throw new Error("The verification profile is not complete, so there is nothing to attest to");
  const profile = parsed.data;

  const organizationId = input.organizationId.trim();
  const principalId = input.principalId.trim();
  if (!organizationId || !principalId) throw new Error("An attestation names the organisation and the person signing it");

  const moment = typeof input.at === "string" ? new Date(input.at) : input.at;
  if (Number.isNaN(moment.getTime())) throw new Error("An attestation names the moment it was made");
  const signedAt = moment.toISOString();

  return [
    "Floatlane verification attestation",
    attestationStatementVersion,
    "",
    "This is a statement about a business, made by the person submitting it. It is",
    "not a check of anything. Read it before you sign it.",
    "",
    "The business",
    `  Legal name: ${profile.legalName}`,
    `  Entity type: ${entityTypeLabels[profile.entityType]}`,
    `  Registration number: ${profile.registrationNumber}`,
    `  Jurisdiction: ${profile.jurisdiction}`,
    `  Registered address: ${addressLine(profile.registeredAddress)}`,
    `  Website: ${profile.website ?? "none given"}`,
    `  What the business does: ${profile.businessDescription}`,
    "",
    "What I attest",
    "  1. I am authorised to make this statement on behalf of the business named",
    "     above.",
    "  2. Those facts are true and complete so far as I know, and they match the",
    "     public register the business is registered on.",
    "  3. I will tell Floatlane if any of them stops being true.",
    "",
    "What Floatlane does with it",
    "  4. Floatlane has not checked any of these facts. No verification provider is",
    "     connected to this account, no register has been queried, and no document",
    "     has been asked for, accepted or stored.",
    "  5. Floatlane holds no banking, money transmission or e-money licence, and is",
    "     not a bank. Nothing here is a regulated identity check or a licensed",
    "     service, and signing this does not make it one.",
    "  6. Verification here means one thing: a named person at Floatlane reads this",
    "     statement and records a decision under their own name. That recorded",
    "     decision is the whole of what verified means in this product.",
    "  7. Floatlane does not ask who controls the business. Control persons are",
    "     disclosed to a verification provider on the day one exists, and are not",
    "     collected by this form.",
    "",
    "What I am signing",
    `  Organisation: ${organizationId}`,
    `  Signed by principal: ${principalId}`,
    `  Signed at: ${signedAt}`,
    "",
    "This signature covers this text exactly, for this organisation, this business",
    "and this moment alone. It is not valid for any other organisation, any other",
    "business or any other submission."
  ].join("\n");
}

/**
 * Whether a saved draft holds everything the application asks for. Takes
 * unknown because the draft comes back out of storage, and narrows on the way
 * through so a caller that passes the check can use the profile.
 */
export function profileComplete(profile: unknown): profile is VerificationProfile {
  return verificationProfileSchema.safeParse(profile).success;
}

/** Why a case cannot be submitted for review. Each one is returned to the caller as it is. */
export const verificationSubmitBlocks = [
  "verification_not_started",
  "verification_profile_incomplete",
  "verification_already_submitted",
  "verification_already_verified",
  "verification_rejected",
  "verification_expired"
] as const;
export type VerificationSubmitBlock = (typeof verificationSubmitBlocks)[number];

export type VerificationSubmitCheck = { ok: true } | { ok: false; code: VerificationSubmitBlock; reason: string };

export interface VerificationSubmitSubject {
  status: VerificationStatus;
  profile: unknown;
}

const submitBlockForStatus: Record<Exclude<VerificationStatus, "started">, { code: VerificationSubmitBlock; reason: string }> = {
  unstarted: { code: "verification_not_started", reason: "Verification has not been started, so there is no case to submit. An owner can start it in Settings." },
  pending: { code: "verification_already_submitted", reason: "This case is already with a reviewer. It cannot be submitted again until it has been decided." },
  verified: { code: "verification_already_verified", reason: "A decision is already on file for this case. Start verification again to replace it." },
  rejected: { code: "verification_rejected", reason: "This case was rejected. Start verification again before submitting." },
  expired: { code: "verification_expired", reason: "This case has expired. Start verification again before submitting." }
};

/**
 * Whether the case can go to a reviewer, and if not, why not. The state part is
 * the state machine's answer and not a second copy of it: started is the only
 * status with an edge into pending, so anything else is refused here for the
 * same reason it would be refused there.
 */
export function verificationSubmitCheck(subject: VerificationSubmitSubject): VerificationSubmitCheck {
  if (!canTransitionVerification(subject.status, "pending")) {
    const block = submitBlockForStatus[subject.status as Exclude<VerificationStatus, "started">];
    return { ok: false, code: block.code, reason: block.reason };
  }
  if (!profileComplete(subject.profile)) {
    return { ok: false, code: "verification_profile_incomplete", reason: "The application is not finished. Every required answer has to be filled in before it can go to a reviewer." };
  }
  return { ok: true };
}

/** The same question as a yes or no, for a caller that has no use for the reason. */
export function canSubmitVerification(subject: VerificationSubmitSubject): boolean {
  return verificationSubmitCheck(subject).ok;
}

/**
 * What was submitted for review, once it has been. The statement is kept
 * verbatim because it is what the signature covers: rebuilding it later to
 * check the signature has to produce these exact bytes.
 */
export interface VerificationSubmission {
  submittedAt: string;
  submittedBy: string;
  attestationAddress: string;
  /**
   * The exact text the signature covers, kept verbatim and handed back as it
   * is. A reviewer decides on what was actually signed rather than on a later
   * rendering of the facts, and a reader can check the signature against these
   * bytes. The signature itself stays on the server.
   */
  statement: string;
}

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
    // Not "locked until this is done": a decision is necessary for a gated
    // feature, never sufficient. Cards need a card issuer on top of it, and
    // there is none, so promising that finishing this opens them would be a lie.
    unstarted: `Restricted parts of the console stay locked while this is undecided, and each of them has its own requirements on top of this one. ${unavailable}`,
    started: `The case is open and nothing has been decided. ${unavailable}`,
    pending: `Somebody has to decide it; nothing decides it automatically. ${unavailable}`,
    verified: `Recorded by a person, not by a provider. ${unavailable}`,
    rejected: state.reason ? `Reason given: ${state.reason}` : "No reason was recorded.",
    expired: "Start verification again to unlock the restricted parts of the console."
  };
  return { headline: headlines[state.status], detail: details[state.status], providerConnected, canStart };
}
