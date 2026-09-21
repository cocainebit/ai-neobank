"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { invalidate } from "../lib/api";
import { usePrincipalNames } from "../lib/data";
import { formatDate, shortAddress } from "../lib/format";
import { signPlain } from "../lib/sign";
import {
  decisionOptions,
  fieldErrorsFrom,
  formErrorsFrom,
  hydrateProfile,
  longDigitRun,
  missingProfileFields,
  pastedDocument,
  profileFields,
  profileProblems,
  readAttestation,
  readField,
  recordDecision,
  requirementFor,
  saveProfile,
  startVerification,
  submitApplication,
  useVerification,
  verificationLook,
  writeField,
  type ProfileFieldSpec,
  type Verification,
  type VerificationProfile,
  type VerificationRequirement,
  type VerificationStatus
} from "../lib/verification";
import { Icons } from "./icons";
import { useSession } from "./session";
import { CopyField, Empty, ErrorState, Field, LoadingRows, Modal, Notice, Pill, useAction } from "./ui";

/**
 * The verification application, end to end.
 *
 * An owner reads what is asked for and why, fills in who the business is,
 * reads the exact words they are about to sign, signs them with the wallet they
 * are signed in with, and then the case sits until a named person decides it.
 *
 * Nothing on this page checks anything. Floatlane has no verification provider,
 * no licence and no card issuer, so there is no score, no progress bar and no
 * spinner that would suggest work is happening somewhere out of sight. The
 * statement says so before it is signed, and the verified screen says so after.
 */

const statusIntro: Record<VerificationStatus, string> = {
  unstarted: "Nothing has been filled in yet.",
  started: "The application is open and has not been submitted.",
  pending: "Submitted. It is waiting for a person to decide it.",
  verified: "A named person recorded this decision.",
  rejected: "A named person rejected it.",
  expired: "The previous decision has run out."
};

export function VerificationApplication() {
  const { can } = useSession();
  const verification = useVerification();
  const owner = can("owner");

  if (verification.error) return <section className="panel"><ErrorState error={verification.error} retry={() => void verification.reload()} /></section>;
  if (verification.unavailable) {
    return (
      <section className="panel"><div className="panel-body">
        <Notice tone="negative"><b>Verification is not available on this server.</b> {verification.unavailable}</Notice>
      </div></section>
    );
  }
  if (verification.loading && !verification.view) {
    return <section className="panel"><LoadingRows rows={5} /></section>;
  }

  return (
    <div className="grid-main">
      <div className="stack">
        <CaseState verification={verification} />
        {verification.status === "unstarted" && <NotStarted verification={verification} owner={owner} />}
        {verification.status === "started" && <OpenApplication verification={verification} owner={owner} />}
        {verification.status === "pending" && <InReview verification={verification} />}
        {verification.status === "verified" && <Verified verification={verification} />}
        {(verification.status === "rejected" || verification.status === "expired") && <Undecided verification={verification} owner={owner} />}
      </div>
      <div className="stack">
        <Requirements requirements={verification.requirements} />
        {owner && decisionOptions(verification.status).length > 0 && <Reviewer verification={verification} />}
        <WhatThisIsNot exclusions={verification.exclusions} />
      </div>
    </div>
  );
}

// The case, in the API's own words.

function CaseState({ verification }: { verification: Verification }) {
  const names = usePrincipalNames();
  const look = verificationLook(verification.status);
  const view = verification.view;
  const submission = verification.submission;
  const who = (principalId: string | null | undefined) => (principalId ? names.get(principalId)?.name ?? `Principal ${principalId.slice(0, 8)}` : null);

  return (
    <section className="panel">
      <header className="panel-head">
        <div><h2>This application</h2><p>{statusIntro[verification.status]}</p></div>
        <Pill tone={look.tone}>{look.label}</Pill>
      </header>
      <div className="panel-body stack">
        <div className="lock-state">
          <span className={`lock-dot ${look.tone}`} />
          <div><b>{verification.headline}</b><span className="faint">{verification.detail}</span></div>
        </div>
        {view && (
          <dl className="kv">
            <dt>Decided by</dt>
            <dd>{view.method === "manual" ? `${who(view.decidedBy) ?? "A person in this organization"}, recorded by hand` : view.method === "provider" ? view.provider ?? "A provider" : "Nobody yet"}</dd>
            {view.startedAt && <><dt>Opened</dt><dd>{formatDate(view.startedAt)}</dd></>}
            {submission?.submittedAt && <><dt>Submitted</dt><dd>{formatDate(submission.submittedAt)}{submission.submittedBy ? ` by ${who(submission.submittedBy)}` : ""}</dd></>}
            {submission?.attestationAddress && <><dt>Signed with</dt><dd className="address">{shortAddress(submission.attestationAddress, 10, 8)}</dd></>}
            {view.reviewedAt && <><dt>Decided</dt><dd>{formatDate(view.reviewedAt)}</dd></>}
            {view.expiresAt && <><dt>Expires</dt><dd>{formatDate(view.expiresAt)}</dd></>}
            {view.reference && <><dt>Case reference</dt><dd>{view.reference}</dd></>}
            {view.reason && <><dt>Reason</dt><dd>{view.reason}</dd></>}
          </dl>
        )}
      </div>
    </section>
  );
}

