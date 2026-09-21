import { z } from "zod";
import { intentStatuses, type IntentStatus } from "./primitives.js";

/**
 * Time locks and rejections as pure decisions. Nothing here reads a chain or a
 * database: callers pass in what they observed, so the same rules are testable
 * without either.
 *
 * Two limits are encoded here rather than hidden. Only a Squads multisig carries
 * a time lock Relay can read and change; a Safe has none of its own and Relay
 * does not pretend otherwise. And a rejection can only end a payment that is
 * still collecting approvals: once quorum is reached the payment belongs to the
 * executor, and once it is on chain nothing can recall it.
 */

/** Squads stores the lock as u32 seconds and the program caps it at three months. */
export const maxTimeLockSeconds = 90 * 24 * 60 * 60;

export const timeLockSources = ["squads_multisig", "none"] as const;
export type TimeLockSource = (typeof timeLockSources)[number];

export const timeLockChangeSchema = z.object({
  seconds: z.number().int().min(0).max(maxTimeLockSeconds),
  memo: z.string().min(1).max(200).optional()
});
export type TimeLockChangeInput = z.infer<typeof timeLockChangeSchema>;

export interface TimeLockReading {
  source: TimeLockSource;
  seconds: number;
  /** True when the chain itself refuses an early execution. False means nothing does, including Relay. */
  enforcedOnChain: boolean;
  /** True when Relay can prepare a change the owners sign. */
  changeable: boolean;
  note: string;
}

/** Narrows a status string from the database, which allows values this module does not decide on. */
export function asIntentStatus(value: string): IntentStatus | null {
  return (intentStatuses as readonly string[]).includes(value) ? (value as IntentStatus) : null;
}

/** What the treasury's observed configuration says about its delay, in the words the console shows. */
export function readTimeLock(input: { governance: "safe" | "squads" | "direct"; observed: { timeLock?: unknown } }): TimeLockReading {
  if (input.governance === "squads") {
    const raw = input.observed.timeLock;
    const seconds = typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
    return {
      source: "squads_multisig",
      seconds,
      enforcedOnChain: true,
      changeable: true,
      note: seconds === 0
        ? "No delay. An approved payment can be executed as soon as it reaches the threshold."
        : `The Squads program refuses execution until ${seconds} seconds after the proposal is approved.`
    };
  }
  if (input.governance === "safe") {
    return {
      source: "none",
      seconds: 0,
      enforcedOnChain: false,
      changeable: false,
      note: "A Safe has no time lock of its own, and Relay does not enforce one. A delay needs a guard or a delay module installed on the Safe outside Relay."
    };
  }
  return { source: "none", seconds: 0, enforcedOnChain: false, changeable: false, note: "A direct treasury has no governance, so nothing delays a payment from it." };
}

export interface TimeLockState {
  source: TimeLockSource;
  seconds: number;
  /** When the delay started running: the moment the approval became final. Null while approvals are still being collected. */
  startedAt: string | null;
  executableAt: string | null;
  remainingSeconds: number;
  locked: boolean;
}

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Where an approved payment stands against its treasury's delay. */
export function timeLockState(input: { reading: TimeLockReading; approvedAt: string | null; now: Date }): TimeLockState {
  const { source, seconds } = input.reading;
  const startedAt = instant(input.approvedAt) === null ? null : input.approvedAt;
  if (seconds <= 0) return { source, seconds, startedAt, executableAt: startedAt, remainingSeconds: 0, locked: false };
  const started = instant(startedAt);
  if (started === null) return { source, seconds, startedAt: null, executableAt: null, remainingSeconds: seconds, locked: false };
  const executable = new Date(started + seconds * 1000);
  const remainingSeconds = Math.max(0, Math.ceil((executable.getTime() - input.now.getTime()) / 1000));
  return { source, seconds, startedAt, executableAt: executable.toISOString(), remainingSeconds, locked: remainingSeconds > 0 };
}

export const controlRefusalCodes = [
  "time_locked",
  "execution_not_approved",
  "intent_not_pending",
  "intent_already_approved",
  "intent_already_executing",
  "intent_already_executed",
  "intent_already_rejected",
  "approval_not_published",
  "approval_expired",
  "rejection_not_supported"
] as const;
export type ControlRefusalCode = (typeof controlRefusalCodes)[number];

/** A refusal carries the reason a person reads, not only a code. */
export interface ControlRefusal {
  allowed: false;
  code: ControlRefusalCode;
  message: string;
}

const refuse = (code: ControlRefusalCode, message: string): ControlRefusal => ({ allowed: false, code, message });

export interface ExecutionAllowed {
  allowed: true;
  executableAt: string | null;
}

