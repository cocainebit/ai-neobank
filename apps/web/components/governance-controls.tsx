"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, invalidate, useApi } from "../lib/api";
import { governanceLabel, useIntents, useMembers, useSigners } from "../lib/data";
import { formatDate, networkLabel, sentence, shortAddress } from "../lib/format";
import { sessionWallet, waitForConfirmation } from "../lib/sign";
import type { Intent, Treasury } from "../lib/types";
import { signEvmTypedData, signSolanaTransaction } from "../lib/wallet";
import { Icons } from "./icons";
import { useSession } from "./session";
import { Ago, CopyField, Drawer, Empty, LoadingRows, Modal, Notice, Pill, useAction } from "./ui";
import { endpointMissing } from "./verification-banner";

/**
 * Governance of one vault: who approves, how long an approved payment waits,
 * and how a payment is rejected on chain.
 *
 * Every reading here comes from the API, which reads the multisig itself. This
 * file never decides that something is safe to execute; it shows what the chain
 * and the API say, and hands the wallet whatever they prepared.
 */

/** `observedConfiguration` carries `timeLock` for Squads; `lib/types.ts` does not declare it. */
export interface ObservedConfiguration {
  owners?: string[];
  threshold?: number;
  multisigPda?: string;
  timeLock?: number;
  members?: { key: string; canVote: boolean; canExecute: boolean; canInitiate: boolean }[];
  observedAt?: string;
}

export function observedConfig(treasury: Treasury): ObservedConfiguration {
  return (treasury.observedConfiguration ?? {}) as ObservedConfiguration;
}

/** Addresses that can vote on this treasury, in the order the chain reports them. */
export function voterAddresses(treasury: Treasury): string[] {
  const configuration = observedConfig(treasury);
  if (treasury.governance === "safe") return configuration.owners ?? [];
  return (configuration.members ?? []).filter((member) => member.canVote).map((member) => member.key);
}

/** Squads stores the delay as seconds and the program caps it at three months. */
export const maxTimeLockSeconds = 90 * 24 * 60 * 60;
export const maxTimeLockHours = maxTimeLockSeconds / 3_600;

/** A delay in seconds, in words. "No delay" when there is none. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "No delay";
  const units: [number, string][] = [[86_400, "day"], [3_600, "hour"], [60, "minute"], [1, "second"]];
  const parts: string[] = [];
  let left = Math.floor(seconds);
  for (const [size, name] of units) {
    const count = Math.floor(left / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      left -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

export function Countdown({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const update = () => {
      const left = Math.round((new Date(iso).getTime() - Date.now()) / 1_000);
      setText(left <= 0 ? "executable now" : `executable in ${formatDuration(left)}`);
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return <span className="num">{text || " "}</span>;
}

// API shapes, from apps/api/src/governance-controls-routes.ts.

interface TimeLockReading {
  treasuryId: string;
  governance: "safe" | "squads" | "direct";
  source: "squads_multisig" | "none";
  seconds: number;
  enforcedOnChain: boolean;
  changeable: boolean;
  note: string;
  evidence?: { source?: string; observedAt?: string | null; note?: string; error?: string; nonce?: number; modules?: string[]; guard?: string | null };
}

interface TimeLockState {
  source: string;
  seconds: number;
  startedAt: string | null;
  executableAt: string | null;
  remainingSeconds: number;
  locked: boolean;
}

interface PreparedTimeLockChange {
  treasuryId: string;
  multisigPda: string;
  transactionIndex: string;
  transactionBase64: string;
  member: string;
  seconds: number;
  previousSeconds: number;
  requiredApprovals: number;
  note: string;
}

interface TimeLockChange {
  transactionIndex: string;
  proposalPda: string | null;
  status: string;
  statusAt: string | null;
  approved: number;
  rejected: number;
  cancelled: number;
  requiredApprovals: number;
  timeLock: TimeLockState;
  executable: boolean;
}

interface IntentTimeLock {
  intentId: string;
  status: string;
  source: string;
  enforcedOnChain: boolean;
  note: string;
  timeLock: TimeLockState;
  execution: { allowed: true; executableAt: string | null } | { allowed: false; code: string; message: string };
}

interface PreparedRejection {
  intentId: string;
  expectedIntentVersion: number;
  compiledHash: string | null;
  simulationHash: string | null;
  endsAs: string;
  kind: "safe_nonce_burn" | "squads_proposal_reject";
  note: string;
  safeAddress?: string;
  chainId?: number;
  nonce?: number;
  owners?: string[];
  safeTxHash?: string;
  typedData?: unknown;
  multisigPda?: string;
  transactionIndex?: string;
  proposalPda?: string | null;
  transactionBase64?: string;
  member?: string;
}

const changeKey = (treasuryId: string) => `relay.timelock-change.${treasuryId}`;

function readChangeIndex(treasuryId: string): string | null {
  try { return window.localStorage.getItem(changeKey(treasuryId)); } catch { return null; }
}
function writeChangeIndex(treasuryId: string, index: string | null): void {
  try {
    if (index) window.localStorage.setItem(changeKey(treasuryId), index);
    else window.localStorage.removeItem(changeKey(treasuryId));
  } catch { /* a browser that refuses storage simply cannot follow a change across reloads */ }
}