// Before anything has been filled in.

function NotStarted({ verification, owner }: { verification: Verification; owner: boolean }) {
  const { busy, run } = useAction();

  async function start() {
    const done = await run("start", async () => { await startVerification(); return true; }, "Application opened");
    if (done) { invalidate("/v1/verification"); await verification.reload(); }
  }

  return (
    <section className="panel">
      <header className="panel-head"><div><h2>Apply</h2><p>Four things happen, and none of them is a check.</p></div></header>
      <div className="panel-body stack">
        <ol className="steps">
          <li><b>Say who the business is</b><span>Legal name, entity type, registration number, jurisdiction, registered address, and what it does. All of it is register data about the entity.</span></li>
          <li><b>Read the statement</b><span>The API writes the exact words. You see all of them, including the part saying nobody has checked them, before your wallet opens.</span></li>
          <li><b>Sign it with your wallet</b><span>The signature binds the words to the address you signed in with. It moves no money and grants no spending authority.</span></li>
          <li><b>A person decides it</b><span>An owner reads the application and records a decision under their own name, and that owner can be you. Nothing decides it automatically, and nothing is sent anywhere.</span></li>
        </ol>
        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          <button className="btn primary" disabled={!owner || !verification.canStart || busy !== null} onClick={() => void start()}>
            {busy === "start" ? "Opening…" : "Start the application"}
          </button>
          <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>
            {owner ? "Opens a case on this organization. Nothing is sent anywhere." : "Only an owner can fill in or decide this application."}
          </span>
        </div>
      </div>
    </section>
  );
}

// The open case: fill it in, read the statement, sign it.

const steps = ["business", "attest"] as const;
const stepLabels: Record<(typeof steps)[number], string> = { business: "The business", attest: "Attest and submit" };

