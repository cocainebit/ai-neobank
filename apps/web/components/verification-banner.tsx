"use client";

import Link from "next/link";
import { formatDate, type Tone } from "../lib/format";
import { verificationLook, type GatedCapability, type Verification, type VerificationStatus } from "../lib/verification";
import { useSession } from "./session";
import { Notice, Pill } from "./ui";

/**
 * Business verification (KYB) as the rest of the console sees it.
 *
 * The state is real and lives on the organization; the provider is not. Nothing
 * on this server checks an identity, so a verified organization here means a
 * person recorded that decision, and these components say so in those words
 * rather than implying a register was consulted. The API sends the copy for
 * that, and this file shows it rather than writing its own version of the truth.
 *
 * Neither component describes a state the reader cannot act on: both send the
 * person to /verification, where the application actually is.
 */

export { endpointMissing, providerMissing, useVerification, verificationLook } from "../lib/verification";
export type {
  CapabilityDecision,
  GatedCapability,
  Verification,
  VerificationProfile,
  VerificationRequirement,
  VerificationStatus,
  VerificationSubmission,
  VerificationView
} from "../lib/verification";

/** What the link to the application should say, given where the case stands. */
export function applicationCallToAction(status: VerificationStatus): string {
  const labels: Record<VerificationStatus, string> = {
    unstarted: "Start the application",
    started: "Finish the application",
    pending: "See the application",
    verified: "See the application",
    rejected: "Open the application",
    expired: "Open the application"
  };
  return labels[status] ?? "Open the application";
}

export function VerificationPill({ verification }: { verification: Verification }) {
  const look = verificationLook(verification.status);
  return <Pill tone={verification.unavailable ? "neutral" : look.tone}>{verification.unavailable ? "Not available" : look.label}</Pill>;
}

/** One line at the top of a restricted page: whether it is open, and if not, why, and where to go about it. */
export function VerificationBanner({ verification, capability, feature }: { verification: Verification; capability: GatedCapability; feature: string }) {
  if (verification.error) return <Notice tone="negative"><b>Could not read verification.</b> {verification.error.message}</Notice>;
  const gate = verification.capability(capability);
  if (gate.allowed) return <Notice tone="positive"><b>{feature} is unlocked.</b> {verification.detail}</Notice>;
  const tone: Tone = gate.code === "provider_not_connected" ? "neutral" : gate.code === "verification_rejected" || gate.code === "verification_expired" ? "negative" : "pending";
  const actionable = !verification.unavailable && gate.code !== "provider_not_connected" && gate.code !== "organization_frozen";
  return (
    <Notice tone={tone}>
      <b>{feature} is locked.</b> {gate.reason}{" "}
      {actionable && <Link href="/verification" style={{ textDecoration: "underline" }}>{applicationCallToAction(verification.status)}</Link>}
    </Notice>
  );
}

/**
 * Where this organization stands, in the API's own words, and one way in. The
 * application itself lives on its own page, so this panel never offers a button
 * that stands in for filling it in.
 */
export function VerificationPanel({ verification }: { verification: Verification }) {
  const { can } = useSession();
  const look = verificationLook(verification.status);
  const view = verification.view;
  const submission = verification.submission;
  const draft = Boolean(verification.profile);

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Business verification</h2>
          <p>Cards, and anything else a regulated partner would touch, stay locked while this is undecided. A decision is never the whole of what one needs: cards also need a card issuer, and Floatlane has none.</p>
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

        {view && (
          <dl className="kv">
            <dt>Decided by</dt>
            <dd>{view.method === "manual" ? "A person in this organization, recorded by hand" : view.method === "provider" ? view.provider ?? "A provider" : "Nobody yet"}</dd>
            <dt>Application</dt>
            <dd>{submission?.submittedAt ? `Submitted on ${formatDate(submission.submittedAt)}` : draft ? "A draft is saved, not yet submitted" : "Not filled in yet"}</dd>
            {view.startedAt && <><dt>Opened</dt><dd>{formatDate(view.startedAt)}</dd></>}
            {view.reviewedAt && <><dt>Decided</dt><dd>{formatDate(view.reviewedAt)}</dd></>}
            {view.expiresAt && <><dt>Expires</dt><dd>{formatDate(view.expiresAt)}</dd></>}
            {view.reference && <><dt>Case reference</dt><dd>{view.reference}</dd></>}
            {view.reason && <><dt>Reason</dt><dd>{view.reason}</dd></>}
          </dl>
        )}

        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          {verification.unavailable
            ? <span className="faint" style={{ fontSize: 12.5 }}>{verification.unavailable}</span>
            : <>
                <Link className="btn primary" href="/verification">{applicationCallToAction(verification.status)}</Link>
                <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>
                  {can("owner")
                    ? "The application asks about the entity only, and nothing in it is checked against a register."
                    : "Anyone here can read the case. Only an owner can fill it in, sign it, or decide it."}
                </span>
              </>}
        </div>
      </div>
    </section>
  );
}
