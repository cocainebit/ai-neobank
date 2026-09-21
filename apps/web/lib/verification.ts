"use client";

import { useMemo } from "react";
import { api, ApiError, useApi } from "./api";
import type { Tone } from "./format";

/**
 * The console's side of business verification (KYB).
 *
 * Floatlane has no verification provider connected, no licence and no card
 * issuer. Nothing in this file checks an identity, and nothing it renders may
 * imply that something elsewhere did. "Verified" here means a named person
 * recorded a decision, and the screens say that in those words.
 *
 * Everything an applicant is asked for is a fact about the entity, which is
 * public register data. No control person, no date of birth, no government
 * identifier, no document and no scan: those are disclosed to a provider on the
 * day one exists, and the application says so instead of collecting them.
 *
 * The displayable copy for the requirements comes from the API, so the console
 * never keeps its own version of what is asked for or why.
 */

export type VerificationStatus = "unstarted" | "started" | "pending" | "verified" | "rejected" | "expired";

/** Features that stay locked until the organization is verified. */
export type GatedCapability = "cards";

export type CapabilityDecision =
  | { capability: GatedCapability; allowed: true }
  | { capability: GatedCapability; allowed: false; code: string; reason: string };

export interface VerificationAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

/** Facts about the entity. Nothing here is personal data about a person. */
export interface VerificationProfile {
  legalName: string;
  entityType: string;
  registrationNumber: string;
  jurisdiction: string;
  registeredAddress: VerificationAddress;
  website?: string;
  businessDescription: string;
}

/** Who signed the attestation, with which address, when, and the words they signed. */
export interface VerificationSubmission {
  submittedAt: string | null;
  submittedBy: string | null;
  attestationAddress: string | null;
  /** The exact text the signature covers, as the API stored it. Absent on an older server. */
  statement?: string | null;
}

/**
 * One line of what the application asks for and why.
 *
 * The API owns this copy. The shape is read defensively because the console
 * must keep working against a server that words it slightly differently, and
 * because an unreadable entry is better dropped than shown as "undefined".
 */
export interface VerificationRequirement {
  /** The profile field this asks for, when it names one. */
  field: string | null;
  label: string;
  why: string | null;
  optional: boolean;
  /** The shape of an answer, in the API's words, when it states one. */
  format: string | null;
  /**
   * The accepted values, when the API states a closed set. The value is what is
   * sent and the label is what a person reads, because the API's values are
   * machine names and nobody would type `sole_trader` into a box.
   */
  options: { value: string; label: string }[] | null;
}

/** `GET /v1/verification` (apps/api/src/verification-routes.ts, `verificationView`). */
export interface VerificationView {
  status: VerificationStatus;
  provider: string | null;
  reference: string | null;
  method: "manual" | "provider" | null;
  startedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
  expiresAt: string | null;
  reviewedAt: string | null;
  profile?: VerificationProfile | null;
  requirements?: unknown;
  exclusions?: unknown;
  submission?: VerificationSubmission | null;
  banner: { headline: string; detail: string; providerConnected: boolean; canStart: boolean };
  capabilities: Partial<Record<GatedCapability, CapabilityDecision>>;
}

export interface Verification {
  status: VerificationStatus;
  verified: boolean;
  view: VerificationView | null;
  /** The saved draft, or null when nothing has been filled in yet. */
  profile: VerificationProfile | null;
  /** What the application asks for and why, in the API's words. */
  requirements: VerificationRequirement[];
  /** What the application is not, in the API's words. Empty when it sends none. */
  exclusions: string[];
  submission: VerificationSubmission | null;
  /** The API's own words for the current state. */
  headline: string;
  detail: string;
  providerConnected: boolean;
  canStart: boolean;
  /** Why this server cannot answer at all, when that is the case. */
  unavailable: string | null;
  loading: boolean;
  error: ApiError | undefined;
  reload(): Promise<void>;
  /** The gate for one feature, and its reason when it is shut. */
  capability(capability: GatedCapability): CapabilityDecision;
}