function OpenApplication({ verification, owner }: { verification: Verification; owner: boolean }) {
  const { session } = useSession();
  const { busy, run } = useAction();
  const [step, setStep] = useState<(typeof steps)[number]>("business");
  const [draft, setDraft] = useState<VerificationProfile>(() => hydrateProfile(verification.profile));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [statement, setStatement] = useState<string | null>(null);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [restated, setRestated] = useState(false);

  const local = profileProblems(draft);
  const missing = missingProfileFields(draft);
  const ready = missing.length === 0 && Object.keys(local).length === 0;
  const walletBound = Boolean(session.wallet);

  async function persist(): Promise<boolean> {
    const done = await run("save", async () => {
      try {
        await saveProfile(draft);
        setServerErrors({});
        setFormErrors([]);
        return true;
      } catch (error) {
        setServerErrors(fieldErrorsFrom(error));
        setFormErrors(formErrorsFrom(error));
        throw error;
      }
    }, "Draft saved");
    if (done) { invalidate("/v1/verification"); await verification.reload(); }
    return Boolean(done);
  }

  async function toAttest() {
    if (!(await persist())) return;
    setStep("attest");
  }

  // The words come from the API and are shown in full before the wallet opens.
  useEffect(() => {
    if (step !== "attest" || !owner) return;
    let live = true;
    setStatementError(null);
    void readAttestation()
      .then((value) => { if (live) { setStatement(value); setRestated(false); } })
      .catch((error: unknown) => { if (live) setStatementError(error instanceof Error ? error.message : "The statement could not be read."); });
    return () => { live = false; };
  }, [step, owner]);

  async function signAndSubmit() {
    if (!session.wallet || !statement) return;
    const done = await run("submit", async () => {
      // The server builds the statement from the saved draft and checks the
      // signature against its own copy. Re-reading it here means nobody signs
      // words they were not shown.
      const fresh = await readAttestation();
      if (fresh !== statement) {
        setStatement(fresh);
        setRestated(true);
        throw new Error("The statement changed since you read it. Read it again before signing.");
      }
      const signature = await signPlain(session, fresh);
      await submitApplication(session.wallet!.address, signature);
      return true;
    }, "Submitted for review");
    if (done) { invalidate("/v1/verification"); await verification.reload(); }
  }

  if (!owner) {
    return (
      <section className="panel">
        <header className="panel-head"><div><h2>The business</h2><p>What has been filled in so far.</p></div></header>
        <div className="panel-body">
          {verification.profile ? <ProfileFacts profile={verification.profile} /> : <Empty title="Nothing filled in yet">An owner fills this in. Only an owner can sign and submit it.</Empty>}
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div><h2>{stepLabels[step]}</h2><p>{step === "business" ? "Facts about the entity. Nothing here is personal data, and nothing is checked." : "Read every word before you sign it."}</p></div>
      </header>
      <div className="panel-body stack">
        <ol className="wizard" aria-label="Steps">
          {steps.map((entry, index) => (
            <li key={entry} aria-current={entry === step ? "step" : undefined} className={steps.indexOf(step) > index ? "done" : ""}>
              <span>{steps.indexOf(step) > index ? <Icons.Check /> : index + 1}</span>{stepLabels[entry]}
            </li>
          ))}
        </ol>

        {step === "business" && (
          <>
            <div className="form-grid">
              {profileFields.map((field) => (
                <ProfileInput
                  key={field.path}
                  field={field}
                  value={readField(draft, field.path)}
                  requirements={verification.requirements}
                  problem={local[field.path] ?? serverErrors[field.path] ?? serverErrors[field.path.split(".")[0] as string] ?? null}
                  onChange={(value) => setDraft((current) => writeField(current, field.path, value))}
                />
              ))}
            </div>
            {formErrors.length > 0 && <Notice tone="negative"><b>The API refused this.</b> {formErrors.join(" ")}</Notice>}
            <Notice>
              <b>Relay asks about the entity, not about people.</b> There is no field here for a director, an owner, a date of birth, a government identifier or a document, because none of that is stored. Control persons are disclosed to a verification provider on the day there is one, and there is none.
            </Notice>
            <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
              <button className="btn" disabled={busy !== null} onClick={() => void persist()}>{busy === "save" ? "Saving…" : "Save the draft"}</button>
              <button className="btn primary" disabled={busy !== null || !ready} onClick={() => void toAttest()}>Read the statement</button>
              <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>
                {ready ? "Saves the draft, then shows the exact words you would sign." : `${missing.length} required field${missing.length === 1 ? "" : "s"} still to fill in.`}
              </span>
            </div>
          </>
        )}

        {step === "attest" && (
          <>
            <ProfileFacts profile={draft} />
            <div className="field">
              <span>What you are signing</span>
              {statementError
                ? <Notice tone="negative"><b>The statement could not be read.</b> {statementError}</Notice>
                : statement
                  ? <pre className="code" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{statement}</pre>
                  : <span className="faint" style={{ fontSize: 13 }}>Reading the statement from the API.</span>}
              <small>Written by the API from the draft above. Your wallet is asked to sign these words and nothing else.</small>
            </div>
            {restated && <Notice tone="pending"><b>The statement changed.</b> It was rebuilt from the draft as it is now. Read it again, then sign.</Notice>}
            {!walletBound && <Notice tone="negative"><b>No wallet is bound to this session.</b> Sign out and sign in with the wallet you want on the attestation.</Notice>}
            <Notice tone="pending">
              <b>Signing attests. It does not verify.</b> The signature proves the address you signed in with put its name to these facts. Nobody checks them: Floatlane has no verification provider connected, so no register is consulted and no score exists.
            </Notice>
            <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
              <button className="btn" disabled={busy !== null} onClick={() => setStep("business")}>Back to the business</button>
              <button className="btn primary" disabled={busy !== null || !statement || !walletBound} onClick={() => void signAndSubmit()}>
                <Icons.Wallet />{busy === "submit" ? "Waiting for your wallet…" : "Sign and submit"}
              </button>
              <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>
                {session.wallet ? <>Signs with <span className="address">{shortAddress(session.wallet.address, 6, 4)}</span>. It moves no money.</> : "A wallet is needed to sign."}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ProfileInput({ field, value, requirements, problem, onChange }: {
  field: ProfileFieldSpec;
  value: string;
  requirements: VerificationRequirement[];
  problem: string | null;
  onChange(value: string): void;
}) {
  const requirement = requirementFor(requirements, field.path);
  const optional = requirement?.optional ?? field.optional ?? false;
  const label = `${requirement?.label ?? field.label}${optional ? " (optional)" : ""}`;
  // The reason it is asked for, and the shape of an answer where the API states one.
  const why = [requirement?.why, requirement?.format].filter(Boolean).join(" ");
  const hint = problem ? <span className="negative">{problem}</span> : why || undefined;
  const options = requirement?.options ?? null;

  return (
    <Field label={label} hint={hint} className={field.wide ? "span-2" : ""}>
      {options
        ? (
          <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose one</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )
        : field.kind === "textarea"
          ? <textarea className="textarea" value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
          : <input className="input" value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

/** The entity as it stands, read only. */
function ProfileFacts({ profile }: { profile: VerificationProfile }) {
  const address = [profile.registeredAddress?.line1, profile.registeredAddress?.line2, profile.registeredAddress?.city, profile.registeredAddress?.region, profile.registeredAddress?.postalCode, profile.registeredAddress?.country]
    .map((part) => (part ?? "").trim()).filter(Boolean).join(", ");
  return (
    <dl className="kv">
      <dt>Legal name</dt><dd>{profile.legalName || <span className="faint">Not given</span>}</dd>
      <dt>Entity type</dt><dd>{profile.entityType || <span className="faint">Not given</span>}</dd>
      <dt>Registration number</dt><dd className="num">{profile.registrationNumber || <span className="faint">Not given</span>}</dd>
      <dt>Jurisdiction</dt><dd>{profile.jurisdiction || <span className="faint">Not given</span>}</dd>
      <dt>Registered address</dt><dd>{address || <span className="faint">Not given</span>}</dd>
      {profile.website && <><dt>Website</dt><dd>{profile.website}</dd></>}
      <dt>What it does</dt><dd>{profile.businessDescription || <span className="faint">Not given</span>}</dd>
    </dl>
  );
}

// Submitted, and decided.

function InReview({ verification }: { verification: Verification }) {
  const submission = verification.submission;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2>Waiting for a decision</h2><p>It sits here until a person records one.</p></div></header>
      <div className="panel-body stack">
        <Notice tone="pending">
          <b>Nothing is happening in the background.</b> No provider was contacted, nothing is being checked, and no result is on its way. An owner reads this application and records a decision under their own name.
        </Notice>
        {submission?.attestationAddress && (
          <div className="field">
            <span>Signed by</span>
            <CopyField value={submission.attestationAddress} label={submission.attestationAddress} />
            <small>{submission.submittedAt ? `Attested on ${formatDate(submission.submittedAt)}.` : "The address that signed the attestation."} The draft is locked while the case is with a reviewer.</small>
          </div>
        )}
        {submission?.statement && (
          <div className="field">
            <span>What was signed</span>
            <pre className="code" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{submission.statement}</pre>
            <small>The exact words the signature covers, as the API stored them.</small>
          </div>
        )}
        {verification.profile && <ProfileFacts profile={verification.profile} />}
      </div>
    </section>
  );
}

function Verified({ verification }: { verification: Verification }) {
  const names = usePrincipalNames();
  const decidedBy = verification.view?.decidedBy;
  const decider = decidedBy ? names.get(decidedBy)?.name ?? `Principal ${decidedBy.slice(0, 8)}` : null;
  const cards = verification.capability("cards");

  return (
    <section className="panel">
      <header className="panel-head"><div><h2>What this verification means</h2><p>Said plainly, because the word carries more weight than the thing behind it.</p></div></header>
      <div className="panel-body stack">
        <Notice tone="positive">
          <b>{decider ? `${decider} recorded this decision.` : "A person in this organization recorded this decision."}</b>{" "}
          {verification.view?.reviewedAt ? `It was recorded on ${formatDate(verification.view.reviewedAt)}.` : ""} Relay stores who decided and when, and says so wherever the state is shown.
        </Notice>
        <div className="grid-2">
          <div className="fact-card">
            <b>What it means</b>
            <p>{verification.submission
              ? "A named person read this application and the owner's signed attestation, and put their own name to the decision. The restricted parts of this console read that decision."
              : "A named person recorded this decision under their own name. Nothing was signed on this case: it was decided while the application was open, so there is no attestation behind it."}</p>
          </div>
          <div className="fact-card">
            <b>What it does not mean</b>
            <p>Nobody checked the business. No register was consulted, no provider was asked, no identity document was seen, and no score exists. Floatlane has no verification provider connected.</p>
          </div>
        </div>
        <Notice tone={cards.allowed ? "neutral" : "pending"}>
          <b>Cards still cannot be issued.</b> {cards.allowed
            ? "The verification gate is open, but a card needs an issuer and a licence, and Floatlane has neither."
            : cards.reason}{" "}
          <Link href="/cards" style={{ textDecoration: "underline" }}>See what a card here would be</Link>.
        </Notice>
        {verification.profile && <ProfileFacts profile={verification.profile} />}
      </div>
    </section>
  );
}

function Undecided({ verification, owner }: { verification: Verification; owner: boolean }) {
  const { busy, run } = useAction();
  const rejected = verification.status === "rejected";

  async function again() {
    const done = await run("start", async () => { await startVerification(); return true; }, "A new application is open");
    if (done) { invalidate("/v1/verification"); await verification.reload(); }
  }

  return (
    <section className="panel">
      <header className="panel-head"><div><h2>{rejected ? "This application was rejected" : "This verification has expired"}</h2><p>{rejected ? "The reason is the reviewer's own words." : "A new application replaces it."}</p></div></header>
      <div className="panel-body stack">
        <Notice tone="negative">
          <b>{rejected ? "Rejected." : "Expired."}</b>{" "}
          {rejected
            ? verification.view?.reason ?? "No reason was recorded."
            : verification.view?.expiresAt ? `It ran out on ${formatDate(verification.view.expiresAt)}.` : "It is no longer current."}
        </Notice>
        {verification.profile && (
          <div className="field">
            <span>What was on the application</span>
            <ProfileFacts profile={verification.profile} />
            <small>Starting again opens a new case. The draft above is the starting point for it.</small>
          </div>
        )}
        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          <button className="btn primary" disabled={!owner || !verification.canStart || busy !== null} onClick={() => void again()}>
            {busy === "start" ? "Opening…" : "Start a new application"}
          </button>
          <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>{owner ? "Nothing is sent anywhere." : "Only an owner can start it again."}</span>
        </div>
      </div>
    </section>
  );
}

// The reviewer's side.

function Reviewer({ verification }: { verification: Verification }) {
  const [open, setOpen] = useState(false);
  const options = decisionOptions(verification.status);

  return (
    <section className="panel">
      <header className="panel-head"><div><h2>Record a decision</h2><p>Yours, under your name.</p></div></header>
      <div className="panel-body stack">
        <ul className="fact-list">
          <li>You are deciding on what the applicant wrote and signed. There is nothing else to read, because nothing else was collected.</li>
          <li>Relay stores the decision as manual, with your principal and the time on it. It never appears as a provider's answer.</li>
          <li>{verification.submission?.attestationAddress ? "The attestation was signed by the address shown beside the case." : "No attestation has been signed on this case yet."}</li>
          <li>Nothing here requires a second person. Any owner can record this, including the owner who submitted it.</li>
        </ul>
        <button className="btn primary" onClick={() => setOpen(true)} disabled={options.length === 0}>Record a decision</button>
      </div>
      {open && <RecordDecision verification={verification} onClose={() => setOpen(false)} />}
    </section>
  );
}

function RecordDecision({ verification, onClose }: { verification: Verification; onClose(): void }) {
  const { busy, run } = useAction();
  const options = decisionOptions(verification.status);
  const [status, setStatus] = useState<string>(options[0]?.value ?? "verified");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  // The same two rules the API holds these fields to: prose carries no document
  // number and no pasted file, and a reference is an identifier, not a sentence.
  const reasonProblem = reason.trim()
    ? pastedDocument(reason) ? "Do not paste documents or images into the reason." : longDigitRun(reason) ? "Do not put document or identifier numbers in the reason." : null
    : null;
  const referenceProblem = reference.trim() && !/^[A-Za-z0-9][A-Za-z0-9 ._#/-]*$/.test(reference.trim())
    ? "A case reference is letters, digits and simple punctuation. It is not a document and not a pasted file."
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const done = await run("decide", async () => {
      await recordDecision({ status, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) });
      return true;
    }, "Decision recorded");
    if (done) { invalidate("/v1/verification"); await verification.reload(); onClose(); }
  }

  return (
    <Modal
      title="Record a verification decision"
      description="Relay stores this as a decision a person made, with your name on it. Nothing here is checked against a register."
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="record-decision" disabled={busy !== null || Boolean(reasonProblem) || Boolean(referenceProblem)}>{busy ? "Recording…" : "Record it"}</button>
      </>}
    >
      <form id="record-decision" className="form-grid" onSubmit={(event) => void submit(event)}>
        <div className="field span-2">
          <span>Decision</span>
          <div className="rows panel">
            {options.map((option) => (
              <label key={option.value} className="row" style={{ cursor: "pointer" }}>
                <span className="cell-title"><b>{option.label}</b><span style={{ whiteSpace: "normal" }}>{option.body}</span></span>
                <input type="radio" name="decision" checked={status === option.value} onChange={() => setStatus(option.value)} />
              </label>
            ))}
          </div>
          <small>Only the moves the API allows from here are offered.</small>
        </div>
        <Field label="Case reference" hint={referenceProblem ? <span className="negative">{referenceProblem}</span> : "Optional. Your own reference for the case: letters, digits and simple punctuation."}>
          <input className="input" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} placeholder="Internal reference" />
        </Field>
        <Field label="Reason" hint={reasonProblem ? <span className="negative">{reasonProblem}</span> : "Optional. The API refuses document numbers and pasted files."}>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Why this decision was made" />
        </Field>
        <div className="span-2">
          <Notice tone="pending">
            <b>This is not an identity check.</b> Recording &quot;verified&quot; opens the verification half of every gate that reads it, on your word alone. It is not on its own enough for cards: those need a card issuer, and Floatlane has none, so they stay shut either way. Relay keeps who decided and when, and says so wherever the state is shown.
          </Notice>
        </div>
      </form>
    </Modal>
  );
}

// The two aside panels.

function Requirements({ requirements }: { requirements: VerificationRequirement[] }) {
  return (
    <section className="panel">
      <header className="panel-head"><div><h2>What this asks for</h2><p>And why. Sent by the API, so this page cannot drift from what is actually stored.</p></div></header>
      {requirements.length === 0
        ? <Empty title="The API sent no list">This server has not said what the application asks for. The fields on the form are what it accepts.</Empty>
        : (
          <div className="panel-body">
            <ul className="fact-list">
              {requirements.map((requirement, index) => (
                <li key={`${requirement.field ?? "line"}-${index}`}>
                  <span>
                    <b style={{ fontWeight: 550 }}>{requirement.label}</b>{requirement.optional ? <span className="faint"> (optional)</span> : null}
                    {requirement.why && <span style={{ display: "block", color: "var(--faint)", fontSize: 13 }}>{requirement.why}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
    </section>
  );
}

/**
 * The limits of the word verified here, in the API's own words where it sends
 * them, so this panel and the schema cannot drift apart. The lines below are
 * what a server that sends none would show, and the card line is this console's
 * own: it is about the cards gate rather than about the application.
 */
const ownExclusions = [
  "Nothing is checked. Floatlane has no verification provider connected, so no register is consulted, no document is seen, and no score or confidence number exists.",
  "Relay asks about the entity only. No control person, no date of birth, no government identifier, no document and no photograph is asked for, and nothing is stored under any of those names. The form refuses a pasted file, but it cannot stop somebody typing a person's name into a sentence, so do not.",
  "Control persons are disclosed to a verification provider on the day there is one. Until then the application does not collect them.",
  "Verified means a named person recorded a decision. Relay keeps their name and the time, and shows both wherever the state appears."
];

function WhatThisIsNot({ exclusions }: { exclusions: string[] }) {
  const lines = exclusions.length > 0 ? exclusions : ownExclusions;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2>What this is not</h2><p>The honest limits of the word verified here.</p></div></header>
      <div className="panel-body">
        <ul className="fact-list">
          {lines.map((line) => <li key={line}>{line}</li>)}
          <li>Cards need a card issuer and a licence as well as this decision. Floatlane has neither, so no card can be issued whatever this case says.</li>
        </ul>
      </div>
    </section>
  );
}
