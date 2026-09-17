"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { IntentDrawer } from "../../../components/intent-drawer";
import { Icons } from "../../../components/icons";
import { NewPayment } from "../../../components/new-payment";
import { useSession } from "../../../components/session";
import { Ago, Amount, Empty, ErrorState, LoadingRows, PageHead, Pill } from "../../../components/ui";
import { assetMeta, useAssets, useIntents, usePrincipalNames, useTreasuries } from "../../../lib/data";
import { intentStatus, networkLabel, shortAddress } from "../../../lib/format";

const filters = [
  { key: "attention", label: "Needs approval", match: (status: string) => status === "approval_required" },
  { key: "active", label: "In progress", match: (status: string) => ["received", "policy_evaluated", "approved", "executing", "submitted"].includes(status) },
  { key: "settled", label: "Settled", match: (status: string) => ["reconciled", "finalized"].includes(status) },
  { key: "closed", label: "Rejected or failed", match: (status: string) => ["rejected", "failed", "expired"].includes(status) },
  { key: "all", label: "All", match: () => true }
] as const;

function PaymentsPage() {
  const params = useSearchParams();
  const { can } = useSession();
  const intents = useIntents();
  const assets = useAssets();
  const treasuries = useTreasuries();
  const names = usePrincipalNames();
  const [filter, setFilter] = useState<(typeof filters)[number]["key"]>("all");
  const [open, setOpen] = useState<string | null>(params.get("intent"));
  const [creating, setCreating] = useState(false);

  const counts = useMemo(() => Object.fromEntries(filters.map((entry) => [entry.key, (intents.data ?? []).filter((intent) => entry.match(intent.status)).length])), [intents.data]);
  const active = filters.find((entry) => entry.key === filter)!;
  const rows = (intents.data ?? []).filter((intent) => active.match(intent.status));

  return (
    <>
      <PageHead title="Payments" description="Every payment your people and agents request, from policy check to reconciliation."
        actions={can("owner", "operator") ? <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />New payment</button> : undefined} />
      <div className="tabs" role="tablist">
        {filters.map((entry) => (
          <button key={entry.key} role="tab" aria-selected={filter === entry.key} onClick={() => setFilter(entry.key)}>
            {entry.label}{counts[entry.key] ? <span className="faint num" style={{ marginLeft: 8 }}>{counts[entry.key]}</span> : null}
          </button>
        ))}
      </div>
      <section className="panel">
        {intents.error ? <ErrorState error={intents.error} retry={() => void intents.reload()} /> : intents.loading && !intents.data ? <LoadingRows rows={6} /> : rows.length === 0 ? (
          <Empty title={filter === "attention" ? "Nothing waits for approval" : "No payments here yet"}
            action={can("owner", "operator") && filter !== "attention" ? <button className="btn" onClick={() => setCreating(true)}><Icons.Plus />Request a payment</button> : undefined}>
            {filter === "attention" ? "Payments that pass policy but need a person show up here." : "Agents submit payments through the agent API; people request them here. Each one is checked against policy and simulated on chain first."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Payment</th><th>Requested by</th><th>From</th><th className="right">Amount</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {rows.map((intent) => {
                  const meta = assetMeta(assets.byId, intent.assetId);
                  const status = intentStatus(intent.status);
                  const requester = names.get(intent.requesterId);
                  const treasury = treasuries.data?.find((candidate) => candidate.id === intent.treasuryAccountId);
                  const amount = intent.policyDecision?.x402?.requirements.amount ?? intent.amountBaseUnits;
                  return (
                    <tr key={intent.id} className="clickable" onClick={() => setOpen(intent.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setOpen(intent.id); }}>
                      <td><div className="cell-title"><b>{intent.purpose}</b><span className="address">{intent.kind === "x402" ? intent.destination : shortAddress(intent.destination, 8, 6)}</span></div></td>
                      <td>{requester ? <span>{requester.name}{requester.kind === "agent" && <span className="faint"> · agent</span>}</span> : <span className="faint">Unknown</span>}</td>
                      <td>{treasury ? <div className="cell-title"><b style={{ fontWeight: 450 }}>{treasury.name}</b><span>{networkLabel(treasury.network)}</span></div> : networkLabel(intent.network)}</td>
                      <td className="right primary"><Amount value={amount} decimals={meta.decimals} symbol={meta.symbol} /></td>
                      <td><Pill tone={status.tone}>{status.label}</Pill></td>
                      <td><Ago iso={intent.createdAt} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <IntentDrawer intentId={open} onClose={() => setOpen(null)} />}
      {creating && <NewPayment onClose={() => setCreating(false)} onCreated={(intent) => setOpen(intent.id)} />}
    </>
  );
}

export default function Page() {
  return <Suspense><PaymentsPage /></Suspense>;
}
