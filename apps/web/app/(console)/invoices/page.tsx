"use client";

import { useMemo, useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, Amount, CopyField, Drawer, Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, Toggle, useAction } from "../../../components/ui";
import { api, invalidate, useApi } from "../../../lib/api";
import { assetMeta, useAssets, useTreasuries } from "../../../lib/data";
import { displayUnits, formatDate, networkLabel, parseUnits, shortAddress, type Tone } from "../../../lib/format";
import type { Inflow, Invoice } from "../../../lib/types";

const invoiceTone: Record<Invoice["status"], Tone> = { draft: "neutral", open: "pending", paid: "positive", void: "neutral" };

function invoiceState(invoice: Invoice): { tone: Tone; label: string } {
  if (invoice.status === "open" && invoice.dueAt && new Date(invoice.dueAt).getTime() < Date.now()) return { tone: "negative", label: "Overdue" };
  if (invoice.status === "open" && BigInt(invoice.amountPaidBaseUnits) > 0n) return { tone: "info", label: "Part paid" };
  return { tone: invoiceTone[invoice.status], label: invoice.status === "open" ? "Open" : invoice.status === "paid" ? "Paid" : invoice.status === "draft" ? "Draft" : "Void" };
}

const tabs = [
  { key: "open", label: "Open", match: (invoice: Invoice) => invoice.status === "open" },
  { key: "paid", label: "Paid", match: (invoice: Invoice) => invoice.status === "paid" },
  { key: "draft", label: "Drafts", match: (invoice: Invoice) => invoice.status === "draft" },
  { key: "all", label: "All", match: () => true }
] as const;

