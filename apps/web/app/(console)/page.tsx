"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IntentDrawer } from "../../components/intent-drawer";
import { Icons } from "../../components/icons";
import { NewPayment } from "../../components/new-payment";
import { useSession } from "../../components/session";
import { BalanceList } from "../../components/treasury-balances";
import { Ago, Amount, Empty, LoadingRows, Pill } from "../../components/ui";
import { useApi } from "../../lib/api";
import { assetMeta, governanceLabel, useAgents, useAssets, useIntents, usePolicies, usePrincipalNames, useTreasuries } from "../../lib/data";
import { intentStatus, networkLabel, shortAddress } from "../../lib/format";
import type { Inflow, Invoice, Reconciliation } from "../../lib/types";

export default function OverviewPage() {
  const { session, can } = useSession();
  const intents = useIntents();
  const treasuries = useTreasuries();
  const agents = useAgents();
  const assets = useAssets();
  const names = usePrincipalNames();
  const invoices = useApi<Invoice[]>("/v1/invoices");
  const policies = usePolicies();
  const inflows = useApi<Inflow[]>("/v1/inflows", { refreshMs: 20_000 });
  const reconciliations = useApi<Reconciliation[]>("/v1/reconciliation", { refreshMs: 20_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const all = intents.data ?? [];
  const waiting = all.filter((intent) => intent.status === "approval_required");
  const moving = all.filter((intent) => ["received", "policy_evaluated", "approved", "executing", "submitted"].includes(intent.status));
  const monthAgo = Date.now() - 30 * 86_400_000;
  const settled = all.filter((intent) => ["reconciled", "finalized"].includes(intent.status) && new Date(intent.createdAt).getTime() > monthAgo);
  const openInvoices = (invoices.data ?? []).filter((invoice) => invoice.status === "open");
  const breaks = (reconciliations.data ?? []).filter((entry) => entry.status === "break");
  const activeAgents = (agents.data ?? []).filter((agent) => agent.status === "active");

  const activity = useMemo(() => {
    const payments = all.slice(0, 20).map((intent) => ({ kind: "payment" as const, at: intent.createdAt, intent }));
    const receipts = (inflows.data ?? []).slice(0, 20).map((inflow) => ({ kind: "receipt" as const, at: inflow.observedAt, inflow }));
    return [...payments, ...receipts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  }, [all, inflows.data]);

  const loading = intents.loading && !intents.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{session.organization.name}</h1>
          <p>{(treasuries.data?.length ?? 0) === 0 ? "Add a treasury to start paying and getting paid." : `Payments your agents request and money coming in, across ${treasuries.data!.length} treasur${treasuries.data!.length === 1 ? "y" : "ies"}.`}</p>
        </div>
        <div className="page-actions">
          {can("owner") && <Link className="btn" href="/treasuries"><Icons.Treasury />Treasuries</Link>}
          {can("owner", "operator") && <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />New payment</button>}
        </div>
      </div>

      <section className="panel milled" style={{ marginBottom: 16 }}>
        <div className="stat-strip" style={{ ["--stats" as string]: 5 }}>
          <div><span className="eyebrow">Needs approval</span><div className="value">{loading ? "–" : waiting.length}</div><div className="sub">{waiting.length ? <Link href="/payments" style={{ color: "var(--pending)" }}>Review now</Link> : "Nothing waiting"}</div></div>
          <div><span className="eyebrow">In progress</span><div className="value">{loading ? "–" : moving.length}</div><div className="sub">Signing or confirming</div></div>
          <div><span className="eyebrow">Settled, 30 days</span><div className="value">{loading ? "–" : settled.length}</div><div className="sub">Reconciled with the chain</div></div>
          <div><span className="eyebrow">Open invoices</span><div className="value">{invoices.data ? openInvoices.length : "–"}</div><div className="sub">{openInvoices.length ? "Matched automatically when paid" : "None outstanding"}</div></div>
          <div><span className="eyebrow">Agents active</span><div className="value">{agents.data ? activeAgents.length : "–"}</div><div className="sub">{agents.data ? `${agents.data.length - activeAgents.length} frozen or revoked` : " "}</div></div>
        </div>
      </section>

      <SetupChecklist treasuries={(treasuries.data ?? []).length} policies={policies.data?.length ?? 0} agents={agents.data?.length ?? 0} payments={all.length} ready={Boolean(treasuries.data && policies.data && agents.data && intents.data)} />

      {breaks.length > 0 && (
        <div className="notice negative" style={{ marginBottom: 16 }}><Icons.Alert /><div><b>{breaks.length} reconciliation difference{breaks.length === 1 ? "" : "s"}.</b> A treasury's chain balance does not match the ledger. Deposits the indexer cannot see (such as contract-internal transfers) cause this; check <Link href="/statements" style={{ textDecoration: "underline" }}>Statements</Link>.</div></div>
      )}

      <div className="grid-main">
        <div className="stack">
          <section className="panel">
            <header className="panel-head"><div><h2>Treasuries</h2><p>Balances read from chain every 20 seconds</p></div><Link className="btn small ghost" href="/treasuries">Manage<Icons.ChevronRight /></Link></header>
            {treasuries.loading && !treasuries.data ? <LoadingRows rows={3} /> : (treasuries.data ?? []).length === 0 ? (
              <Empty title="No treasuries yet" action={can("owner") ? <Link className="btn" href="/treasuries"><Icons.Plus />Add a treasury</Link> : undefined}>
                A treasury is the account money moves from: a Safe on EVM, a Squads vault on Solana, or a development account on a local chain.
              </Empty>
            ) : (
              <div className="rows">
                {(treasuries.data ?? []).map((treasury) => (
                  <div key={treasury.id} className="row-icon" style={{ gridTemplateColumns: "34px minmax(0, 1fr) minmax(160px, 260px)", alignItems: "start" }}>
                    <span className="icon-tile">{treasury.chainFamily === "evm" ? <Icons.Ethereum /> : <Icons.Solana />}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 550 }} className="truncate">{treasury.name}</div>
                      <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{governanceLabel[treasury.governance]} · {networkLabel(treasury.network)} · <span className="address">{shortAddress(treasury.address)}</span></div>
                    </div>
                    <BalanceList treasury={treasury} compact />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel-head"><div><h2>Recent activity</h2><p>Payments out and receipts in, newest first</p></div><Link className="btn small ghost" href="/payments">All payments<Icons.ChevronRight /></Link></header>
            {loading ? <LoadingRows rows={5} /> : activity.length === 0 ? (
              <Empty title="No activity yet">Payments appear when a person or an agent requests one. Receipts appear when the indexer sees funds arrive at a treasury.</Empty>
            ) : (
              <div className="rows">
                {activity.map((item) => {
                  if (item.kind === "payment") {
                    const intent = item.intent;
                    const meta = assetMeta(assets.byId, intent.assetId);
                    const status = intentStatus(intent.status);
                    const requester = names.get(intent.requesterId);
                    return (
                      <button key={`p-${intent.id}`} className="row-icon" style={{ width: "100%", background: "none", border: 0, textAlign: "left", gridTemplateColumns: "34px minmax(0, 1fr) auto auto" }} onClick={() => setOpen(intent.id)}>
                        <span className="icon-tile"><Icons.Out /></span>
                        <span className="cell-title"><b>{intent.purpose}</b><span>{requester?.name ?? "Unknown"} · <Ago iso={intent.createdAt} /></span></span>
                        <Pill tone={status.tone}>{status.label}</Pill>
                        <span className="num" style={{ minWidth: 120, textAlign: "right" }}><Amount value={intent.policyDecision?.x402?.requirements.amount ?? intent.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} sign="-" /></span>
                      </button>
                    );
                  }
                  const inflow = item.inflow;
                  const meta = assetMeta(assets.byId, inflow.assetId);
                  return (
                    <div key={`r-${inflow.id}`} className="row-icon" style={{ gridTemplateColumns: "34px minmax(0, 1fr) auto auto" }}>
                      <span className="icon-tile" style={{ color: "var(--positive)" }}><Icons.In /></span>
                      <span className="cell-title"><b>{inflow.invoiceId ? "Invoice payment" : "Receipt"}{inflow.method === "x402" ? " via x402" : ""}</b><span>From <span className="address">{inflow.fromAddress ? shortAddress(inflow.fromAddress) : "unknown"}</span> · <Ago iso={inflow.observedAt} /></span></span>
                      <Pill tone={inflow.invoiceId ? "positive" : "neutral"}>{inflow.invoiceId ? "Matched" : "Unallocated"}</Pill>
                      <span className="positive num" style={{ minWidth: 120, textAlign: "right" }}><Amount value={inflow.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} sign="+" /></span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <header className="panel-head"><div><h2>Waiting for approval</h2><p>{can("owner", "approver") ? "Your wallet signs each decision" : "Owners and approvers decide"}</p></div></header>
            {loading ? <LoadingRows rows={3} /> : waiting.length === 0 ? (
              <Empty title="All clear">Payments above an agent's limits, or on treasuries that require people, wait here.</Empty>
            ) : (
              <div className="rows">
                {waiting.slice(0, 6).map((intent) => {
                  const meta = assetMeta(assets.byId, intent.assetId);
                  return (
                    <button key={intent.id} className="row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }} onClick={() => setOpen(intent.id)}>
                      <span className="cell-title"><b>{intent.purpose}</b><span>{names.get(intent.requesterId)?.name ?? "Unknown"} · <Ago iso={intent.createdAt} /></span></span>
                      <Amount value={intent.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel-head"><div><h2>Agents</h2><p>Who can ask for money, and their state</p></div><Link className="btn small ghost" href="/agents">Manage<Icons.ChevronRight /></Link></header>
            {agents.loading && !agents.data ? <LoadingRows rows={3} /> : (agents.data ?? []).length === 0 ? (
              <Empty title="No agents" action={can("owner", "operator") ? <Link className="btn small" href="/agents"><Icons.Plus />Create an agent</Link> : undefined}>An agent gets an API key and a spending policy. It can request payments; it can never sign them.</Empty>
            ) : (
              <div className="rows">
                {(agents.data ?? []).slice(0, 6).map((agent) => {
                  const recent = all.filter((intent) => intent.requesterId === agent.principalId && new Date(intent.createdAt).getTime() > Date.now() - 86_400_000).length;
                  return (
                    <div key={agent.id} className="row-icon" style={{ gridTemplateColumns: "34px minmax(0, 1fr) auto" }}>
                      <span className="icon-tile"><Icons.Agent /></span>
                      <span className="cell-title"><b>{agent.displayName}</b><span>{recent} payment{recent === 1 ? "" : "s"} in the last day</span></span>
                      <Pill tone={agent.status === "active" ? "positive" : agent.status === "frozen" ? "pending" : "negative"}>{agent.status === "active" ? "Active" : agent.status === "frozen" ? "Frozen" : "Revoked"}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
      {open && <IntentDrawer intentId={open} onClose={() => setOpen(null)} />}
      {creating && <NewPayment onClose={() => setCreating(false)} onCreated={(intent) => setOpen(intent.id)} />}
    </>
  );
}

/** Shown until a workspace can actually run money end to end; disappears for good once it can. */
function SetupChecklist({ treasuries, policies, agents, payments, ready }: { treasuries: number; policies: number; agents: number; payments: number; ready: boolean }) {
  const steps = [
    { done: treasuries > 0, href: "/treasuries", title: "Add a treasury", body: "Deploy a Safe, create a Squads vault, or connect one you already own." },
    { done: agents > 0, href: "/agents", title: "Create an agent and its key", body: "The key is shown once and belongs in your agent runtime's secret store." },
    { done: policies > 0, href: "/policies", title: "Set a spending policy", body: "Caps per payment and per day, and how much may go through without a person." },
    { done: payments > 0, href: "/payments", title: "Make the first payment", body: "Request one here, or let the agent request it through the API." }
  ];
  const remaining = steps.filter((step) => !step.done).length;
  if (!ready || remaining === 0) return null;
  return (
    <section className="panel milled" style={{ marginBottom: 16 }}>
      <header className="panel-head">
        <div><h2>Finish setting up</h2><p>{steps.length - remaining} of {steps.length} done</p></div>
        <div style={{ width: 140 }}><div className="progress"><i style={{ width: `${((steps.length - remaining) / steps.length) * 100}%` }} /></div></div>
      </header>
      <div className="rows">
        {steps.map((step) => (
          <Link key={step.href} href={step.href} className="row-icon">
            <span className="icon-tile" style={step.done ? { color: "var(--positive)", borderColor: "color-mix(in oklab, var(--positive) 40%, transparent)" } : undefined}>{step.done ? <Icons.Check /> : <Icons.ChevronRight />}</span>
            <span className="cell-title"><b style={step.done ? { color: "var(--dim)", textDecoration: "line-through" } : undefined}>{step.title}</b><span>{step.body}</span></span>
            {!step.done && <span className="faint" style={{ fontSize: 12.5 }}>Open</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}
