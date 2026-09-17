"use client";

import { invalidate, useApi } from "../lib/api";
import { assetMeta, useAssets, usePrincipalNames, useTreasuries } from "../lib/data";
import { explorerUrl, formatDate, intentStatus, networkLabel, sentence, shortAddress } from "../lib/format";
import { decide } from "../lib/sign";
import type { IntentDetail } from "../lib/types";
import { Icons } from "./icons";
import { useSession } from "./session";
import { Ago, Amount, CopyField, Drawer, LoadingRows, Notice, Pill, useAction } from "./ui";

const terminal = new Set(["reconciled", "finalized", "rejected", "failed", "expired"]);

const eventLabels: Record<string, string> = {
  "intent.received": "Requested", "intent.policy_evaluated": "Policy passed, publishing proposal", "intent.approval_required": "Waiting for approval",
  "intent.approved": "Approved", "intent.auto_authorized": "Authorized by policy", "intent.rejected": "Rejected", "intent.expired": "Expired",
  "intent.executing": "Signing", "intent.submitted": "Submitted to the network", "intent.finalized": "Final on chain", "intent.reconciled": "Reconciled with the ledger",
  "intent.reconciliation_break": "Reconciliation difference", "intent.failed": "Failed"
};

function eventTone(type: string): string {
  if (type.endsWith("rejected") || type.endsWith("failed") || type.endsWith("break")) return "negative";
  if (type.endsWith("approval_required")) return "pending";
  if (type.endsWith("reconciled") || type.endsWith("finalized") || type.endsWith("approved")) return "positive";
  return "";
}