/** Signs a Solana transaction the API prepared, relays it, and waits for the cluster. */
async function sendPrepared(transactionBase64: string): Promise<string> {
  const signed = await signSolanaTransaction(transactionBase64);
  const relayed = await api<{ data: { signature: string } }>("/v1/relay/solana", { method: "POST", body: { transactionBase64: signed } });
  await waitForConfirmation("solana", relayed.data.signature);
  return relayed.data.signature;
}

export function GovernanceControls({ treasury, onClose }: { treasury: Treasury; onClose(): void }) {
  const { session, can } = useSession();
  const members = useMembers();
  const signers = useSigners();
  const intents = useIntents();
  const configuration = observedConfig(treasury);
  const voters = voterAddresses(treasury);
  const executor = signers.data?.find((signer) => signer.id === treasury.executorSignerId);
  const [rejecting, setRejecting] = useState<Intent | null>(null);

  const ownerName = (address: string) =>
    session.wallet?.address.toLowerCase() === address.toLowerCase()
      ? "You"
      : members.data?.find((member) => member.wallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase()))?.displayName;

  const waiting = (intents.data ?? []).filter((intent) =>
    intent.treasuryAccountId === treasury.id && ["approval_required", "approved", "executing", "submitted"].includes(intent.status));

  return (
    <Drawer
      title={treasury.name}
      description={<>{governanceLabel[treasury.governance]} on {networkLabel(treasury.network)}</>}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div className="panel milled">
        <div className="panel-body stack">
          <CopyField value={treasury.address} label={shortAddress(treasury.address, 12, 10)} />
          <dl className="kv">
            <dt>Approvals</dt><dd>{configuration.threshold ?? "?"} of {voters.length} {treasury.governance === "safe" ? "owners" : "voting members"}, enforced on chain</dd>
            {configuration.observedAt && <><dt>Last read from chain</dt><dd><Ago iso={configuration.observedAt} /></dd></>}
          </dl>
        </div>
      </div>

      <section>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Who approves</div>
        <div className="panel"><div className="rows">
          {voters.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>The chain has not been read for this treasury yet.</span></div>}
          {voters.map((address) => (
            <div key={address} className="row">
              <span className="truncate">{ownerName(address) ?? <span className="faint">Not a member here</span>}</span>
              <span className="address faint" style={{ fontSize: 12.5 }}>{shortAddress(address)}</span>
            </div>
          ))}
          {executor && (
            <div className="row">
              <span className="cell-title"><b>Relay executor</b><span>{treasury.governance === "safe" ? "Submits what the owners signed. Not an owner." : "Proposes and executes. It cannot vote."}</span></span>
              <span className="address faint" style={{ fontSize: 12.5 }}>{shortAddress(executor.address)}</span>
            </div>
          )}
        </div></div>
        <small className="faint" style={{ display: "block", marginTop: 8 }}>
          Changing who approves means changing the multisig itself. Do that in Safe or Squads with the owners present; Relay reads the result back on the next sync.
        </small>
      </section>

      <TimeLockSection treasury={treasury} />

      <section>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Waiting on this treasury</div>
        {intents.loading && !intents.data ? <LoadingRows rows={2} /> : waiting.length === 0 ? (
          <div className="panel"><Empty title="Nothing is waiting">Payments from this treasury appear here while they need an approval, a time lock, or a signature.</Empty></div>
        ) : (
          <div className="panel"><div className="rows">
            {waiting.map((intent) => (
              <WaitingPayment
                key={intent.id}
                intent={intent}
                canReject={can("owner", "approver") && intent.status === "approval_required"}
                onReject={() => setRejecting(intent)}
              />
            ))}
          </div></div>
        )}
      </section>

      {rejecting && <RejectPayment intent={rejecting} treasury={treasury} onClose={() => setRejecting(null)} />}
    </Drawer>
  );
}

