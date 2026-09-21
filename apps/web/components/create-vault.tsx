"use client";

import { useMemo, useState } from "react";
import { api, ApiError, invalidate } from "../lib/api";
import { useMembers, useNetworks } from "../lib/data";
import { networkLabel, shortAddress } from "../lib/format";
import { sessionWallet, waitForConfirmation } from "../lib/sign";
import type { Signer, Treasury } from "../lib/types";
import { ensureEvmChain, sendEvmTransaction, signSolanaTransaction } from "../lib/wallet";
import { FundButton } from "./add-treasury";
import { formatDuration, maxTimeLockHours, observedConfig } from "./governance-controls";
import { Icons } from "./icons";
import { useSession } from "./session";
import { CopyField, Field, Modal, Notice, useAction } from "./ui";

type Governance = "safe" | "squads";
type Step = "chain" | "owners" | "settings" | "review" | "confirm" | "working" | "failed" | "done";

/** Where the flow stopped, so that a closed modal never strands a deployed vault. */
type Stage = "prepared" | "broadcast" | "confirmed";

interface VaultDraft {
  governance: Governance;
  network: string;
  name: string;
  owners: string[];
  threshold: number;
  timeLockSeconds: number;
  executorSignerId: string;
  predictedAddress?: string;
  multisigPda?: string;
  /** Safe only. Kept so recording re-derives the predicted address and refuses any other Safe. */
  saltNonce?: string;
  transactionHash?: string;
  stage: Stage;
  updatedAt: string;
}

const draftKey = "relay.vault-draft.v1";

function readDraft(): VaultDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultDraft;
    return parsed.executorSignerId && parsed.governance ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: VaultDraft): void {
  try { window.localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* a browser that refuses storage still deploys; it just cannot resume */ }
}

function clearDraft(): void {
  try { window.localStorage.removeItem(draftKey); } catch { /* nothing to clean up */ }
}

function isWalletRejection(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null;
  if (record && (record.code === 4001 || record.code === "ACTION_REJECTED")) return true;
  const message = record && typeof record.message === "string" ? record.message.toLowerCase() : "";
  return ["user rejected", "user denied", "rejected the request", "request rejected", "declined"].some((phrase) => message.includes(phrase));
}