/**
 * True when the API has no such route, rather than having answered with a real
 * failure.
 *
 * The code has to be the bare "not found" a router sends when nothing is
 * mounted: Fastify's own 404 body carries `error: "Not Found"`. A 404 that names
 * what was missing, such as `organization_not_found`, is a real answer to a real
 * question, and reading it as a missing route would show the person a sentence
 * about this server lacking the feature when the feature answered.
 */
export function endpointMissing(error: ApiError | undefined): boolean {
  if (!error) return false;
  if (error.status === 501) return true;
  return error.status === 404 && /^not[\s_-]*found$/i.test(error.code.trim());
}

/** True when the route exists but nothing is wired behind it. */
export function providerMissing(error: ApiError | undefined): boolean {
  return Boolean(error && error.status === 503 && error.code.endsWith("_not_configured"));
}

const presentation: Record<VerificationStatus, { tone: Tone; label: string }> = {
  unstarted: { tone: "pending", label: "Not started" },
  started: { tone: "pending", label: "Open" },
  pending: { tone: "pending", label: "With a reviewer" },
  verified: { tone: "positive", label: "Verified" },
  rejected: { tone: "negative", label: "Rejected" },
  expired: { tone: "negative", label: "Expired" }
};

export function verificationLook(status: VerificationStatus): { tone: Tone; label: string } {
  return presentation[status] ?? { tone: "neutral", label: status };
}

/**
 * Legal next states, mirroring `verificationTransitions` in @ai-neobank/domain.
 * The console does not have the domain package as a dependency, so this copy
 * exists to stop the reviewer being offered a decision the API would refuse.
 * The API remains the one that decides.
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
  return verificationTransitions[from]?.includes(to) ?? false;
}

/**
 * The states a decision may actually record, mirroring
 * `verificationDecisionStatuses` in @ai-neobank/domain.
 *
 * "With a reviewer" is deliberately not one of them, although the state machine
 * has an edge into it. A case is with a reviewer because its owner submitted it
 * and signed the attestation, so the decision route refuses that state by name.
 * Offering it here put a move the API always answers 409 to at the top of the
 * reviewer's list, and on an open case it was the option selected by default.
 */
export type VerificationDecisionStatus = "verified" | "rejected" | "expired";

/** The decisions a reviewer may record from here, in the order they are offered. */
export const decisionCopy: { value: VerificationDecisionStatus; label: string; body: string }[] = [
  { value: "verified", label: "Verified", body: "Records that you, by name, decided to treat this business as verified. Nothing was checked: this is your word, and gates that read verification open on it. A gate with its own missing provider, such as cards, stays shut anyway." },
  { value: "rejected", label: "Rejected", body: "Stays locked. An owner can start a new application." },
  { value: "expired", label: "Expired", body: "Stays locked until the application is done again." }
];

export function decisionOptions(from: VerificationStatus): typeof decisionCopy {
  return decisionCopy.filter((option) => canTransitionVerification(from, option.value));
}

// The profile form.

export interface ProfileFieldSpec {
  /** Dotted path into the profile object. */
  path: string;
  /** Fallback label. The API's requirement for this field wins when it has one. */
  label: string;
  kind: "text" | "textarea";
  optional?: boolean;
  placeholder?: string;
  /** Whether the field takes the full width of the form grid. */
  wide?: boolean;
}

/**
 * The fields of `verificationProfileSchema`, in the order a person fills them.
 * Registration number and postal code are left out of the prose checks below,
 * because a run of digits is what they are.
 */
