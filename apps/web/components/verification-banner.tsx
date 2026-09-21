"use client";

import { useMemo, useState } from "react";
import { api, ApiError, invalidate, useApi } from "../lib/api";
import { formatDate, type Tone } from "../lib/format";
import { useSession } from "./session";
import { Field, Modal, Notice, Pill, useAction } from "./ui";

/**
 * Business verification (KYB) as the console sees it.
 *
 * The state is real and lives on the organization; the provider is not. Nothing
 * on this server checks an identity, so a verified organization here means a
 * person recorded that decision, and the console says so in those words rather
 * than implying a register was consulted. The API sends the copy for that, and
 * this file shows it rather than writing its own version of the truth.
 */
export type VerificationStatus = "unstarted" | "started" | "pending" | "verified" | "rejected" | "expired";

/** Features that stay locked until the organization is verified. */
export type GatedCapability = "cards";

export type CapabilityDecision =
  | { capability: GatedCapability; allowed: true }
  | { capability: GatedCapability; allowed: false; code: string; reason: string };

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
  banner: { headline: string; detail: string; providerConnected: boolean; canStart: boolean };
  capabilities: Partial<Record<GatedCapability, CapabilityDecision>>;
}

export interface Verification {
  status: VerificationStatus;
  verified: boolean;
  view: VerificationView | null;
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

/** True when the API has no such route, rather than having answered with a real failure. */
export function endpointMissing(error: ApiError | undefined): boolean {
  if (!error) return false;
  if (error.status === 501) return true;
  return error.status === 404 && /not\s*found/i.test(error.code);
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
 * What a business verification usually asks for. It is deliberately not
 * presented as a provider's list, because the API sends none: no provider has
 * stated one, and Relay accepts and stores no identity data today.
 */
export const usualRequirements = [
  "The legal entity: registered name, number, and registered address",
  "Who owns and controls it: directors, and anyone holding 25 percent or more",
  "Government identity documents for those people",
  "What the business does, and where the money it spends comes from",
  "The treasuries and wallets this account will spend from"
];

const blocked = (reason: string): CapabilityDecision => ({ capability: "cards", allowed: false, code: "verification_required", reason });

export function useVerification(): Verification {
  const { session } = useSession();
  const resource = useApi<VerificationView>("/v1/verification");
  const { data, error, loading, reload } = resource;
  const organizationId = session.organization.id;

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

export function VerificationPill({ verification }: { verification: Verification }) {
  const look = verificationLook(verification.status);
  return <Pill tone={verification.unavailable ? "neutral" : look.tone}>{verification.unavailable ? "Not available" : look.label}</Pill>;
}

/** One line at the top of a restricted page: whether it is open, and if not, why. */
export function VerificationBanner({ verification, capability, feature }: { verification: Verification; capability: GatedCapability; feature: string }) {
  if (verification.error) return <Notice tone="negative"><b>Could not read verification.</b> {verification.error.message}</Notice>;
  const gate = verification.capability(capability);
  if (gate.allowed) return <Notice tone="positive"><b>{feature} is unlocked.</b> {verification.detail}</Notice>;
  const tone: Tone = gate.code === "provider_not_connected" ? "neutral" : gate.code === "verification_rejected" || gate.code === "verification_expired" ? "negative" : "pending";
  return <Notice tone={tone}><b>{feature} is locked.</b> {gate.reason}</Notice>;
}

/**
 * The full verification surface: where this organization stands, in the API's
 * own words, what it will be asked for, and the two things an owner can
 * actually do here.
 */
export function VerificationPanel({ verification }: { verification: Verification }) {
  const { can } = useSession();
  const look = verificationLook(verification.status);
  const { busy, run } = useAction();
  const [deciding, setDeciding] = useState(false);

  async function start() {
    const result = await run("start", () => api("/v1/verification", { method: "POST", body: {} }), "Verification started");
    if (result) { invalidate("/v1/verification"); await verification.reload(); }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Business verification</h2>
          <p>Cards, and anything else a regulated partner would touch, stay locked until this passes.</p>
        </div>
        <VerificationPill verification={verification} />
      </header>
      <div className="panel-body stack">
        <div className="lock-state">
          <span className={`lock-dot ${verification.unavailable ? "" : look.tone}`} />
          <div>
            <b>{verification.headline}</b>
            <span className="faint">{verification.detail}</span>
          </div>
        </div>

        {verification.view && (
          <dl className="kv">
            <dt>Decided by</dt>
            <dd>{verification.view.method === "manual" ? "A person in this organization, recorded by hand" : verification.view.method === "provider" ? verification.view.provider ?? "A provider" : "Nobody yet"}</dd>
            {verification.view.startedAt && <><dt>Started</dt><dd>{formatDate(verification.view.startedAt)}</dd></>}
            {verification.view.reviewedAt && <><dt>Decided</dt><dd>{formatDate(verification.view.reviewedAt)}</dd></>}
            {verification.view.expiresAt && <><dt>Expires</dt><dd>{formatDate(verification.view.expiresAt)}</dd></>}
            {verification.view.reference && <><dt>Case reference</dt><dd>{verification.view.reference}</dd></>}
            {verification.view.reason && <><dt>Reason</dt><dd>{verification.view.reason}</dd></>}
          </dl>
        )}

        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>What it will ask for</div>
          <ul className="fact-list">
            {usualRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}
          </ul>
          <small className="faint" style={{ display: "block", marginTop: 8 }}>
            This is what a business account is usually asked for. No provider is connected to this server, so nothing above is collected, sent, or stored by Relay today.
          </small>
        </div>

        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          <button className="btn primary" disabled={!can("owner") || !verification.canStart || busy !== null} onClick={() => void start()}>
            {busy === "start" ? "Starting…" : verification.status === "unstarted" ? "Start verification" : "Start it again"}
          </button>
          {can("owner") && verification.view && verification.status !== "unstarted" && (
            <button className="btn" disabled={busy !== null} onClick={() => setDeciding(true)}>Record a decision</button>
          )}
          <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>
            {!can("owner")
              ? "Only an owner can start or decide verification."
              : verification.unavailable
                ? verification.unavailable
                : verification.canStart
                  ? "Opens a case on this organization. Nothing is sent anywhere."
                  : "A case is already open or decided."}
          </span>
        </div>
      </div>

      {deciding && <RecordDecision verification={verification} onClose={() => setDeciding(false)} />}
    </section>
  );
}

const decisions = [
  { value: "pending", label: "With a reviewer", body: "Somebody is looking at it. Restricted features stay locked." },
  { value: "verified", label: "Verified", body: "Unlocks the restricted parts of the console for this organization." },
  { value: "rejected", label: "Rejected", body: "Stays locked. An owner can start a new case." },
  { value: "expired", label: "Expired", body: "Stays locked until it is done again." }
] as const;

/**
 * An owner records the decision by hand, because that is the only honest way to
 * a decided state in this build. The record says it was manual, so nobody later
 * reads it as a provider's answer.
 */
function RecordDecision({ verification, onClose }: { verification: Verification; onClose(): void }) {
  const { busy, run } = useAction();
  const [status, setStatus] = useState<(typeof decisions)[number]["value"]>("verified");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await run("decide", () => api("/v1/verification/decision", {
      method: "POST",
      body: { status, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) }
    }), "Decision recorded");
    if (result) { invalidate("/v1/verification"); await verification.reload(); onClose(); }
  }

  return (
    <Modal
      title="Record a verification decision"
      description="Relay stores this as a decision a person made, with your name on it. Nothing here is checked against a register."
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="record-decision" disabled={busy !== null}>{busy ? "Recording…" : "Record it"}</button>
      </>}
    >
      <form id="record-decision" className="form-grid" onSubmit={(event) => void submit(event)}>
        <div className="field span-2">
          <span>Decision</span>
          <div className="rows panel">
            {decisions.map((option) => (
              <label key={option.value} className="row" style={{ cursor: "pointer" }}>
                <span className="cell-title"><b>{option.label}</b><span>{option.body}</span></span>
                <input type="radio" name="decision" checked={status === option.value} onChange={() => setStatus(option.value)} />
              </label>
            ))}
          </div>
        </div>
        <Field label="Case reference" hint="Optional. A reference for the case, never a document number.">
          <input className="input" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} placeholder="Internal reference" />
        </Field>
        <Field label="Reason" hint="Optional, 3 to 500 characters. The API refuses document numbers and pasted files.">
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Why this decision was made" />
        </Field>
        <div className="span-2">
          <Notice tone="pending">
            <b>This is not an identity check.</b> Recording &quot;verified&quot; unlocks restricted parts of the console on your word alone. Relay keeps who decided and when, and says so wherever the state is shown.
          </Notice>
        </div>
      </form>
    </Modal>
  );
}