/** The delay this vault puts on an approved payment, and the on-chain change that alters it. */
function TimeLockSection({ treasury }: { treasury: Treasury }) {
  const { session, can } = useSession();
  const { busy, run } = useAction();
  const reading = useApi<TimeLockReading>(`/v1/treasuries/${treasury.id}/time-lock`, { refreshMs: 30_000 });
  const [index, setIndex] = useState<string | null>(() => (typeof window === "undefined" ? null : readChangeIndex(treasury.id)));
  const [hours, setHours] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const seconds = Math.round(hours * 3_600);
  const current = reading.data?.seconds ?? 0;

  useEffect(() => { setHours(Math.round(((reading.data?.seconds ?? 0) / 3_600) * 100) / 100); }, [reading.data?.seconds]);

  const forget = useCallback(() => { writeChangeIndex(treasury.id, null); setIndex(null); }, [treasury.id]);

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    setUnsupported(null);
    const result = await run("propose", async () => {
      setProgress("Preparing the change");
      let prepared: PreparedTimeLockChange;
      try {
        prepared = (await api<{ data: PreparedTimeLockChange }>(`/v1/treasuries/${treasury.id}/time-lock`, { method: "POST", body: { seconds } })).data;
      } catch (error) {
        if (error instanceof ApiError && endpointMissing(error)) {
          setUnsupported(`This server has no time lock route yet. The API answered: ${error.message}`);
          throw new Error("The API cannot change the time lock yet. Nothing was sent.");
        }
        throw error;
      }
      await sessionWallet(session);
      setProgress("Confirm the proposal in your wallet");
      await sendPrepared(prepared.transactionBase64);
      return prepared;
    }, "Change proposed on chain");
    setProgress(null);
    if (result) {
      writeChangeIndex(treasury.id, result.transactionIndex);
      setIndex(result.transactionIndex);
      void reading.reload();
    }
  }

  if (reading.error) {
    return (
      <section>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Time lock</div>
        {endpointMissing(reading.error)
          ? <Notice><b>Not available on this server.</b> There is no time lock route here yet, so Relay cannot say whether this vault delays a payment. Read it in Squads or Safe directly.</Notice>
          : <Notice tone="negative"><b>Could not read the time lock.</b> {reading.error.message} <button className="btn small ghost" onClick={() => void reading.reload()}>Try again</button></Notice>}
      </section>
    );
  }

  const data = reading.data;
  return (
    <section>
      <div className="eyebrow" style={{ marginBottom: 10 }}>Time lock</div>
      <div className="panel"><div className="panel-body stack">
        {!data ? <LoadingRows rows={2} /> : (
          <>
            <div className="lock-state">
              <span className={`lock-dot ${current > 0 ? "positive" : ""}`} />
              <div>
                <b>{current > 0 ? `Every approved payment waits ${formatDuration(current)}` : "Approved payments can execute straight away"}</b>
                <span className="faint">{data.note}</span>
              </div>
            </div>
            {data.evidence?.note && <Notice tone="pending">{data.evidence.note}</Notice>}
            {!data.enforcedOnChain && current === 0 && data.governance === "safe" && (
              <small className="faint">Relay does not hold a payment back in place of the chain. What it cannot enforce, it does not claim to.</small>
            )}
          </>
        )}

        {data?.changeable && can("owner") && (
          <form className="form-grid" id="time-lock" onSubmit={(event) => void propose(event)}>
            <label className="field">
              <span>Delay in hours</span>
              <input className="input num" type="number" min={0} max={maxTimeLockHours} step={0.25} value={hours}
                onChange={(event) => setHours(Math.max(0, Math.min(maxTimeLockHours, Number(event.target.value))))} />
              <small>{formatDuration(seconds)}. Up to 90 days.</small>
            </label>
            <div className="field" style={{ alignContent: "end" }}>
              <div className="btn-row">
                <button className="btn primary" disabled={busy !== null || seconds === current}>{busy === "propose" ? "Working…" : "Propose the change"}</button>
                {progress && <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>{progress}</span>}
              </div>
            </div>
            <div className="span-2">
              <small className="faint">
                A time lock lives in the multisig, so changing it is a change to the multisig. Your wallet proposes it, the voting members approve it the way they approve a payment, and it takes effect when the change executes. Relay refuses to prepare one while payments are in flight, because a config change voids proposals already waiting for votes.
              </small>
            </div>
          </form>
        )}
        {data && !data.changeable && data.governance !== "direct" && (
          <Notice><b>Not changeable from here.</b> {data.note}</Notice>
        )}
        {data?.changeable && !can("owner") && <Notice>Only an owner can propose a time lock change.</Notice>}
        {unsupported && <Notice tone="negative"><b>Not available on this server.</b> {unsupported}</Notice>}
      </div></div>

      {index && <TimeLockChangeTracker treasury={treasury} index={index} onDone={() => { forget(); void reading.reload(); }} onForget={forget} />}
    </section>
  );
}