export const profileFields: readonly ProfileFieldSpec[] = [
  { path: "legalName", label: "Legal name", kind: "text", placeholder: "The name on the register", wide: true },
  // The API states the closed set of entity types, and the form renders it as a
  // list. The placeholder is only what a server that states no set would show.
  { path: "entityType", label: "Entity type", kind: "text", placeholder: "As the API lists it" },
  { path: "registrationNumber", label: "Registration number", kind: "text", placeholder: "The register's number for it" },
  { path: "jurisdiction", label: "Jurisdiction", kind: "text", placeholder: "GB-SCT" },
  { path: "website", label: "Website", kind: "text", optional: true, placeholder: "https://" },
  { path: "registeredAddress.line1", label: "Registered address", kind: "text", wide: true, placeholder: "Street" },
  { path: "registeredAddress.line2", label: "Address line two", kind: "text", optional: true, wide: true },
  { path: "registeredAddress.city", label: "City", kind: "text" },
  { path: "registeredAddress.region", label: "Region", kind: "text", optional: true },
  { path: "registeredAddress.postalCode", label: "Postal code", kind: "text" },
  { path: "registeredAddress.country", label: "Country", kind: "text", placeholder: "GB" },
  { path: "businessDescription", label: "What the business does", kind: "textarea", wide: true, placeholder: "In your own words" }
];

/**
 * Fields whose content is prose, and so must not carry a document number or a
 * pasted file. Every field the API holds to its free-text rule is here, so the
 * form does not call a draft ready that the API then refuses on a field the
 * console never looked at. Registration number, postal code, jurisdiction and
 * country are absent because a run of digits is what those are.
 */
export const proseFields: readonly string[] = [
  "legalName",
  "registeredAddress.line1",
  "registeredAddress.line2",
  "registeredAddress.city",
  "registeredAddress.region",
  "businessDescription"
];

export function emptyProfile(): VerificationProfile {
  return {
    legalName: "",
    entityType: "",
    registrationNumber: "",
    jurisdiction: "",
    registeredAddress: { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" },
    website: "",
    businessDescription: ""
  };
}

/**
 * A saved draft as the form needs it: every field present as a string, so an
 * input is never handed undefined and a partial draft does not lose the fields
 * the API left out.
 */
export function hydrateProfile(raw: Partial<VerificationProfile> | null | undefined): VerificationProfile {
  const base = emptyProfile();
  if (!raw || typeof raw !== "object") return base;
  const address = (raw.registeredAddress ?? {}) as Partial<VerificationAddress>;
  const pick = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  return {
    legalName: pick(raw.legalName, base.legalName),
    entityType: pick(raw.entityType, base.entityType),
    registrationNumber: pick(raw.registrationNumber, base.registrationNumber),
    jurisdiction: pick(raw.jurisdiction, base.jurisdiction),
    registeredAddress: {
      line1: pick(address.line1, ""),
      line2: pick(address.line2, ""),
      city: pick(address.city, ""),
      region: pick(address.region, ""),
      postalCode: pick(address.postalCode, ""),
      country: pick(address.country, "")
    },
    website: pick(raw.website, ""),
    businessDescription: pick(raw.businessDescription, base.businessDescription)
  };
}

export function readField(profile: VerificationProfile, path: string): string {
  const [head, tail] = path.split(".") as [keyof VerificationProfile, string | undefined];
  const value = profile[head];
  if (!tail) return typeof value === "string" ? value : "";
  const nested = value as Record<string, string | undefined> | undefined;
  return nested?.[tail] ?? "";
}

export function writeField(profile: VerificationProfile, path: string, value: string): VerificationProfile {
  const [head, tail] = path.split(".");
  if (!tail) return { ...profile, [head as string]: value };
  const nested = { ...(profile[head as keyof VerificationProfile] as unknown as Record<string, string>), [tail]: value };
  return { ...profile, [head as string]: nested };
}

/**
 * Anything that looks like a pasted file rather than typed text.
 *
 * Written to the data URL grammar, and matching the rule in the API's schema:
 * the media type is optional in that grammar, so `data:;base64,` and `data:,`
 * are working data URLs with no media type in them. Insisting on a
 * `type/subtype` let a scan through under either spelling.
 */
export function pastedDocument(value: string): boolean {
  return /data:[a-z0-9.+\/-]*(?:;[a-z0-9.+=-]*)*,/i.test(value);
}

/** A run of digits long enough to be a document or identifier number. */
export function longDigitRun(value: string): boolean {
  return /\d{6,}/.test(value);
}

/**
 * The three fields the API holds to a shape rather than to prose, mirroring
 * `verificationProfileSchema`. They are here so the form does not call a draft
 * finished that the API will refuse, and the message says what the shape is.
 * The API still owns the schema: it is asked either way, and its refusal is
 * what the form shows.
 */
const shapes: Record<string, { pattern: RegExp; message: string }> = {
  jurisdiction: {
    pattern: /^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/,
    message: "Write the jurisdiction as a country code, with the subdivision where that is the register, as in US-DE."
  },
  "registeredAddress.country": { pattern: /^[A-Za-z]{2}$/, message: "Write the country as a two letter code, as in GB." },
  website: { pattern: /^https?:\/\/[^\s"'<>]+$/i, message: "Give the website as an http or https address." }
};

/**
 * What is wrong with one field's value, before the API is asked. It refuses
 * only what is certainly not the answer to the question: a pasted file
 * anywhere, a document number where prose was asked for, and a value that
 * cannot have the shape the API states. Everything else is left to the API,
 * which owns the schema.
 */
export function fieldProblem(path: string, value: string): string | null {
  if (!value.trim()) return null;
  if (pastedDocument(value)) return "Do not paste documents or images here. Relay stores none, and this field takes typed text.";
  if (proseFields.includes(path) && longDigitRun(value)) return "Do not put document or identifier numbers here. This field takes typed words, and the API refuses a long run of digits in it.";
  const shape = shapes[path];
  if (shape && !shape.pattern.test(value.trim())) return shape.message;
  return null;
}

/** Required fields that are still blank, in form order. */
export function missingProfileFields(profile: VerificationProfile): string[] {
  return profileFields.filter((field) => !field.optional && !readField(profile, field.path).trim()).map((field) => field.path);
}

export function profileProblems(profile: VerificationProfile): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const field of profileFields) {
    const problem = fieldProblem(field.path, readField(profile, field.path));
    if (problem) problems[field.path] = problem;
  }
  return problems;
}

export function profileComplete(profile: VerificationProfile): boolean {
  return missingProfileFields(profile).length === 0 && Object.keys(profileProblems(profile)).length === 0;
}

/** Drops the optional fields the applicant left blank, so a strict schema is not handed empty strings. */
export function profileForApi(profile: VerificationProfile): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const address: Record<string, string> = {};
  for (const field of profileFields) {
    const value = readField(profile, field.path).trim();
    if (!value && field.optional) continue;
    const [head, tail] = field.path.split(".");
    if (tail) address[tail] = value;
    else body[head as string] = value;
  }
  body.registeredAddress = address;
  return body;
}