function validAddress(family: "evm" | "svm", value: string): boolean {
  return family === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(value) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

const same = (family: "evm" | "svm", a: string, b: string) => family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function createExecutor(chainFamily: "evm" | "svm"): Promise<Signer> {
  return (await api<{ data: Signer }>("/v1/signers", { method: "POST", body: { chainFamily } })).data;
}

/** Retries while the chain has not caught up with a deployment the wallet already broadcast. */
async function registerWithRetry(body: Record<string, unknown>, attempts = 30): Promise<Treasury> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await api<{ data: Treasury }>("/v1/vaults", { method: "POST", body })).data;
    } catch (error) {
      const notYetVisible = error instanceof ApiError && ["safe_not_found_on_chain", "multisig_not_found_on_chain"].includes(error.code);
      if (!notYetVisible || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

const order: Step[] = ["chain", "owners", "settings", "review"];
const stepLabels: Record<string, string> = { chain: "Chain", owners: "Owners", settings: "Rules", review: "Review" };

/**
 * Deploy a Safe or create a Squads vault from the signed-in wallet, end to end:
 * choose the chain, name the owners, set the threshold, read back exactly what
 * will be deployed and where, sign it, and watch it confirm.
 *
 * A signature the wallet refused and a deployment that failed are states of
 * their own, not a toast, and a vault that reached the chain but not Relay's
 * records can be finished later from the saved draft.
 */
export function CreateVault({ onClose, onCreated }: { onClose(): void; onCreated(treasury: Treasury): void }) {
  const { session } = useSession();
  const networks = useNetworks();
  const members = useMembers();
  const { busy, run } = useAction();

  const [step, setStep] = useState<Step>("chain");
  const [governance, setGovernance] = useState<Governance>(session.wallet?.chainFamily === "svm" ? "squads" : "safe");
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [timeLockHours, setTimeLockHours] = useState(0);
  const [extra, setExtra] = useState<string[]>([]);
  const [newOwner, setNewOwner] = useState("");
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<{ address: string; multisigPda?: string; saltNonce?: string; transaction?: { to: string; data: string; value: string }; transactionBase64?: string; executorSignerId: string; executorAddress: string } | null>(null);
  const [failure, setFailure] = useState<{ kind: "wallet" | "chain" | "register" | "prepare"; message: string; draft: VaultDraft | null } | null>(null);
  const [created, setCreated] = useState<{ treasury: Treasury; requested: { owners: string[]; threshold: number; timeLockSeconds: number; governance: Governance } } | null>(null);
  const [resumable, setResumable] = useState<VaultDraft | null>(() => (typeof window === "undefined" ? null : readDraft()));

  const family: "evm" | "svm" = governance === "safe" ? "evm" : "svm";
  const network = family === "evm" ? networks.data?.evm?.network : networks.data?.solana?.network;
  const chainId = networks.data?.evm?.chainId;
  const timeLockSeconds = Math.round(timeLockHours * 3_600);

  const candidates = useMemo(() => {
    const list: { address: string; label: string; note: string }[] = [];
    if (session.wallet?.chainFamily === family) list.push({ address: session.wallet.address, label: "You", note: "Signs and pays for this" });
    for (const member of members.data ?? []) {
      if (member.status !== "active" || !["owner", "approver"].includes(member.role)) continue;
      for (const wallet of member.wallets) {
        if (wallet.chainFamily !== family) continue;
        if (list.some((entry) => same(family, entry.address, wallet.address))) continue;
        list.push({ address: wallet.address, label: member.displayName, note: `Member, ${member.role}` });
      }
    }
    for (const address of extra) {
      if (list.some((entry) => same(family, entry.address, address))) continue;
      list.push({ address, label: "Added by address", note: "Not a member of this organization" });
    }
    return list;
  }, [members.data, session.wallet, family, extra]);

  const owners = candidates.filter((candidate) => !removed.has(candidate.address));
  const walletMatches = session.wallet?.chainFamily === family;
  const unavailable = !network ? `Relay is not connected to a ${family === "evm" ? "EVM" : "Solana"} network, so it cannot prepare this deployment.` : null;
  const ownerProblem = owners.length === 0
    ? "Choose at least one owner."
    : threshold > owners.length ? "More approvals are required than there are owners." : null;

  function addOwner() {
    const value = newOwner.trim();
    if (!validAddress(family, value)) return;
    if (candidates.some((candidate) => same(family, candidate.address, value))) { setNewOwner(""); return; }
    setExtra((current) => [...current, value]);
    setRemoved((current) => { const next = new Set(current); next.delete(value); return next; });
    setNewOwner("");
  }

  function toggle(address: string) {
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address); else next.add(address);
      return next;
    });
  }

  // Step one of two: ask the API what will be deployed, and where, before any wallet opens.
  async function prepare() {
    if (!network) return;
    setFailure(null);
    const result = await run("prepare", async () => {
      setProgress("Creating an executor key for Relay");
      const executor = await createExecutor(family);
      setProgress("Asking the API what will be deployed");
      const response = await api<{ data: { predictedAddress?: string; transaction?: { to: string; data: string; value: string }; multisigPda?: string; vaultPda?: string; transactionBase64?: string; saltNonce?: string } }>("/v1/vaults/prepare", {
        method: "POST",
        body: { governance, network, owners: owners.map((owner) => owner.address), threshold, executorSignerId: executor.id }
      });
      const address = governance === "safe" ? response.data.predictedAddress : response.data.vaultPda;
      if (!address) throw new Error("The API did not return an address for this vault.");
      const next: typeof prepared = {
        address,
        executorSignerId: executor.id,
        executorAddress: executor.address,
        ...(response.data.multisigPda ? { multisigPda: response.data.multisigPda } : {}),
        ...(response.data.saltNonce ? { saltNonce: response.data.saltNonce } : {}),
        ...(response.data.transaction ? { transaction: response.data.transaction } : {}),
        ...(response.data.transactionBase64 ? { transactionBase64: response.data.transactionBase64 } : {})
      };
      writeDraft({
        governance, network, name: name.trim(), owners: owners.map((owner) => owner.address), threshold, timeLockSeconds,
        executorSignerId: executor.id, predictedAddress: address,
        ...(response.data.multisigPda ? { multisigPda: response.data.multisigPda } : {}),
        ...(response.data.saltNonce ? { saltNonce: response.data.saltNonce } : {}),
        stage: "prepared", updatedAt: new Date().toISOString()
      });
      return next;
    });
    setProgress(null);
    if (result) { setPrepared(result); setStep("confirm"); }
    else { setFailure({ kind: "prepare", message: "The API could not prepare this deployment. Nothing was signed and nothing was deployed.", draft: null }); setStep("failed"); }
  }

  // Step two of two: the owner's wallet signs and pays, then Relay verifies on chain.
  async function deploy() {
    if (!prepared || !network) return;
    setFailure(null);
    setStep("working");
    const label = name.trim() || (governance === "squads" ? "Squads vault" : "Safe");
    const draft = (): VaultDraft => ({
      governance, network, name: label, owners: owners.map((owner) => owner.address), threshold, timeLockSeconds,
      executorSignerId: prepared.executorSignerId, predictedAddress: prepared.address,
      ...(prepared.multisigPda ? { multisigPda: prepared.multisigPda } : {}),
      ...(prepared.saltNonce ? { saltNonce: prepared.saltNonce } : {}),
      stage: "prepared", updatedAt: new Date().toISOString()
    });

    let hash: string;
    try {
      await sessionWallet(session);
      if (governance === "safe") {
        if (chainId) await ensureEvmChain(chainId);
        setProgress("Confirm the deployment in your wallet");
        hash = await sendEvmTransaction(session.wallet!.address, prepared.transaction!);
      } else {
        setProgress("Sign the vault creation in your wallet");
        const signed = await signSolanaTransaction(prepared.transactionBase64!);
        setProgress("Sending it to the network");
        hash = (await api<{ data: { signature: string } }>("/v1/relay/solana", { method: "POST", body: { transactionBase64: signed } })).data.signature;
      }
      writeDraft({ ...draft(), stage: "broadcast", transactionHash: hash });
    } catch (error) {
      setProgress(null);
      const rejected = isWalletRejection(error);
      setFailure({
        kind: rejected ? "wallet" : "chain",
        message: rejected
          ? "Your wallet did not sign it. Nothing was deployed and nothing was spent. The settings below are still here when you want to try again."
          : error instanceof Error ? error.message : "The wallet could not send the transaction.",
        draft: null
      });
      setStep("failed");
      return;
    }

    try {
      setProgress("Waiting for the network to confirm");
      await waitForConfirmation(governance === "safe" ? "evm" : "solana", hash);
      writeDraft({ ...draft(), stage: "confirmed", transactionHash: hash });
    } catch (error) {
      setProgress(null);
      setFailure({
        kind: "chain",
        message: error instanceof Error ? error.message : "The deployment did not confirm.",
        draft: { ...draft(), stage: "broadcast", transactionHash: hash }
      });
      setStep("failed");
      return;
    }

    await finish({ ...draft(), stage: "confirmed", transactionHash: hash });
  }

  /** Records a vault that is already on chain. Safe to call again after a failure. */
  async function finish(saved: VaultDraft) {
    setProgress("Reading the owners and threshold back from the chain");
    try {
      // POST /v1/vaults reads the account back off the chain and refuses to record
      // it unless the owners, the threshold and the executor's rights are the ones
      // that were asked for, so the plan goes with it.
      const treasury = await registerWithRetry({
        name: saved.name || (saved.governance === "squads" ? "Squads vault" : "Safe"),
        network: saved.network,
        address: saved.predictedAddress,
        governance: saved.governance,
        executorSignerId: saved.executorSignerId,
        owners: saved.owners,
        threshold: saved.threshold,
        ...(saved.multisigPda ? { multisigPda: saved.multisigPda } : {}),
        ...(saved.saltNonce ? { saltNonce: saved.saltNonce } : {})
      });
      clearDraft();
      setResumable(null);
      setProgress(null);
      // The comparison on the last screen has to be against what this vault was
      // asked for, which for a resumed draft is not what the form now holds.
      setCreated({ treasury, requested: { owners: saved.owners, threshold: saved.threshold, timeLockSeconds: saved.timeLockSeconds, governance: saved.governance } });
      setStep("done");
      invalidate("/v1/treasuries");
      invalidate("/v1/signers");
    } catch (error) {
      setProgress(null);
      setFailure({
        kind: "register",
        message: error instanceof Error ? error.message : "Relay could not record the vault.",
        draft: saved
      });
      setStep("failed");
    }
  }

  const stepIndex = order.indexOf(step);
  const footer = (() => {
    if (step === "done") {
      return <><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={() => { if (created) onCreated(created.treasury); }}>Go to the vault</button></>;
    }
    if (step === "failed") {
      const saved = failure?.draft;
      return <>
        <button className="btn" onClick={onClose}>Close</button>
        {saved
          ? <button className="btn primary" disabled={progress !== null} onClick={() => void finish(saved)}>{progress ? "Working…" : "Finish registering"}</button>
          : <button className="btn primary" onClick={() => { setFailure(null); setStep(prepared ? "confirm" : "review"); }}>Try again</button>}
      </>;
    }
    if (step === "working") {
      return <span className="dim" style={{ fontSize: 13 }}>{progress ?? "Working…"}</span>;
    }
    if (step === "confirm") {
      return <>
        <button className="btn" onClick={() => setStep("review")}>Back</button>
        <button className="btn primary" disabled={busy !== null} onClick={() => void deploy()}><Icons.Wallet />{governance === "safe" ? "Sign and deploy" : "Sign and create"}</button>
      </>;
    }
    const last = step === "review";
    return <>
      {progress && <span className="dim" style={{ marginRight: "auto", fontSize: 13, alignSelf: "center" }}>{progress}</span>}
      <button className="btn" onClick={() => (stepIndex > 0 ? setStep(order[stepIndex - 1]!) : onClose())}>{stepIndex > 0 ? "Back" : "Cancel"}</button>
      <button className="btn primary" disabled={busy !== null || Boolean(unavailable) || (step !== "chain" && Boolean(ownerProblem)) || (last && !walletMatches)}
        onClick={() => (last ? void prepare() : setStep(order[stepIndex + 1]!))}>
        {last ? (busy ? "Preparing…" : "Prepare the deployment") : "Continue"}
      </button>
    </>;
  })();

  return (
    <Modal wide title="Create a vault" description="A vault your own wallet owns. Relay can propose and submit, never approve." onClose={onClose} footer={footer}>
      {stepIndex >= 0 && (
        <ol className="wizard" aria-label="Steps">
          {order.map((entry, index) => (
            <li key={entry} aria-current={entry === step ? "step" : undefined} className={index < stepIndex ? "done" : ""}>
              <span>{index < stepIndex ? <Icons.Check /> : index + 1}</span>{stepLabels[entry]}
            </li>
          ))}
        </ol>
      )}

      {resumable && step === "chain" && (
        <Notice tone="pending">
          <b>You have an unfinished vault.</b> A {resumable.governance === "safe" ? "Safe" : "Squads vault"} at <span className="address">{shortAddress(resumable.predictedAddress ?? "", 10, 8)}</span> was{" "}
          {resumable.stage === "prepared" ? "prepared but never signed" : "sent to the chain but never recorded by Relay"}.{" "}
          {resumable.stage === "prepared"
            ? <button className="btn small ghost" onClick={() => { clearDraft(); setResumable(null); }}>Discard it</button>
            : <button className="btn small" onClick={() => void finish(resumable)}>Finish registering it</button>}
        </Notice>
      )}

      {step === "chain" && (
        <div className="stack">
          <div className="grid-2" style={{ gap: 10 }}>
            {([
              { key: "safe" as const, title: "Safe on an EVM chain", body: "The standard multisig for Ethereum and Base. Owners sign; the threshold is enforced by the contract." },
              { key: "squads" as const, title: "Squads vault on Solana", body: "Members vote on chain. It can also hold a time lock, so an approved payment waits before it can move." }
            ]).map((option) => (
              <button key={option.key} type="button" className="wallet-option" style={{ gridTemplateColumns: "40px minmax(0, 1fr)", borderColor: governance === option.key ? "var(--text)" : undefined }}
                aria-pressed={governance === option.key} onClick={() => { setGovernance(option.key); setRemoved(new Set()); setThreshold(1); }}>
                <span className="wallet-glyph">{option.key === "safe" ? <Icons.Ethereum /> : <Icons.Solana />}</span>
                <span><b style={{ display: "block", fontWeight: 600 }}>{option.title}</b><span className="faint" style={{ fontSize: 12.5 }}>{option.body}</span></span>
              </button>
            ))}
          </div>
          <Field label="Name" className="span-2" hint="Only Relay sees this. The chain knows the vault by its address.">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Operating account" maxLength={80} />
          </Field>
          <dl className="kv">
            <dt>Network</dt><dd>{network ? networkLabel(network) : "Not connected"}</dd>
            <dt>Signed in as</dt><dd>{session.wallet ? <span className="address">{shortAddress(session.wallet.address, 10, 8)}</span> : "No wallet bound"}</dd>
          </dl>
          {unavailable && <Notice tone="negative">{unavailable}</Notice>}
          {!walletMatches && <Notice tone="pending">You are signed in with a {session.wallet?.chainFamily === "evm" ? "Ethereum" : "Solana"} wallet. Creating this needs a {family === "evm" ? "Ethereum" : "Solana"} wallet to sign and pay. You can still set it up and sign in with the other wallet before the last step.</Notice>}
        </div>
      )}

      {step === "owners" && (
        <div className="stack">
          <p className="dim" style={{ margin: 0 }}>Owners are the only people who can approve a payment out of this vault. Relay's executor is not one of them, and cannot become one.</p>
          <div className="panel"><div className="rows">
            {candidates.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>Nobody here has a {family === "evm" ? "Ethereum" : "Solana"} wallet yet. Add one below.</span></div>}
            {candidates.map((candidate) => (
              <label key={candidate.address} className="row" style={{ cursor: "pointer" }}>
                <span className="cell-title"><b>{candidate.label}</b><span className="address">{shortAddress(candidate.address, 10, 8)} · {candidate.note}</span></span>
                <input type="checkbox" checked={!removed.has(candidate.address)} onChange={() => toggle(candidate.address)} />
              </label>
            ))}
          </div></div>
          <div className="field">
            <span>Add an owner by address</span>
            <div className="btn-row" style={{ flexWrap: "nowrap" }}>
              <input className="input address" style={{ flex: 1 }} value={newOwner} onChange={(event) => setNewOwner(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addOwner(); } }}
                placeholder={family === "evm" ? "0x…" : "Base58 address"} />
              <button type="button" className="btn" onClick={addOwner} disabled={!validAddress(family, newOwner.trim())}><Icons.Plus />Add</button>
            </div>
            <small>Anyone can be an owner, member or not. They will need to sign with that wallet to approve a payment.</small>
          </div>
          {ownerProblem && <Notice tone="pending">{ownerProblem}</Notice>}
        </div>
      )}

      {step === "settings" && (
        <div className="stack">
          <div className="form-grid">
            <Field label="Approvals required" hint={`Out of ${owners.length} owner${owners.length === 1 ? "" : "s"}. The contract enforces this, not Relay.`}>
              <input className="input num" type="number" min={1} max={Math.max(owners.length, 1)} value={threshold}
                onChange={(event) => setThreshold(Math.max(1, Number(event.target.value)))} />
            </Field>
            {governance === "squads" && (
              <Field label="Time lock to set next, in hours" hint={timeLockSeconds > 0 ? `${formatDuration(timeLockSeconds)} between the last approval and the payment moving. Set after the vault exists.` : "No delay."}>
                <input className="input num" type="number" min={0} max={maxTimeLockHours} step={0.25} value={timeLockHours}
                  onChange={(event) => setTimeLockHours(Math.max(0, Math.min(maxTimeLockHours, Number(event.target.value))))} />
              </Field>
            )}
          </div>
          {governance === "squads" ? (
            <Notice tone="pending">
              <b>A time lock is a window to change your mind.</b> Once the last approval lands, the Squads program refuses to execute until the delay has passed, which leaves time to reject a payment that should not go out. A vault is created without one: the delay is a change to the multisig, so it is proposed from the vault afterwards and the members approve it on chain. What you put here is carried to the last screen as the next step.
            </Notice>
          ) : (
            <Notice>
              <b>A Safe has no delay of its own.</b> Once {threshold} of {owners.length} {owners.length === 1 ? "owner has" : "owners have"} signed, the transaction can be submitted. A delay would need a module added to the Safe, which Relay does not manage.
            </Notice>
          )}
          {ownerProblem && <Notice tone="pending">{ownerProblem}</Notice>}
        </div>
      )}

      {step === "review" && (
        <div className="stack">
          <p className="dim" style={{ margin: 0 }}>Nothing has been deployed yet. This is what will be, once you sign.</p>
          <dl className="kv">
            <dt>Kind</dt><dd>{governance === "safe" ? "Safe multisig" : "Squads vault"}</dd>
            <dt>Network</dt><dd>{network ? networkLabel(network) : "Not connected"}</dd>
            <dt>Name in Relay</dt><dd>{name.trim() || (governance === "squads" ? "Squads vault" : "Safe")}</dd>
            <dt>Owners</dt><dd>{owners.map((owner) => `${owner.label} (${shortAddress(owner.address)})`).join(", ")}</dd>
            <dt>Approvals</dt><dd>{threshold} of {owners.length}</dd>
            <dt>Time lock</dt><dd>{governance === "squads" ? <>None at creation{timeLockSeconds > 0 ? `, then ${formatDuration(timeLockSeconds)} to propose` : ""}</> : "Not part of a Safe"}</dd>
            <dt>Paid by</dt><dd>{session.wallet ? <span className="address">{shortAddress(session.wallet.address, 10, 8)}</span> : "No wallet bound"}</dd>
          </dl>
          <ol className="steps">
            <li><b>Relay makes an executor key</b><span>It can propose and submit what owners approved. It never holds a vote.</span></li>
            <li><b>You see the address before you sign</b><span>The vault address is worked out from the settings above, and shown on the next screen.</span></li>
            <li><b>Your wallet signs and pays</b><span>The deployment comes from your own wallet, not from Relay.</span></li>
            <li><b>Relay reads the result back from the chain</b><span>Owners and threshold are verified on chain before the vault is recorded.</span></li>
          </ol>
          {!walletMatches && <Notice tone="negative">Sign out and sign in with a {family === "evm" ? "Ethereum" : "Solana"} wallet to deploy this. Your settings are kept in this browser.</Notice>}
          {unavailable && <Notice tone="negative">{unavailable}</Notice>}
        </div>
      )}

      {step === "confirm" && prepared && (
        <div className="stack">
          <Notice tone="positive"><b>Ready. Nothing has been sent yet.</b> This is the address the vault will have, worked out from the settings you chose. It only exists once the transaction confirms.</Notice>
          <div className="field">
            <span>{governance === "safe" ? "Safe address" : "Vault address"}</span>
            <CopyField value={prepared.address} label={prepared.address} />
          </div>
          {prepared.multisigPda && (
            <div className="field">
              <span>Multisig account</span>
              <CopyField value={prepared.multisigPda} label={prepared.multisigPda} />
            </div>
          )}
          <dl className="kv">
            <dt>Approvals</dt><dd>{threshold} of {owners.length}</dd>
            <dt>Time lock</dt><dd>{governance === "squads" ? "None at creation" : "Not part of a Safe"}</dd>
            <dt>Relay executor</dt><dd className="address">{shortAddress(prepared.executorAddress, 10, 8)}</dd>
            <dt>Your wallet pays</dt><dd>{session.wallet ? <span className="address">{shortAddress(session.wallet.address, 10, 8)}</span> : "No wallet bound"}</dd>
          </dl>
          <small className="faint">If you close this window now, the settings are saved in this browser and nothing is left behind on chain.</small>
        </div>
      )}

      {step === "working" && (
        <div className="stack">
          <div className="lock-state">
            <span className="lock-dot pending" />
            <div><b>{progress ?? "Working"}</b><span className="faint">Leave this window open. Closing it does not cancel a transaction that is already on its way.</span></div>
          </div>
          <ol className="steps">
            <li><b>Your wallet signs and pays</b><span>{progress?.startsWith("Confirm") || progress?.startsWith("Sign") ? "Waiting for you." : "Done."}</span></li>
            <li><b>The network confirms it</b><span>{progress?.startsWith("Waiting") ? "In progress." : progress?.startsWith("Reading") ? "Done." : "Not yet."}</span></li>
            <li><b>Relay verifies it on chain</b><span>{progress?.startsWith("Reading") ? "In progress." : "Not yet."}</span></li>
          </ol>
        </div>
      )}

      {step === "failed" && failure && (
        <div className="stack">
          <Notice tone={failure.kind === "wallet" ? "pending" : "negative"}>
            <b>
              {failure.kind === "wallet" ? "You did not sign it."
                : failure.kind === "prepare" ? "The deployment could not be prepared."
                : failure.kind === "register" ? "The vault is on chain, but Relay has not recorded it."
                : "The deployment did not go through."}
            </b>{" "}
            {failure.message}
          </Notice>
          {failure.draft?.predictedAddress && (
            <div className="field">
              <span>{failure.draft.governance === "safe" ? "Safe address" : "Vault address"}</span>
              <CopyField value={failure.draft.predictedAddress} label={failure.draft.predictedAddress} />
              <small>Keep this. It is saved in this browser too, and the vault can be registered later from the notice at the top of this window.</small>
            </div>
          )}
          {failure.draft?.transactionHash && (
            <div className="field">
              <span>Transaction</span>
              <CopyField value={failure.draft.transactionHash} label={shortAddress(failure.draft.transactionHash, 14, 10)} />
            </div>
          )}
          {failure.kind === "chain" && <small className="faint">Check that the wallet holds enough of the network coin to pay for the deployment, then try again.</small>}
        </div>
      )}

      {step === "done" && created && <Created treasury={created.treasury} requested={created.requested} />}
    </Modal>
  );
}