/** A proposed change, from the votes it needs to the wallet that finally executes it. */
function TimeLockChangeTracker({ treasury, index, onDone, onForget }: { treasury: Treasury; index: string; onDone(): void; onForget(): void }) {
  const { session, can } = useSession();
  const { busy, run } = useAction();
  const change = useApi<TimeLockChange>(`/v1/treasuries/${treasury.id}/time-lock/changes/${index}`, { refreshMs: 8_000 });
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => { if (change.error?.code === "time_lock_change_not_found") onForget(); }, [change.error, onForget]);

  async function vote(decision: "approved" | "rejected" | "cancelled") {
    const result = await run(decision, async () => {
      const prepared = (await api<{ data: { transactionBase64: string } }>(`/v1/treasuries/${treasury.id}/time-lock/changes/${index}/vote/${decision}`)).data;
      await sessionWallet(session);
      setProgress("Confirm the vote in your wallet");
      return await sendPrepared(prepared.transactionBase64);
    }, decision === "cancelled" ? "Change cancelled" : `Vote sent: ${decision}`);
    setProgress(null);
    if (result) void change.reload();
  }

  async function execute() {
    const result = await run("execute", async () => {
      const prepared = (await api<{ data: { transactionBase64: string } }>(`/v1/treasuries/${treasury.id}/time-lock/changes/${index}/execute`, { method: "POST", body: {} })).data;
      await sessionWallet(session);
      setProgress("Confirm the execution in your wallet");
      const signature = await sendPrepared(prepared.transactionBase64);
      setProgress("Reading the new delay back from the chain");
      await api(`/v1/treasuries/${treasury.id}/time-lock/changes/${index}/confirm`, { method: "POST", body: { transactionSignature: signature } });
      return signature;
    }, "Time lock changed");
    setProgress(null);
    if (result) { invalidate("/v1/treasuries"); onDone(); }
  }

  const data = change.data;
  const closed = data ? ["executed", "rejected", "cancelled"].includes(data.status) : false;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <header className="panel-head">
        <div>
          <h2>Change in flight</h2>
          <p>Proposal {index} on this vault's multisig.</p>
        </div>
        {data && <Pill tone={data.status === "executed" ? "positive" : data.status === "rejected" || data.status === "cancelled" ? "negative" : "pending"}>{sentence(data.status)}</Pill>}
      </header>
      <div className="panel-body stack">
        {change.error && change.error.code !== "time_lock_change_not_found" ? <Notice tone="negative">{change.error.message}</Notice>
          : !data ? <LoadingRows rows={2} />
          : (
            <>
              <dl className="kv">
                <dt>New delay</dt><dd>{formatDuration(data.timeLock.seconds)}</dd>
                <dt>Approvals</dt><dd>{data.approved} of {data.requiredApprovals}{data.rejected > 0 ? `, ${data.rejected} against` : ""}</dd>
                <dt>Can execute</dt>
                <dd>
                  {closed ? "Already closed"
                    : data.timeLock.locked && data.timeLock.executableAt ? <><Countdown iso={data.timeLock.executableAt} /> <span className="faint">· {formatDate(data.timeLock.executableAt)}</span></>
                    : data.executable ? <span className="positive">Now</span>
                    : "Not yet, it still needs votes"}
                </dd>
              </dl>
              <div className="progress"><i style={{ width: `${Math.min(100, (data.approved / Math.max(data.requiredApprovals, 1)) * 100)}%` }} /></div>
              {!closed && can("owner", "approver") && (
                <div className="btn-row">
                  <button className="btn small" disabled={busy !== null} onClick={() => void vote("approved")}><Icons.Check />Approve</button>
                  <button className="btn small ghost" disabled={busy !== null} onClick={() => void vote("rejected")}><Icons.Close />Vote against</button>
                  {can("owner") && <button className="btn small ghost" disabled={busy !== null} onClick={() => void vote("cancelled")}>Cancel it</button>}
                  {can("owner") && data.executable && !data.timeLock.locked && <button className="btn small primary" disabled={busy !== null} onClick={() => void execute()}>Execute the change</button>}
                  {progress && <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>{progress}</span>}
                </div>
              )}
              {closed && <div className="btn-row"><button className="btn small ghost" onClick={onForget}>Stop following it</button></div>}
              <small className="faint">The executor never votes on a governance change and never executes one. Owners sign these with their own wallets.</small>
            </>
          )}
      </div>
    </div>
  );
}