// What the API says is asked for, and why.

function text(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return list.length > 0 ? list : null;
}

/**
 * A closed set of answers as the API states it. Each entry is either a plain
 * string, which is both the value and the label, or an object carrying the
 * value that is sent and the words a person reads. An entry with no value is
 * dropped: offering a choice that cannot be submitted is worse than not
 * offering it.
 */
function options(value: unknown): { value: string; label: string }[] | null {
  if (!Array.isArray(value)) return null;
  const list: { value: string; label: string }[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) { list.push({ value: entry.trim(), label: entry.trim() }); continue; }
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const chosen = text(source, ["value", "id", "key"]);
    if (!chosen) continue;
    list.push({ value: chosen, label: text(source, ["label", "title", "name"]) ?? chosen });
  }
  return list.length > 0 ? list : null;
}

/**
 * Reads the API's requirements list into something displayable. A plain string
 * is taken as the line itself; an object is read for a label, the reason it is
 * asked for, and a closed set of values when there is one. An entry with
 * nothing readable in it is dropped rather than rendered empty.
 */
export function normalizeRequirements(raw: unknown): VerificationRequirement[] {
  if (!Array.isArray(raw)) return [];
  const list: VerificationRequirement[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) list.push({ field: null, label: entry.trim(), why: null, optional: false, format: null, options: null });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const field = text(source, ["field", "key", "path", "name"]);
    const label = text(source, ["label", "title", "heading", "name", "field", "key"]);
    if (!label) continue;
    list.push({
      field,
      label,
      why: text(source, ["why", "reason", "detail", "description", "note", "because"]),
      optional: source.optional === true || source.required === false,
      format: text(source, ["format", "shape", "pattern"]),
      options: options(source.options) ?? options(source.values) ?? options(source.enum)
    });
  }
  return list;
}