export function IntentDrawer({ intentId, onClose }: { intentId: string; onClose(): void }) {
  const { session, can } = useSession();
  const detail = useApi<IntentDetail>(`/v1/intents/${intentId}`, { refreshMs: 4_000 });
  const assets = useAssets();
  const treasuries = useTreasuries();
  const names = usePrincipalNames();
  const { busy, run } = useAction();

  const data = detail.data;
  if (!data) {
    return <Drawer title="Payment" onClose={onClose}>{detail.error ? <Notice tone="negative">{detail.error.message}</Notice> : <LoadingRows rows={6} />}</Drawer>;
  }
  const { intent, approval, execution, events } = data;
  const meta = assetMeta(assets.byId, intent.assetId);
  const status = intentStatus(intent.status);
  const treasury = treasuries.data?.find((candidate) => candidate.id === intent.treasuryAccountId);
  const requester = names.get(intent.requesterId);
  const alreadyDecided = approval?.decisions.some((entry) => entry.principalId === session.principal?.id);
  const canDecide = intent.status === "approval_required" && can("owner", "approver") && !alreadyDecided;
  const reasons = intent.policyDecision?.reasons ?? [];
  const quote = intent.policyDecision?.x402;
  const hashLink = execution?.transactionHash ? explorerUrl(intent.network, execution.transactionHash) : null;
  const walletAction = treasury?.governance === "squads" ? "Your wallet sends an on-chain vote." : treasury?.governance === "safe" ? "Your wallet signs the Safe transaction." : "Your wallet signs this decision.";

  const act = (decision: "approved" | "rejected") => run(decision, async () => {
    await decide(session, intentId, decision);
    invalidate("/v1/intents");
  }, decision === "approved" ? "Approval recorded" : "Payment rejected");

  return (
    <Drawer
      title={<span style={{ display: "flex", alignItems: "center", gap: 10 }}>{intent.purpose}</span>}
      description={<><Ago iso={intent.createdAt} /> by {requester ? `${requester.name}${requester.kind === "agent" ? " (agent)" : ""}` : shortAddress(intent.requesterId)}</>}
      onClose={onClose}
      footer={canDecide ? (
        <>
          <span className="faint" style={{ marginRight: "auto", fontSize: 12.5, alignSelf: "center" }}>{walletAction}</span>
          <button className="btn" disabled={busy !== null} onClick={() => void act("rejected")}>{busy === "rejected" ? "Waiting for wallet…" : "Reject"}</button>
          <button className="btn primary" disabled={busy !== null} onClick={() => void act("approved")}><Icons.Check />{busy === "approved" ? "Waiting for wallet…" : "Approve"}</button>
        </>
      ) : undefined}
    >
      <div className="panel milled">
        <div className="panel-body" style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span className="eyebrow">{intent.kind === "x402" ? "Machine payment" : "Transfer"}</span>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <div className="display"><Amount value={quote?.requirements.amount ?? intent.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} /></div>
          {quote && <span className="faint" style={{ fontSize: 13 }}>Seller price. The agent allowed up to <Amount value={intent.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} />.</span>}
          <dl className="kv">
            <dt>To</dt><dd className="address">{intent.kind === "x402" ? intent.destination : intent.destination}</dd>
            {quote && <><dt>Paid to</dt><dd className="address">{quote.requirements.payTo}</dd></>}
            <dt>From</dt><dd>{treasury ? `${treasury.name} · ${networkLabel(treasury.network)}` : networkLabel(intent.network)}</dd>
            <dt>Expires</dt><dd>{formatDate(intent.expiresAt)}</dd>
          </dl>
        </div>
      </div>

      {intent.failureReason && <Notice tone="negative"><b>{intent.status === "rejected" ? "Rejected." : "Failed."}</b> {intent.failureReason}</Notice>}
      {intent.status === "approval_required" && alreadyDecided && <Notice tone="positive">You have decided. Waiting for the remaining approvers.</Notice>}
      {intent.status === "approval_required" && !can("owner", "approver") && <Notice>Only owners and approvers can decide on payments.</Notice>}

      {approval && (
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Approvals</div>
          <div className="panel"><div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
              <span className="dim">{approval.approvals} of {approval.requiredApprovals} required</span>
              <span className="faint">{treasury?.governance === "safe" ? "Safe threshold" : treasury?.governance === "squads" ? "Squads threshold" : "Policy quorum"}</span>
            </div>
            <div className="progress"><i style={{ width: `${Math.min(100, (approval.approvals / Math.max(approval.requiredApprovals, 1)) * 100)}%` }} /></div>
            {approval.decisions.map((entry, index) => (
              <div key={index} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                <span className="truncate">{entry.principalId ? names.get(entry.principalId)?.name ?? "Member" : `Wallet ${shortAddress(entry.signerAddress ?? "")}`}</span>
                <Pill tone={entry.decision === "approved" ? "positive" : "negative"}>{sentence(entry.decision)}</Pill>
              </div>
            ))}
          </div></div>
        </section>
      )}

      {(reasons.length > 0 || intent.policyDecision?.simulation) && (
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Checks</div>
          <div className="panel"><div className="rows">
            {reasons.map((reason) => <div className="row" key={reason}><span className="dim" style={{ fontSize: 13.5 }}>{reason}</span><Icons.Policy style={{ width: 16, color: "var(--faint)" }} /></div>)}
            {intent.policyDecision?.simulation?.sourceBalanceBaseUnits && intent.policyDecision.simulation.sourceBalanceBaseUnits !== "unknown" && (
              <div className="row"><span className="dim" style={{ fontSize: 13.5 }}>Treasury balance when checked</span><Amount value={intent.policyDecision.simulation.sourceBalanceBaseUnits} decimals={meta.decimals} symbol={meta.symbol} /></div>
            )}
          </div></div>
        </section>
      )}

      {execution && (
        <section>
          <div className="eyebrow" style={{ marginBottom: 10 }}>On chain</div>
          <div className="panel"><div className="panel-body" style={{ display: "grid", gap: 12 }}>
            {execution.transactionHash && <CopyField value={execution.transactionHash} label={shortAddress(execution.transactionHash, 12, 10)} />}
            <dl className="kv">
              <dt>Status</dt><dd>{sentence(execution.status)}{execution.confirmations ? ` · ${execution.confirmations} confirmations` : ""}</dd>
              {execution.observed?.reconciliation && <><dt>Reconciliation</dt><dd>{execution.observed.reconciliation === "matched" ? "Destination received the exact amount" : sentence(execution.observed.reconciliation)}</dd></>}
              {execution.error && <><dt>Error</dt><dd className="negative">{execution.error}</dd></>}
            </dl>
            {hashLink && <a className="btn small" href={hashLink} target="_blank" rel="noreferrer"><Icons.External />View in explorer</a>}
          </div></div>
        </section>
      )}

      <section>
        <div className="eyebrow" style={{ marginBottom: 10 }}>History</div>
        <div className="timeline">
          {events.map((event) => (
            <div className="timeline-item" key={event.sequence}>
              <span className={`timeline-dot ${eventTone(event.eventType)}`} />
              <span>{eventLabels[event.eventType] ?? sentence(event.eventType.replace("intent.", ""))}</span>
              <span className="faint" style={{ fontSize: 12.5 }}><Ago iso={event.createdAt} /></span>
            </div>
          ))}
          {!terminal.has(intent.status) && <div className="timeline-item"><span className="timeline-dot" /><span className="faint">Updating live</span><span /></div>}
        </div>
      </section>
    </Drawer>
  );
}
