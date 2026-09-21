import { describe, expect, it } from "vitest";
import {
  asIntentStatus,
  asTimeLockChangeStatus,
  describeIntentStatus,
  evaluateExecution,
  evaluateRejection,
  intentStatuses,
  nextTimeLockChangeStatus,
  readTimeLock,
  rejectionTransition,
  timeLockChangeSchema,
  timeLockState,
  type IntentStatus,
  type TimeLockChangeEvent,
  type TimeLockChangeStatus
} from "./index.js";

const now = new Date("2026-09-21T12:00:00.000Z");
const approvedAt = "2026-09-21T11:50:00.000Z";
const expiresAt = "2026-09-22T12:00:00.000Z";

const rejection = (overrides: Partial<Parameters<typeof evaluateRejection>[0]> = {}) => evaluateRejection({
  intentStatus: "approval_required",
  governance: "safe",
  approvalStatus: "pending",
  approvalExpiresAt: expiresAt,
  now,
  ...overrides
});

describe("time lock readings", () => {
  it("reads a Squads delay from the observed configuration", () => {
    const reading = readTimeLock({ governance: "squads", observed: { timeLock: 3600 } });
    expect(reading).toMatchObject({ source: "squads_multisig", seconds: 3600, enforcedOnChain: true, changeable: true });
  });

  it("says a Safe has no time lock instead of inventing one", () => {
    const reading = readTimeLock({ governance: "safe", observed: { timeLock: 3600 } });
    expect(reading).toMatchObject({ source: "none", seconds: 0, enforcedOnChain: false, changeable: false });
    expect(reading.note).toContain("no time lock of its own");
  });

  it("treats a missing or nonsensical delay as no delay", () => {
    expect(readTimeLock({ governance: "squads", observed: {} }).seconds).toBe(0);
    expect(readTimeLock({ governance: "squads", observed: { timeLock: "3600" } }).seconds).toBe(0);
    expect(readTimeLock({ governance: "squads", observed: { timeLock: -5 } }).seconds).toBe(0);
    expect(readTimeLock({ governance: "direct", observed: { timeLock: 60 } }).seconds).toBe(0);
  });

  it("caps a change at the three months the program allows", () => {
    expect(timeLockChangeSchema.safeParse({ seconds: 86_400 }).success).toBe(true);
    expect(timeLockChangeSchema.safeParse({ seconds: 90 * 24 * 60 * 60 + 1 }).success).toBe(false);
    expect(timeLockChangeSchema.safeParse({ seconds: 1.5 }).success).toBe(false);
    expect(timeLockChangeSchema.safeParse({ seconds: -1 }).success).toBe(false);
  });
});

describe("time lock state", () => {
  const reading = readTimeLock({ governance: "squads", observed: { timeLock: 3600 } });

  it("counts from the approval and says when the payment becomes executable", () => {
    const state = timeLockState({ reading, approvedAt, now });
    expect(state).toMatchObject({ locked: true, executableAt: "2026-09-21T12:50:00.000Z", remainingSeconds: 3000, startedAt: approvedAt });
  });

  it("clears once the delay has run", () => {
    const state = timeLockState({ reading, approvedAt: "2026-09-21T10:00:00.000Z", now });
    expect(state.locked).toBe(false);
    expect(state.remainingSeconds).toBe(0);
  });

  it("does not start the clock before the approval is final", () => {
    const state = timeLockState({ reading, approvedAt: null, now });
    expect(state).toMatchObject({ locked: false, startedAt: null, executableAt: null, remainingSeconds: 3600 });
  });

  it("locks nothing when there is no delay", () => {
    const state = timeLockState({ reading: readTimeLock({ governance: "safe", observed: {} }), approvedAt, now });
    expect(state).toMatchObject({ locked: false, seconds: 0, executableAt: approvedAt });
  });

  it("ignores an unparseable approval time rather than locking forever", () => {
    expect(timeLockState({ reading, approvedAt: "not a date", now }).locked).toBe(false);
  });
});

describe("execution against a time lock", () => {
  const reading = readTimeLock({ governance: "squads", observed: { timeLock: 3600 } });

  it("refuses to execute inside the time lock, with the time it clears", () => {
    const decision = evaluateExecution({ intentStatus: "approved", timeLock: timeLockState({ reading, approvedAt, now }) });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.code).toBe("time_locked");
    expect(decision.message).toContain("2026-09-21T12:50:00.000Z");
  });

  it("allows execution once the lock has run out", () => {
    const decision = evaluateExecution({ intentStatus: "approved", timeLock: timeLockState({ reading, approvedAt: "2026-09-21T10:00:00.000Z", now }) });
    expect(decision).toEqual({ allowed: true, executableAt: "2026-09-21T11:00:00.000Z" });
  });

  it("keeps refusing a payment that is still being approved", () => {
    const decision = evaluateExecution({ intentStatus: "approval_required", timeLock: timeLockState({ reading, approvedAt: null, now }) });
    expect(decision).toMatchObject({ allowed: false, code: "execution_not_approved" });
  });

  it("lets an execution already under way through so a retry is not blocked", () => {
    const decision = evaluateExecution({ intentStatus: "executing", timeLock: timeLockState({ reading, approvedAt: "2026-09-21T10:00:00.000Z", now }) });
    expect(decision.allowed).toBe(true);
  });

  // The refusal is shown to a person, and it used to interpolate the raw status
  // into the sentence: "this one is approval_required". That reads as a bug to
  // whoever is shown it.
  it("refuses in words, never by printing the status code", () => {
    const decision = evaluateExecution({ intentStatus: "approval_required", timeLock: timeLockState({ reading, approvedAt: null, now }) });
    const message = "message" in decision ? decision.message : "";
    expect(message).toContain("waiting for an approval");
    expect(message).not.toContain("approval_required");
    expect(message).not.toMatch(/[a-z]_[a-z]/);
  });

  it("has a phrase for every status, so a new one cannot fall back to its own name", () => {
    for (const status of intentStatuses) {
      const phrase = describeIntentStatus(status);
      expect(phrase.length).toBeGreaterThan(2);
      expect(phrase).not.toContain("_");
    }
    expect(describeIntentStatus("something_else")).toBe("in a state this build does not recognise");
  });
});