/** The requirement that names a given profile field, matched whole or by its last segment. */
export function requirementFor(requirements: VerificationRequirement[], path: string): VerificationRequirement | null {
  const tail = path.split(".").pop() ?? path;
  return requirements.find((requirement) => requirement.field === path)
    ?? requirements.find((requirement) => requirement.field === tail)
    ?? null;
}

// Errors the API sends back for a rejected body.

interface ZodFlattened { fieldErrors?: Record<string, unknown>; formErrors?: unknown }

/**
 * Per-field messages out of a 400. Fastify sends `details` as the flattened Zod
 * error, so a refused field is shown beside the input rather than as one
 * unreadable blob at the bottom of the form.
 */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.status !== 400) return {};
  const details = error.details as ZodFlattened | undefined;
  const fieldErrors = details?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object") return {};
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldErrors)) {
    const first = Array.isArray(value) ? value.find((entry) => typeof entry === "string") : typeof value === "string" ? value : null;
    if (first) messages[key] = first;
  }
  return messages;
}

/** Messages a 400 gave about the body as a whole rather than one field. */
export function formErrorsFrom(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const details = error.details as ZodFlattened | undefined;
  const formErrors = Array.isArray(details?.formErrors) ? details.formErrors : [];
  return formErrors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

// Calls.

export async function startVerification(): Promise<void> {
  await api("/v1/verification", { method: "POST", body: {} });
}

export async function saveProfile(profile: VerificationProfile): Promise<void> {
  await api("/v1/verification/profile", { method: "PUT", body: profileForApi(profile) });
}

/** The exact words the owner is about to sign, built by the server from the saved draft. */
export async function readAttestation(): Promise<string> {
  const response = await api<{ data: { statement: string } }>("/v1/verification/attestation");
  const statement = response.data?.statement;
  if (typeof statement !== "string" || !statement.trim()) throw new Error("The API did not return a statement to sign.");
  return statement;
}

export async function submitApplication(address: string, signature: string): Promise<void> {
  await api("/v1/verification/submit", { method: "POST", body: { address, signature } });
}

export async function recordDecision(body: { status: string; reason?: string; reference?: string }): Promise<void> {
  await api("/v1/verification/decision", { method: "POST", body });
}

const blocked = (reason: string): CapabilityDecision => ({ capability: "cards", allowed: false, code: "verification_required", reason });

export function useVerification(organizationId?: string): Verification {
  const resource = useApi<VerificationView>("/v1/verification");
  const { data, error, loading, reload } = resource;

  return useMemo<Verification>(() => {
    const routeMissing = endpointMissing(error) || providerMissing(error);
    const unavailable = routeMissing
      ? "This server has no verification route yet, so nothing about verification can be read or started here."
      : null;
    const view = data ?? null;
    const status: VerificationStatus = view?.status ?? "unstarted";
    return {
      status,
      verified: status === "verified",
      view,
      profile: view?.profile ?? null,
      requirements: normalizeRequirements(view?.requirements),
      exclusions: strings(view?.exclusions) ?? [],
      submission: view?.submission ?? null,
      headline: view?.banner.headline ?? (unavailable ? "Verification is not available" : "Verification has not been read yet"),
      detail: view?.banner.detail ?? unavailable ?? "",
      providerConnected: view?.banner.providerConnected ?? false,
      canStart: Boolean(view?.banner.canStart) && !unavailable,
      unavailable,
      loading,
      error: routeMissing ? undefined : error,
      reload,
      capability: (capability) =>
        view?.capabilities?.[capability]
        ?? blocked(unavailable ?? "Relay could not read this organization's verification, so restricted features stay locked.")
    };
    // organizationId is here so a switch of organization rebuilds the gate.
  }, [data, error, loading, reload, organizationId]);
}