export default function InvoicesPage() {
  const { can } = useSession();
  const invoices = useApi<Invoice[]>("/v1/invoices", { refreshMs: 15_000 });
  const inflows = useApi<Inflow[]>("/v1/inflows", { refreshMs: 15_000 });
  const assets = useAssets();
  const [view, setView] = useState<(typeof tabs)[number]["key"] | "receipts">("open");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const all = invoices.data ?? [];
  const unallocated = (inflows.data ?? []).filter((inflow) => !inflow.invoiceId);

  const outstanding = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const invoice of all.filter((candidate) => candidate.status === "open")) {
      totals.set(invoice.assetId, (totals.get(invoice.assetId) ?? 0n) + BigInt(invoice.amountDueBaseUnits) - BigInt(invoice.amountPaidBaseUnits));
    }
    return [...totals.entries()];
  }, [all]);
  const overdue = all.filter((invoice) => invoiceState(invoice).label === "Overdue").length;
  const monthAgo = Date.now() - 30 * 86_400_000;
  const paidRecently = all.filter((invoice) => invoice.status === "paid" && invoice.paidAt && new Date(invoice.paidAt).getTime() > monthAgo).length;
  const tab = tabs.find((entry) => entry.key === view);
  const rows = tab ? all.filter(tab.match) : [];
  const first = outstanding[0];
  const firstMeta = first ? assetMeta(assets.byId, first[0]) : null;

  return (
    <>
      <PageHead title="Invoices" description="Bill customers in crypto. Each invoice has a payment page; transfers that arrive are matched to it automatically, and x402 clients can pay it programmatically."
        actions={can("owner", "operator") ? <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />New invoice</button> : undefined} />
      <section className="panel milled" style={{ marginBottom: 16 }}>
        <div className="stat-strip" style={{ ["--stats" as string]: 4 }}>
          <div><span className="eyebrow">Outstanding</span><div className="value">{first && firstMeta ? <Amount value={first[1]} decimals={firstMeta.decimals} symbol={firstMeta.symbol} /> : "0"}</div><div className="sub">{outstanding.length > 1 ? `Plus ${outstanding.length - 1} other ${outstanding.length === 2 ? "asset" : "assets"}` : `${all.filter((invoice) => invoice.status === "open").length} open`}</div></div>
          <div><span className="eyebrow">Overdue</span><div className="value">{overdue}</div><div className="sub">{overdue ? <span className="negative">Past their due date</span> : "Nothing past due"}</div></div>
          <div><span className="eyebrow">Paid, 30 days</span><div className="value">{paidRecently}</div><div className="sub">Matched from the chain</div></div>
          <div><span className="eyebrow">Unmatched receipts</span><div className="value">{unallocated.length}</div><div className="sub">{unallocated.length ? <button className="btn small ghost" style={{ padding: 0, height: "auto" }} onClick={() => setView("receipts")}>Review and allocate</button> : "Every receipt is allocated"}</div></div>
        </div>
      </section>
      <div className="tabs" role="tablist">
        {tabs.map((entry) => {
          const count = all.filter(entry.match).length;
          return <button key={entry.key} role="tab" aria-selected={view === entry.key} onClick={() => setView(entry.key)}>{entry.label}{count ? <span className="faint num" style={{ marginLeft: 8 }}>{count}</span> : null}</button>;
        })}
        <button role="tab" aria-selected={view === "receipts"} onClick={() => setView("receipts")}>Receipts{(inflows.data ?? []).length ? <span className="faint num" style={{ marginLeft: 8 }}>{(inflows.data ?? []).length}</span> : null}</button>
      </div>
      {view === "receipts" ? <Receipts inflows={inflows.data} loading={inflows.loading} invoices={all} onOpenInvoice={setOpen} /> : (
        <section className="panel">
          {invoices.error ? <ErrorState error={invoices.error} retry={() => void invoices.reload()} /> : invoices.loading && !invoices.data ? <LoadingRows rows={5} /> : rows.length === 0 ? (
            <Empty title={view === "open" ? "No open invoices" : view === "draft" ? "No drafts" : view === "paid" ? "Nothing paid yet" : "No invoices yet"}
              action={can("owner", "operator") ? <button className="btn" onClick={() => setCreating(true)}><Icons.Plus />Create an invoice</button> : undefined}>
              An invoice names the treasury that receives the money and the asset you want. Share its payment page with your customer.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Invoice</th><th>Customer</th><th>Receives into</th><th className="right">Amount</th><th>Status</th><th>Due</th></tr></thead>
                <tbody>{rows.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} onOpen={() => setOpen(invoice.id)} />)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {creating && <CreateInvoice onClose={() => setCreating(false)} onCreated={(invoice) => setOpen(invoice.id)} />}
      {open && <InvoiceDrawer invoiceId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InvoiceRow({ invoice, onOpen }: { invoice: Invoice; onOpen(): void }) {
  const assets = useAssets();
  const treasuries = useTreasuries();
  const meta = assetMeta(assets.byId, invoice.assetId);
  const state = invoiceState(invoice);
  const treasury = treasuries.data?.find((candidate) => candidate.id === invoice.treasuryAccountId);
  return (
    <tr className="clickable" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <td><div className="cell-title"><b className="num">{invoice.number}</b><span>{invoice.lineItems[0]?.description ?? invoice.memo ?? ""}{invoice.lineItems.length > 1 ? ` and ${invoice.lineItems.length - 1} more` : ""}</span></div></td>
      <td><div className="cell-title"><b style={{ fontWeight: 450 }}>{invoice.customerName}</b>{invoice.customerEmail && <span>{invoice.customerEmail}</span>}</div></td>
      <td>{treasury ? <div className="cell-title"><b style={{ fontWeight: 450 }}>{treasury.name}</b><span>{networkLabel(treasury.network)}</span></div> : networkLabel(invoice.network)}</td>
      <td className="right primary">
        <Amount value={invoice.subtotalBaseUnits} decimals={meta.decimals} symbol={meta.symbol} />
        {invoice.status === "open" && BigInt(invoice.amountPaidBaseUnits) > 0n && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{displayUnits(invoice.amountPaidBaseUnits, meta.decimals)} paid</div>}
      </td>
      <td><Pill tone={state.tone}>{state.label}</Pill></td>
      <td>{invoice.status === "paid" && invoice.paidAt ? <span>Paid <Ago iso={invoice.paidAt} /></span> : invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : <span className="faint">No due date</span>}</td>
    </tr>
  );
}

interface LineDraft { description: string; quantity: string; unit: string }

function CreateInvoice({ onClose, onCreated }: { onClose(): void; onCreated(invoice: Invoice): void }) {
  const treasuries = useTreasuries();
  const assets = useAssets();
  const { busy, run } = useAction();
  const active = (treasuries.data ?? []).filter((treasury) => treasury.status === "active");
  const [treasuryId, setTreasuryId] = useState("");
  const treasury = active.find((candidate) => candidate.id === treasuryId) ?? active[0];
  // An EVM invoice must be in a token: a native deposit into a Safe cannot be attributed to it.
  const networkAssets = (assets.data ?? []).filter((asset) => asset.network === treasury?.network && (treasury?.chainFamily !== "evm" || asset.kind === "erc20"));
  const [assetId, setAssetId] = useState("");
  const asset = networkAssets.find((candidate) => candidate.id === assetId) ?? networkAssets[0];
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [memo, setMemo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [issue, setIssue] = useState(true);
  const [lines, setLines] = useState<LineDraft[]>([{ description: "", quantity: "1", unit: "" }]);
  const [error, setError] = useState<string | null>(null);

  const subtotal = useMemo(() => {
    if (!asset) return null;
    try {
      return lines.reduce((sum, line) => sum + (line.unit ? parseUnits(line.unit, asset.decimals) : 0n) * BigInt(Number.parseInt(line.quantity, 10) || 0), 0n);
    } catch { return null; }
  }, [lines, asset]);

  const update = (index: number, patch: Partial<LineDraft>) => setLines((current) => current.map((line, position) => position === index ? { ...line, ...patch } : line));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!treasury || !asset) return;
    let lineItems;
    try {
      lineItems = lines.map((line) => {
        const quantity = Number.parseInt(line.quantity, 10);
        if (!line.description.trim()) throw new Error("Every line needs a description");
        if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantities are whole numbers from 1");
        const unitAmountBaseUnits = parseUnits(line.unit, asset.decimals);
        if (unitAmountBaseUnits === 0n) throw new Error("Unit prices are above zero");
        return { description: line.description.trim(), quantity, unitAmountBaseUnits: unitAmountBaseUnits.toString() };
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Check the lines"); return; }
    const result = await run("create", () => api<{ data: Invoice }>("/v1/invoices", {
      method: "POST",
      body: { treasuryAccountId: treasury.id, assetId: asset.id, customerName, lineItems, issue, ...(customerEmail ? { customerEmail } : {}), ...(memo ? { memo } : {}), ...(dueDate ? { dueAt: new Date(`${dueDate}T23:59:59`).toISOString() } : {}) }
    }), issue ? "Invoice issued" : "Draft saved");
    if (result) { invalidate("/v1/invoices"); onClose(); onCreated(result.data); }
  }

  return (
    <Modal wide title="New invoice" description="Amounts are exact in the asset you choose. Relay adds a sub-cent identifier to the amount due so an incoming transfer can be matched." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="create-invoice" disabled={busy !== null || !treasury || !asset}>{busy ? "Saving…" : issue ? "Issue invoice" : "Save draft"}</button></>}>
      {active.length === 0 ? <Notice>Add a treasury first. It is where the customer's payment arrives.</Notice> : (
        <form id="create-invoice" className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="Receive into">
            <select className="select" value={treasury?.id ?? ""} onChange={(event) => { setTreasuryId(event.target.value); setAssetId(""); }}>
              {active.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {networkLabel(candidate.network)}</option>)}
            </select>
          </Field>
          <Field label="Currency">
            <select className="select" value={asset?.id ?? ""} onChange={(event) => setAssetId(event.target.value)}>
              {networkAssets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.symbol}</option>)}
            </select>
          </Field>
          <Field label="Customer"><input className="input" required maxLength={120} value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Acme Robotics" /></Field>
          <Field label="Customer email" hint="Optional. Relay does not send email."><input className="input" type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} placeholder="ap@acme.com" /></Field>
          <div className="span-2 panel" style={{ background: "var(--panel-2)" }}>
            <div className="rows">
              <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) 80px 150px 32px", padding: "8px 12px", minHeight: 0 }}>
                <span className="eyebrow">Description</span><span className="eyebrow">Qty</span><span className="eyebrow">Unit price</span><span />
              </div>
              {lines.map((line, index) => (
                <div key={index} className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) 80px 150px 32px", padding: "8px 12px", minHeight: 0, gap: 8 }}>
                  <input className="input" required maxLength={200} value={line.description} onChange={(event) => update(index, { description: event.target.value })} placeholder="Model evaluation, September" aria-label={`Line ${index + 1} description`} />
                  <input className="input num" required inputMode="numeric" value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} aria-label={`Line ${index + 1} quantity`} />
                  <input className="input num" required inputMode="decimal" value={line.unit} onChange={(event) => update(index, { unit: event.target.value })} placeholder="0.00" aria-label={`Line ${index + 1} unit price`} />
                  <button type="button" className="icon-button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, position) => position !== index))} aria-label={`Remove line ${index + 1}`}><Icons.Close /></button>
                </div>
              ))}
              <div className="row" style={{ padding: "8px 12px" }}>
                <button type="button" className="btn small ghost" onClick={() => setLines((current) => [...current, { description: "", quantity: "1", unit: "" }])}><Icons.Plus />Add line</button>
                <span className="dim">Subtotal <b className="num" style={{ color: "var(--text)", marginLeft: 8 }}>{subtotal !== null && asset ? `${displayUnits(subtotal, asset.decimals, Math.min(asset.decimals, 6))} ${asset.symbol}` : "Check the prices"}</b></span>
              </div>
            </div>
          </div>
          <Field label="Due date" hint="Optional"><input className="input" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
          <Field label="Memo" hint="Optional. Shown on the payment page."><input className="input" maxLength={1000} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Thanks for your business" /></Field>
          <div className="span-2" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span className="cell-title"><b style={{ fontWeight: 550 }}>Issue now</b><span>Off saves a draft. Only issued invoices have a working payment page.</span></span>
            <Toggle label="Issue now" checked={issue} onChange={setIssue} />
          </div>
        </form>
      )}
      {error && <Notice tone="negative">{error}</Notice>}
    </Modal>
  );
}