describe("rejecting a payment", () => {
  it("cancels a Safe payment by burning its nonce", () => {
    expect(rejection()).toEqual({ allowed: true, kind: "safe_nonce_burn", endsAs: "rejected" });
  });

  it("cancels a Squads payment with a rejection vote", () => {
    expect(rejection({ governance: "squads" })).toEqual({ allowed: true, kind: "squads_proposal_reject", endsAs: "rejected" });
  });

  it("refuses a rejection after the payment is on chain", () => {
    for (const intentStatus of ["submitted", "finalized", "reconciled"] as const) {
      const decision = rejection({ intentStatus });
      expect(decision).toMatchObject({ allowed: false, code: "intent_already_executed" });
    }
  });

  it("refuses a rejection once the executor is signing, and points at the freeze", () => {
    const decision = rejection({ intentStatus: "executing" });
    expect(decision).toMatchObject({ allowed: false, code: "intent_already_executing" });
    if (decision.allowed) throw new Error("expected a refusal");
    expect(decision.message).toContain("Freeze the treasury");
  });

  it("refuses a rejection once the payment has its approvals", () => {
    expect(rejection({ intentStatus: "approved" })).toMatchObject({ allowed: false, code: "intent_already_approved" });
    expect(rejection({ intentStatus: "auto_authorized" })).toMatchObject({ allowed: false, code: "intent_already_approved" });
  });

  it("refuses to reject a payment twice", () => {
    expect(rejection({ intentStatus: "rejected" })).toMatchObject({ allowed: false, code: "intent_already_rejected" });
  });

  it("refuses every other state as not pending", () => {
    for (const intentStatus of ["received", "policy_evaluated", "failed", "expired"] as const) {
      expect(rejection({ intentStatus })).toMatchObject({ allowed: false, code: "intent_not_pending" });
    }
  });

  it("has nothing on chain to cancel for a direct treasury", () => {
    expect(rejection({ governance: "direct" })).toMatchObject({ allowed: false, code: "rejection_not_supported" });
  });

  it("refuses when no approval request was published", () => {
    expect(rejection({ approvalStatus: null })).toMatchObject({ allowed: false, code: "approval_not_published" });
    expect(rejection({ approvalStatus: "approved" })).toMatchObject({ allowed: false, code: "approval_not_published" });
  });

  it("refuses once the approval window has closed", () => {
    expect(rejection({ approvalExpiresAt: "2026-09-21T11:00:00.000Z" })).toMatchObject({ allowed: false, code: "approval_expired" });
    expect(rejection({ approvalExpiresAt: null })).toMatchObject({ allowed: false, code: "approval_expired" });
    expect(rejection({ approvalExpiresAt: "whenever" })).toMatchObject({ allowed: false, code: "approval_expired" });
  });

  it("ends the payment in rejected and nothing else", () => {
    expect(rejectionTransition("approval_required")).toBe("rejected");
    const illegal: IntentStatus[] = ["received", "policy_evaluated", "auto_authorized", "approved", "executing", "submitted", "finalized", "reconciled", "rejected", "failed", "expired"];
    for (const from of illegal) expect(rejectionTransition(from)).toBeNull();
  });
});

describe("the time lock change proposal", () => {
  it("moves through the states the program allows", () => {
    expect(nextTimeLockChangeStatus("active", "approve")).toBe("approved");
    expect(nextTimeLockChangeStatus("active", "reject")).toBe("rejected");
    expect(nextTimeLockChangeStatus("approved", "execute")).toBe("executed");
    expect(nextTimeLockChangeStatus("approved", "cancel")).toBe("cancelled");
    expect(nextTimeLockChangeStatus("executing", "execute")).toBe("executed");
  });

  it("refuses every illegal transition", () => {
    const illegal: [TimeLockChangeStatus, TimeLockChangeEvent][] = [
      ["active", "execute"], ["active", "cancel"], ["draft", "approve"], ["draft", "execute"],
      ["approved", "approve"], ["approved", "reject"], ["executing", "approve"], ["executing", "cancel"],
      ["executed", "execute"], ["executed", "cancel"], ["rejected", "approve"], ["rejected", "execute"], ["cancelled", "execute"]
    ];
    for (const [from, event] of illegal) expect(nextTimeLockChangeStatus(from, event)).toBeNull();
  });

  it("only accepts statuses the program reports", () => {
    expect(asTimeLockChangeStatus("approved")).toBe("approved");
    expect(asTimeLockChangeStatus("Approved")).toBeNull();
    expect(asTimeLockChangeStatus("stale")).toBeNull();
  });
});

describe("intent status narrowing", () => {
  it("accepts the statuses the domain decides on and refuses the rest", () => {
    expect(asIntentStatus("approval_required")).toBe("approval_required");
    expect(asIntentStatus("compiling")).toBeNull();
    expect(asIntentStatus("")).toBeNull();
  });
});