/** What actually landed on chain, compared with what was asked for. */
function Created({ treasury, requested }: { treasury: Treasury; requested: { owners: string[]; threshold: number; timeLockSeconds: number; governance: Governance } }) {
  const configuration = observedConfig(treasury);
  const observedVoters = requested.governance === "safe" ? configuration.owners ?? [] : (configuration.members ?? []).filter((member) => member.canVote).map((member) => member.key);
  const thresholdMatches = configuration.threshold === requested.threshold;
  const ownersMatch = observedVoters.length === requested.owners.length
    && requested.owners.every((owner) => observedVoters.some((voter) => same(requested.governance === "safe" ? "evm" : "svm", voter, owner)));
  const observedTimeLock = configuration.timeLock ?? 0;

  return (
    <div className="stack">
      <Notice tone="positive"><b>The vault exists.</b> Relay read its owners and threshold back from the chain before recording it.</Notice>
      <div className="field">
        <span>Address</span>
        <CopyField value={treasury.address} label={treasury.address} />
      </div>
      <dl className="kv">
        <dt>Approvals on chain</dt><dd>{configuration.threshold ?? "?"} of {observedVoters.length} {thresholdMatches && ownersMatch ? <span className="positive">as asked</span> : <span className="negative">not what was asked for</span>}</dd>
        <dt>Time lock on chain</dt><dd>{requested.governance === "squads" ? formatDuration(observedTimeLock) : "Not part of a Safe"}</dd>
      </dl>
      <ol className="steps">
        <li><b>Fund the executor</b><span>Relay's executor pays the network fee every time it submits. Without a balance it cannot submit anything.</span></li>
        <li><b>Fund the vault</b><span>Send the assets this vault will spend to the address above.</span></li>
        {requested.governance === "squads" && requested.timeLockSeconds > 0 && (
          <li><b>Propose the {formatDuration(requested.timeLockSeconds)} time lock</b><span>The vault was created without a delay, because a delay is a change to the multisig. Open this vault and propose it; the voting members approve it on chain.</span></li>
        )}
        <li><b>Point a policy at it</b><span>A policy decides what agents may spend from here before any human sees the request.</span></li>
      </ol>
      <div className="btn-row">
        <FundButton address={treasury.address} chainFamily={treasury.chainFamily} label="Fund the vault" />
      </div>
    </div>
  );
}