/** One waiting payment: what the time lock does to it, and a way to reject it. */
function WaitingPayment({ intent, canReject, onReject }: { intent: Intent; canReject: boolean; onReject(): void }) {
  const lock = useApi<IntentTimeLock>(`/v1/intents/${intent.id}/time-lock`, { refreshMs: 15_000 });
  const state = lock.data?.timeLock;
  const executableAt = state?.executableAt ?? null;

  return (
    <div className="row">
      <span className="cell-title">
        <b>{intent.purpose}</b>
        <span>
          {intent.status === "approval_required" ? "Waiting for approvals"
            : state?.locked && executableAt ? <><Countdown iso={executableAt} /> <span className="faint">· {formatDate(executableAt)}</span></>
            : lock.data && !lock.data.execution.allowed ? lock.data.execution.message
            : lock.data ? "Ready to execute"
            : sentence(intent.status)}
        </span>
      </span>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {state?.locked && <Pill tone="pending">Time lock</Pill>}
        {canReject && <button className="btn small ghost" onClick={onReject}><Icons.Close />Reject</button>}
      </span>
    </div>
  );
}

/**
 * Rejection, prepared before it is signed.
 *
 * The API compiles what a rejection actually is for this treasury: a Safe burns
 * the payment's nonce with a zero value call to itself, so the payment can never
 * execute; a Squads vault takes a rejection vote on the proposal. The evidence
 * the API returns is passed straight back to it, so the rejection stays bound to
 * the payment and version that was reviewed.
 */
