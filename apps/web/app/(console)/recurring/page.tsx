"use client";

import Link from "next/link";
import { useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Amount, Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, useAction } from "../../../components/ui";
import { api, invalidate, useApi } from "../../../lib/api";
import { assetMeta, useAssets, useBeneficiaries, useTreasuries } from "../../../lib/data";
import { networkLabel, parseUnits, shortAddress, type Tone } from "../../../lib/format";
import type { Schedule } from "../../../lib/types";

const statusTone: Record<string, Tone> = { active: "positive", paused: "pending", cancelled: "neutral", completed: "neutral" };

function cadence(schedule: Pick<Schedule, "intervalUnit" | "intervalCount">): string {
  if (schedule.intervalCount === 1) return schedule.intervalUnit === "day" ? "Daily" : schedule.intervalUnit === "week" ? "Weekly" : "Monthly";
  return `Every ${schedule.intervalCount} ${schedule.intervalUnit}s`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function RecurringPage() {
  const { can } = useSession();
  const schedules = useApi<Schedule[]>("/v1/schedules", { refreshMs: 20_000 });
  const beneficiaries = useBeneficiaries();
  const treasuries = useTreasuries();
  const assets = useAssets();
  const [creating, setCreating] = useState(false);
  const rows = schedules.data ?? [];
  const active = rows.filter((schedule) => schedule.status === "active");
  const nextUp = [...active].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];

  return (
    <>
      <PageHead title="Recurring" description="Payroll, retainers, and subscriptions. Each due payment is created as a normal request, so policy and approvals apply every time; nothing is pre-authorized."
        actions={can("owner", "operator") ? <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />New recurring payment</button> : undefined} />
      {rows.length > 0 && (
        <section className="panel milled" style={{ marginBottom: 16 }}>
          <div className="stat-strip" style={{ ["--stats" as string]: 3 }}>
            <div><span className="eyebrow">Active</span><div className="value">{active.length}</div><div className="sub">{rows.length - active.length} paused, cancelled, or finished</div></div>
            <div><span className="eyebrow">Next payment</span><div className="value" style={{ fontSize: 20, marginTop: 14 }}>{nextUp ? when(nextUp.nextRunAt) : "None scheduled"}</div><div className="sub truncate">{nextUp ? nextUp.purpose : "Activate a schedule to plan one"}</div></div>
            <div><span className="eyebrow">Payments created</span><div className="value">{rows.reduce((sum, schedule) => sum + schedule.occurrencesCreated, 0)}</div><div className="sub"><Link href="/payments" style={{ textDecoration: "underline" }}>Follow them in Payments</Link></div></div>
          </div>
        </section>
      )}
      <section className="panel">
        {schedules.error ? <ErrorState error={schedules.error} retry={() => void schedules.reload()} /> : schedules.loading && !schedules.data ? <LoadingRows rows={4} /> : rows.length === 0 ? (
          <Empty title="No recurring payments" action={can("owner", "operator") ? <button className="btn" onClick={() => setCreating(true)}><Icons.Plus />Set one up</button> : undefined}>
            Recurring payments go to approved beneficiaries only. Add and approve the recipient in Beneficiaries first.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Payment</th><th>To</th><th>From</th><th className="right">Amount</th><th>Cadence</th><th>Next</th><th>Status</th><th className="right" aria-label="Actions" /></tr></thead>
              <tbody>
                {rows.map((schedule) => {
                  const beneficiary = beneficiaries.data?.find((candidate) => candidate.id === schedule.beneficiaryId);
                  const treasury = treasuries.data?.find((candidate) => candidate.id === schedule.treasuryAccountId);
                  const meta = assetMeta(assets.byId, schedule.assetId);
                  return (
                    <tr key={schedule.id}>
                      <td><div className="cell-title"><b>{schedule.purpose}</b><span>{schedule.occurrencesCreated} created{schedule.maxOccurrences ? ` of ${schedule.maxOccurrences}` : ""}</span></div></td>
                      <td>{beneficiary ? <div className="cell-title"><b style={{ fontWeight: 450 }}>{beneficiary.name}</b><span className="address">{shortAddress(beneficiary.address)}</span></div> : <span className="faint">Unknown</span>}</td>
                      <td>{treasury?.name ?? <span className="faint">Unknown</span>}</td>
                      <td className="right primary"><Amount value={schedule.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} /></td>
                      <td>{cadence(schedule)}</td>
                      <td>{schedule.status === "active" ? when(schedule.nextRunAt) : <span className="faint">Not scheduled</span>}</td>
                      <td><Pill tone={statusTone[schedule.status] ?? "neutral"}>{schedule.status.charAt(0).toUpperCase() + schedule.status.slice(1)}</Pill></td>
                      <td className="right"><ScheduleActions schedule={schedule} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <CreateSchedule onClose={() => setCreating(false)} />}
    </>
  );
}

function ScheduleActions({ schedule }: { schedule: Schedule }) {
  const { can } = useSession();
  const { busy, run } = useAction();
  if (!can("owner", "operator") || !["active", "paused"].includes(schedule.status)) return null;
  const set = (status: "active" | "paused" | "cancelled") => run(status, async () => {
    await api(`/v1/schedules/${schedule.id}`, { method: "PATCH", body: { status } });
    invalidate("/v1/schedules");
  }, status === "active" ? "Resumed" : status === "paused" ? "Paused" : "Cancelled");
  return (
    <div className="btn-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
      <button className="btn small ghost" disabled={busy !== null} onClick={() => void set(schedule.status === "active" ? "paused" : "active")}>{schedule.status === "active" ? "Pause" : "Resume"}</button>
      <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void set("cancelled")}>Cancel</button>
    </div>
  );
}

function localDateTime(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function CreateSchedule({ onClose }: { onClose(): void }) {
  const treasuries = useTreasuries();
  const beneficiaries = useBeneficiaries();
  const assets = useAssets();
  const { busy, run } = useAction();
  const active = (treasuries.data ?? []).filter((treasury) => treasury.status === "active");
  const [treasuryId, setTreasuryId] = useState("");
  const treasury = active.find((candidate) => candidate.id === treasuryId) ?? active[0];
  const payees = (beneficiaries.data ?? []).filter((beneficiary) => beneficiary.status === "active" && beneficiary.network === treasury?.network);
  const networkAssets = (assets.data ?? []).filter((asset) => asset.network === treasury?.network);
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [assetId, setAssetId] = useState("");
  const asset = networkAssets.find((candidate) => candidate.id === assetId) ?? networkAssets[0];
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [intervalUnit, setIntervalUnit] = useState<Schedule["intervalUnit"]>("month");
  const [intervalCount, setIntervalCount] = useState(1);
  const [startAt, setStartAt] = useState(() => localDateTime(new Date(Date.now() + 5 * 60_000)));
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const payee = payees.find((candidate) => candidate.id === beneficiaryId) ?? payees[0];
    if (!treasury || !asset || !payee) return;
    let amountBaseUnits: string;
    try { amountBaseUnits = parseUnits(amount, asset.decimals).toString(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Invalid amount"); return; }
    if (amountBaseUnits === "0") { setError("Enter an amount above zero"); return; }
    const maxOccurrences = limit ? Number.parseInt(limit, 10) : undefined;
    const result = await run("create", () => api("/v1/schedules", {
      method: "POST",
      body: { treasuryAccountId: treasury.id, beneficiaryId: payee.id, assetId: asset.id, amountBaseUnits, purpose, intervalUnit, intervalCount, startAt: new Date(startAt).toISOString(), ...(maxOccurrences ? { maxOccurrences } : {}) }
    }), "Recurring payment scheduled");
    if (result) { invalidate("/v1/schedules"); onClose(); }
  }

  return (
    <Modal title="New recurring payment" description="On each due date Relay creates a payment request. It goes through policy and approval like any other." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="create-schedule" disabled={busy !== null || !treasury || !asset || payees.length === 0}>{busy ? "Scheduling…" : "Schedule"}</button></>}>
      {active.length === 0 ? <Notice>Add a treasury first.</Notice> : (
        <form id="create-schedule" className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="From" className="span-2">
            <select className="select" value={treasury?.id ?? ""} onChange={(event) => { setTreasuryId(event.target.value); setBeneficiaryId(""); setAssetId(""); }}>
              {active.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {networkLabel(candidate.network)}</option>)}
            </select>
          </Field>
          <Field label="To" className="span-2" hint={payees.length === 0 ? undefined : "Only approved beneficiaries on this treasury's network."}>
            {payees.length === 0 ? <Notice tone="pending">No approved beneficiary on {treasury ? networkLabel(treasury.network) : "this network"}. <Link href="/beneficiaries" style={{ textDecoration: "underline" }}>Add and approve one</Link>.</Notice> : (
              <select className="select" value={beneficiaryId || payees[0]?.id} onChange={(event) => setBeneficiaryId(event.target.value)}>
                {payees.map((payee) => <option key={payee.id} value={payee.id}>{payee.name} · {shortAddress(payee.address)}</option>)}
              </select>
            )}
          </Field>
          <Field label="Amount"><input className="input num" required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></Field>
          <Field label="Asset">
            <select className="select" value={asset?.id ?? ""} onChange={(event) => setAssetId(event.target.value)}>
              {networkAssets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.symbol}</option>)}
            </select>
          </Field>
          <Field label="Purpose" className="span-2"><input className="input" required minLength={3} maxLength={200} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Design retainer" /></Field>
          <Field label="Repeats every">
            <div style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)", gap: 8 }}>
              <input className="input num" type="number" min={1} max={365} value={intervalCount} onChange={(event) => setIntervalCount(Math.max(1, Math.min(365, Number(event.target.value) || 1)))} aria-label="Interval count" />
              <select className="select" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as Schedule["intervalUnit"])} aria-label="Interval unit">
                <option value="day">{intervalCount === 1 ? "day" : "days"}</option><option value="week">{intervalCount === 1 ? "week" : "weeks"}</option><option value="month">{intervalCount === 1 ? "month" : "months"}</option>
              </select>
            </div>
          </Field>
          <Field label="First payment"><input className="input" type="datetime-local" required value={startAt} onChange={(event) => setStartAt(event.target.value)} /></Field>
          <Field label="Number of payments" className="span-2" hint="Optional. Leave empty to repeat until cancelled."><input className="input num" inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value.replace(/\D/g, ""))} placeholder="Until cancelled" /></Field>
        </form>
      )}
      {error && <Notice tone="negative">{error}</Notice>}
    </Modal>
  );
}