function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string; onClose(): void }) {
  const { can } = useSession();
  const detail = useApi<{ invoice: Invoice; payments: Inflow[] }>(`/v1/invoices/${invoiceId}`, { refreshMs: 10_000 });
  const assets = useAssets();
  const treasuries = useTreasuries();
  const { busy, run } = useAction();
  const invoice = detail.data?.invoice;
  if (!invoice) {
    return <Drawer title="Invoice" onClose={onClose}>{detail.error ? <Notice tone="negative">{detail.error.message}</Notice> : <LoadingRows rows={5} />}</Drawer>;
  }
  const meta = assetMeta(assets.byId, invoice.assetId);
  const state = invoiceState(invoice);
  const treasury = treasuries.data?.find((candidate) => candidate.id === invoice.treasuryAccountId);
  const link = typeof window === "undefined" ? `/pay/${invoice.publicToken}` : `${window.location.origin}/pay/${invoice.publicToken}`;
  const remaining = BigInt(invoice.amountDueBaseUnits) - BigInt(invoice.amountPaidBaseUnits);

  const act = (action: "issue" | "void") => run(action, async () => {
    await api(`/v1/invoices/${invoice.id}/${action}`, { method: "POST", body: {} });
    invalidate("/v1/invoices");
  }, action === "issue" ? "Invoice issued" : "Invoice voided");

  return (
    <Drawer title={<span className="num">{invoice.number}</span>} description={`${invoice.customerName}${invoice.customerEmail ? ` · ${invoice.customerEmail}` : ""}`} onClose={onClose}
      footer={can("owner", "operator") && (invoice.status === "draft" || invoice.status === "open") ? (
        <>
          <button className="btn danger" style={{ marginRight: "auto" }} disabled={busy !== null} onClick={() => void act("void")}>Void</button>
          {invoice.status === "draft" ? <button className="btn primary" disabled={busy !== null} onClick={() => void act("issue")}>Issue invoice</button> : <a className="btn" href={link} target="_blank" rel="noreferrer"><Icons.External />Open payment page</a>}
        </>
      ) : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <div className="eyebrow">{invoice.status === "paid" ? "Paid" : "Amount due"}</div>
          <div className="display" style={{ marginTop: 8 }}>{displayUnits(invoice.status === "paid" ? invoice.amountPaidBaseUnits : remaining > 0n ? remaining : 0n, meta.decimals, Math.min(meta.decimals, 6))}<span className="unit">{meta.symbol}</span></div>
        </div>
        <Pill tone={state.tone}>{state.label}</Pill>
      </div>
      {invoice.status !== "draft" && invoice.status !== "void" && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="eyebrow">Payment page</div>
          <CopyField value={link} label={link.replace(/^https?:\/\//, "")} />
        </div>
      )}
      <div className="panel">
        <div className="rows">
          {invoice.lineItems.map((line, index) => (
            <div key={index} className="row">
              <span className="cell-title"><b style={{ fontWeight: 450 }}>{line.description}</b><span className="num">{line.quantity} × {displayUnits(line.unitAmountBaseUnits, meta.decimals, Math.min(meta.decimals, 6))} {meta.symbol}</span></span>
              <Amount value={(BigInt(line.unitAmountBaseUnits) * BigInt(line.quantity)).toString()} decimals={meta.decimals} symbol={meta.symbol} places={Math.min(meta.decimals, 6)} />
            </div>
          ))}
          <div className="row"><span className="dim">Subtotal</span><Amount value={invoice.subtotalBaseUnits} decimals={meta.decimals} symbol={meta.symbol} places={Math.min(meta.decimals, 6)} /></div>
          {invoice.amountDueBaseUnits !== invoice.subtotalBaseUnits && <div className="row"><span className="cell-title"><span className="dim" style={{ fontSize: 13.5 }}>Amount to send</span><span>Includes a matching identifier of {(BigInt(invoice.amountDueBaseUnits) - BigInt(invoice.subtotalBaseUnits)).toString()} base units</span></span><span className="num">{displayUnits(invoice.amountDueBaseUnits, meta.decimals, meta.decimals)} {meta.symbol}</span></div>}
        </div>
      </div>
      <dl className="kv">
        <dt>Receives into</dt><dd>{treasury ? `${treasury.name}, ${shortAddress(treasury.address)}` : "Unknown treasury"}</dd>
        <dt>Network</dt><dd>{networkLabel(invoice.network)}</dd>
        <dt>Issued</dt><dd>{invoice.issuedAt ? formatDate(invoice.issuedAt) : "Not yet"}</dd>
        <dt>Due</dt><dd>{invoice.dueAt ? formatDate(invoice.dueAt) : "No due date"}</dd>
        {invoice.memo && <><dt>Memo</dt><dd>{invoice.memo}</dd></>}
      </dl>
      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Payments received</div>
        {(detail.data?.payments ?? []).length === 0 ? <p className="dim" style={{ margin: 0, fontSize: 13.5 }}>{invoice.status === "open" ? "Nothing yet. The worker checks the treasury every sync and matches transfers of the exact amount." : "None."}</p> : (
          <div className="panel"><div className="rows">
            {(detail.data?.payments ?? []).map((payment) => (
              <div key={payment.id} className="row">
                <span className="cell-title"><b style={{ fontWeight: 450 }}>{payment.method === "x402" ? "x402 payment" : "Transfer"}{payment.fromAddress ? ` from ${shortAddress(payment.fromAddress)}` : ""}</b><span className="address">{shortAddress(payment.transactionHash, 10, 8)} · <Ago iso={payment.observedAt} /></span></span>
                <Amount value={payment.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} sign="+" places={Math.min(meta.decimals, 6)} />
              </div>
            ))}
          </div></div>
        )}
      </div>
    </Drawer>
  );
}

function Receipts({ inflows, loading, invoices, onOpenInvoice }: { inflows: Inflow[] | undefined; loading: boolean; invoices: Invoice[]; onOpenInvoice(id: string): void }) {
  const { can } = useSession();
  const assets = useAssets();
  const treasuries = useTreasuries();
  const rows = inflows ?? [];
  return (
    <section className="panel">
      <header className="panel-head"><div><h2>Money in</h2><p>Every transfer the indexer has seen arrive at a treasury, newest first.</p></div></header>
      {loading && !inflows ? <LoadingRows rows={4} /> : rows.length === 0 ? (
        <Empty title="No receipts yet">When a transfer arrives at one of your treasuries it appears here after the next sync. Transfers of an open invoice's exact amount are matched automatically.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>From</th><th>Into</th><th className="right">Amount</th><th>Invoice</th><th>Seen</th></tr></thead>
            <tbody>
              {rows.map((inflow) => {
                const meta = assetMeta(assets.byId, inflow.assetId);
                const treasury = treasuries.data?.find((candidate) => candidate.id === inflow.treasuryAccountId);
                const invoice = invoices.find((candidate) => candidate.id === inflow.invoiceId);
                return (
                  <tr key={inflow.id}>
                    <td><div className="cell-title"><b style={{ fontWeight: 450 }} className="address">{inflow.fromAddress ? shortAddress(inflow.fromAddress, 8, 6) : "Unknown sender"}</b><span className="address">{inflow.method === "x402" ? "x402 · " : ""}{shortAddress(inflow.transactionHash, 10, 8)}</span></div></td>
                    <td>{treasury?.name ?? networkLabel(inflow.network)}</td>
                    <td className="right primary"><Amount value={inflow.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} sign="+" /></td>
                    <td>{invoice ? <button className="btn small ghost" onClick={() => onOpenInvoice(invoice.id)}>{invoice.number}</button> : can("owner", "operator") ? <Allocate inflow={inflow} invoices={invoices} /> : <span className="faint">Unallocated</span>}</td>
                    <td><Ago iso={inflow.observedAt} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Allocate({ inflow, invoices }: { inflow: Inflow; invoices: Invoice[] }) {
  const { busy, run } = useAction();
  const candidates = invoices.filter((invoice) => invoice.status === "open" && invoice.treasuryAccountId === inflow.treasuryAccountId && invoice.assetId === inflow.assetId);
  const [invoiceId, setInvoiceId] = useState("");
  if (candidates.length === 0) return <span className="faint">No open invoice in this asset</span>;
  const chosen = invoiceId || candidates[0]!.id;
  return (
    <div className="btn-row" style={{ flexWrap: "nowrap" }}>
      <select className="select" style={{ height: 32, width: 150 }} value={chosen} onChange={(event) => setInvoiceId(event.target.value)} aria-label="Invoice">
        {candidates.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.customerName}</option>)}
      </select>
      <button className="btn small" disabled={busy !== null} onClick={() => void run("allocate", async () => { await api(`/v1/inflows/${inflow.id}/allocate`, { method: "POST", body: { invoiceId: chosen } }); invalidate("/v1/inflows"); invalidate("/v1/invoices"); }, "Receipt allocated")}>Allocate</button>
    </div>
  );
}