export function RejectPayment({ intent, treasury, onClose }: { intent: Intent; treasury: Treasury; onClose(): void }) {
  const { session } = useSession();
  const prepared = useApi<PreparedRejection>(`/v1/intents/${intent.id}/rejection-transaction`);
  const { busy, run } = useAction();
  const [progress, setProgress] = useState<string | null>(null);

  const data = prepared.data;
  const evidenceMissing = Boolean(data && (!data.compiledHash || !data.simulationHash));

  async function submit() {
    if (!data || !data.compiledHash || !data.simulationHash) return;
    const evidence = { expectedIntentVersion: data.expectedIntentVersion, compiledHash: data.compiledHash, simulationHash: data.simulationHash };
    const result = await run("reject", async () => {
      const wallet = await sessionWallet(session);
      if (data.kind === "squads_proposal_reject") {
        setProgress("Confirm the rejection vote in your wallet");
        const signature = await sendPrepared(data.transactionBase64!);
        setProgress("Telling Relay to follow the chain");
        await api(`/v1/intents/${intent.id}/rejection-transaction`, { method: "POST", body: { ...evidence, transactionHash: signature } });
        return true;
      }
      setProgress("Sign the rejection in your wallet");
      const signature = await signEvmTypedData(wallet.address, data.typedData);
      await api(`/v1/intents/${intent.id}/rejection-transaction`, { method: "POST", body: { ...evidence, signature } });
      return true;
    }, "Payment rejected");
    setProgress(null);
    if (result) { invalidate("/v1/intents"); onClose(); }
  }

  return (
    <Modal
      title="Reject this payment"
      description={intent.purpose}
      onClose={onClose}
      footer={<>
        {progress && <span className="dim" style={{ marginRight: "auto", fontSize: 13, alignSelf: "center" }}>{progress}</span>}
        <button className="btn" onClick={onClose}>Keep it open</button>
        <button className="btn danger" disabled={busy !== null || !data || evidenceMissing} onClick={() => void submit()}>
          {busy ? "Waiting for wallet…" : data?.kind === "squads_proposal_reject" ? "Send the rejection vote" : "Sign the rejection"}
        </button>
      </>}
    >
      <div className="stack">
        {prepared.error ? (
          <Notice tone="negative"><b>This payment cannot be rejected.</b> {prepared.error.message}</Notice>
        ) : !data ? <LoadingRows rows={3} /> : (
          <>
            <Notice><b>What your wallet will sign.</b> {data.note}</Notice>
            <dl className="kv">
              <dt>Payment</dt><dd>{intent.purpose}</dd>
              <dt>From</dt><dd>{treasury.name} · {governanceLabel[treasury.governance]}</dd>
              <dt>Rejection</dt>
              <dd>{data.kind === "safe_nonce_burn" ? "A zero value Safe transaction that burns this payment's nonce" : "A rejection vote on the Squads proposal"}</dd>
              {data.kind === "safe_nonce_burn" && data.nonce !== undefined && <><dt>Nonce burned</dt><dd className="num">{data.nonce}</dd></>}
              {data.kind === "safe_nonce_burn" && data.owners && <><dt>Owners who must sign</dt><dd>{data.owners.length} on this Safe</dd></>}
              {data.member && <><dt>Voting as</dt><dd className="address">{shortAddress(data.member, 10, 8)}</dd></>}
              {data.transactionIndex && <><dt>Proposal</dt><dd className="num">{data.transactionIndex}</dd></>}
            </dl>
            {evidenceMissing && <Notice tone="negative"><b>Nothing to bind the rejection to.</b> This payment has no compiled proposal yet, so Relay cannot record a rejection against it.</Notice>}
            <small className="faint">
              Rejecting does not move money. The requester can ask again, and a new request is checked against policy from the start.
            </small>
          </>
        )}
      </div>
    </Modal>
  );
}