/**
 * Whether an approved payment may be executed now. The Squads program enforces
 * the same rule on chain; this is what Relay shows and refuses on beforehand, so
 * an early attempt is a clear answer instead of a failed transaction.
 */
export function evaluateExecution(input: { intentStatus: IntentStatus; timeLock: TimeLockState }): ExecutionAllowed | ControlRefusal {
  if (input.intentStatus !== "approved" && input.intentStatus !== "executing") {
    return refuse("execution_not_approved", `A payment is executed once it is approved; this one is ${input.intentStatus}.`);
  }
  if (input.timeLock.locked) {
    return refuse("time_locked", `The treasury's time lock holds this payment until ${input.timeLock.executableAt}, ${input.timeLock.remainingSeconds} seconds from now.`);
  }
  return { allowed: true, executableAt: input.timeLock.executableAt };
}

export const rejectionKinds = ["safe_nonce_burn", "squads_proposal_reject"] as const;
export type RejectionKind = (typeof rejectionKinds)[number];

export interface RejectionPlan {
  allowed: true;
  kind: RejectionKind;
  /** The only state a rejection may leave the payment in. */
  endsAs: Extract<IntentStatus, "rejected">;
}

/**
 * Whether the owners may cancel this payment on chain, and with which
 * transaction. A Safe burns the nonce with a zero value call to itself; a Squads
 * vault takes a rejection vote on the proposal.
 */
export function evaluateRejection(input: {
  intentStatus: IntentStatus;
  governance: "safe" | "squads" | "direct";
  approvalStatus: string | null;
  approvalExpiresAt: string | null;
  now: Date;
}): RejectionPlan | ControlRefusal {
  if (input.intentStatus === "rejected") return refuse("intent_already_rejected", "This payment was already rejected.");
  if (["submitted", "finalized", "reconciled"].includes(input.intentStatus)) {
    return refuse("intent_already_executed", "This payment is already on chain. A rejection cannot recall it.");
  }
  if (input.intentStatus === "executing") {
    return refuse("intent_already_executing", "The executor is signing this payment. Freeze the treasury to stop it.");
  }
  if (input.intentStatus === "approved" || input.intentStatus === "auto_authorized") {
    return refuse("intent_already_approved", "This payment already has the approvals it needs and is queued for execution. Freeze the treasury to stop it.");
  }
  if (input.intentStatus !== "approval_required") {
    return refuse("intent_not_pending", `A payment can only be rejected while it is collecting approvals; this one is ${input.intentStatus}.`);
  }
  if (input.governance === "direct") {
    return refuse("rejection_not_supported", "A direct treasury has no proposal to cancel on chain. Reject the payment in Relay instead.");
  }
  if (input.approvalStatus !== "pending") return refuse("approval_not_published", "This payment has no pending approval request to cancel.");
  const expires = instant(input.approvalExpiresAt);
  if (expires === null || expires <= input.now.getTime()) {
    return refuse("approval_expired", "The approval window has closed, so the payment expires on its own.");
  }
  return { allowed: true, kind: input.governance === "safe" ? "safe_nonce_burn" : "squads_proposal_reject", endsAs: "rejected" };
}

/** The only intent transition a rejection may cause. Every other start state is an illegal transition. */
export function rejectionTransition(from: IntentStatus): IntentStatus | null {
  return from === "approval_required" ? "rejected" : null;
}

/** The Squads proposal states a time lock change moves through, named as the program names them. */
export const timeLockChangeStatuses = ["draft", "active", "approved", "executing", "executed", "rejected", "cancelled"] as const;
export type TimeLockChangeStatus = (typeof timeLockChangeStatuses)[number];

export const timeLockChangeEvents = ["approve", "reject", "cancel", "execute"] as const;
export type TimeLockChangeEvent = (typeof timeLockChangeEvents)[number];

/**
 * Whether an event may be attempted against a config proposal in this state, and
 * the state it reaches when it completes. An approve vote on an active proposal
 * only reaches `approved` once the threshold is met, so this answers what the
 * event can reach, never what it has reached.
 */
export function nextTimeLockChangeStatus(from: TimeLockChangeStatus, event: TimeLockChangeEvent): TimeLockChangeStatus | null {
  switch (from) {
    // Relay creates proposals active; a draft has to be activated before anyone can vote.
    case "active": return event === "approve" ? "approved" : event === "reject" ? "rejected" : null;
    case "approved": return event === "cancel" ? "cancelled" : event === "execute" ? "executed" : null;
    case "executing": return event === "execute" ? "executed" : null;
    default: return null;
  }
}

/** Narrows the status string an observation carries. */
export function asTimeLockChangeStatus(value: string): TimeLockChangeStatus | null {
  return (timeLockChangeStatuses as readonly string[]).includes(value) ? (value as TimeLockChangeStatus) : null;
}
