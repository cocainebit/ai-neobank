"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icons } from "../../../components/icons";
import { Amount, Empty, ErrorState, Field, LoadingRows, PageHead, Pill } from "../../../components/ui";
import { useApi } from "../../../lib/api";
import { useAssets, useTreasuries } from "../../../lib/data";
import { displayUnits, networkLabel, shortAddress, type Tone } from "../../../lib/format";
import type { Statement } from "../../../lib/types";

const categoryLabel: Record<string, { label: string; tone: Tone }> = {
  inflow: { label: "Money in", tone: "positive" },
  outflow: { label: "Payment", tone: "info" },
  reversal: { label: "Reversal", tone: "pending" },
  fee: { label: "Network fee", tone: "neutral" },
  opening_balance: { label: "Opening balance", tone: "neutral" },
  other: { label: "Adjustment", tone: "neutral" }
};

function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, index - 1, 15)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function StatementsPage() {
  const treasuries = useTreasuries();
  const assets = useAssets();
  const [treasuryId, setTreasuryId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [month, setMonth] = useState("");
  useEffect(() => { setMonth(new Date().toISOString().slice(0, 7)); }, []);
  const treasury = (treasuries.data ?? []).find((candidate) => candidate.id === treasuryId) ?? treasuries.data?.[0];
  const networkAssets = (assets.data ?? []).filter((asset) => asset.network === treasury?.network);
  const asset = networkAssets.find((candidate) => candidate.id === assetId) ?? networkAssets[0];
  const query = treasury && asset && month ? `treasuryAccountId=${treasury.id}&assetId=${encodeURIComponent(asset.id)}&month=${month}` : null;
  const statement = useApi<Statement>(query ? `/v1/statements?${query}` : null);
  const data = statement.data;
  const reconciliation = data?.latestReconciliation;

  return (
    <>
      <PageHead title="Statements" description="Monthly statements from the double-entry ledger, per treasury and asset. Every line ties to a payment, a receipt, or a network fee, and the closing balance is checked against the chain."
        actions={query && data ? <a className="btn" href={`/api/v1/statements?${query}&format=csv`} download><Icons.Download />Download CSV</a> : undefined} />
      {(treasuries.data ?? []).length === 0 && !treasuries.loading ? (
        <section className="panel"><Empty title="No treasuries yet" action={<Link className="btn" href="/treasuries"><Icons.Plus />Add a treasury</Link>}>Statements start with the first treasury you add.</Empty></section>
      ) : (
        <>
          <section className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-body form-grid" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)" }}>
              <Field label="Treasury">
                <select className="select" value={treasury?.id ?? ""} onChange={(event) => { setTreasuryId(event.target.value); setAssetId(""); }}>
                  {(treasuries.data ?? []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {networkLabel(candidate.network)}</option>)}
                </select>
              </Field>
              <Field label="Asset">
                <select className="select" value={asset?.id ?? ""} onChange={(event) => setAssetId(event.target.value)}>
                  {networkAssets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.symbol}</option>)}
                </select>
              </Field>
              <Field label="Month"><input className="input" type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(event) => setMonth(event.target.value)} /></Field>
            </div>
          </section>
          {statement.error ? <section className="panel"><ErrorState error={statement.error} retry={() => void statement.reload()} /></section> : !data ? <section className="panel"><LoadingRows rows={5} /></section> : (
            <>
              <section className="panel milled" style={{ marginBottom: 16 }}>
                <header className="panel-head">
                  <div><h2>{treasury?.name}, {monthLabel(month)}</h2><p className="address">{treasury ? shortAddress(treasury.address, 10, 8) : ""} · {data.symbol} on {networkLabel(treasury?.network ?? "")}</p></div>
                  {reconciliation && <Pill tone={reconciliation.status === "matched" ? "positive" : reconciliation.status === "in_flight" ? "pending" : "negative"}>{reconciliation.status === "matched" ? "Ledger matches chain" : reconciliation.status === "in_flight" ? "Payments in flight" : "Ledger differs from chain"}</Pill>}
                </header>
                <div className="stat-strip" style={{ ["--stats" as string]: 5 }}>
                  <div><span className="eyebrow">Opening</span><div className="value" style={{ fontSize: 21 }}><Amount value={data.openingBalanceBaseUnits} decimals={data.decimals} symbol={data.symbol} /></div></div>
                  <div><span className="eyebrow">Money in</span><div className="value positive" style={{ fontSize: 21 }}><Amount value={data.inflowsBaseUnits} decimals={data.decimals} symbol={data.symbol} sign={BigInt(data.inflowsBaseUnits) > 0n ? "+" : undefined} /></div></div>
                  <div><span className="eyebrow">Payments out</span><div className="value" style={{ fontSize: 21 }}><Amount value={data.outflowsBaseUnits} decimals={data.decimals} symbol={data.symbol} sign={BigInt(data.outflowsBaseUnits) > 0n ? "-" : undefined} /></div></div>
                  <div><span className="eyebrow">Fees</span><div className="value" style={{ fontSize: 21 }}><Amount value={data.feesBaseUnits} decimals={data.decimals} symbol={data.symbol} places={Math.min(data.decimals, 6)} sign={BigInt(data.feesBaseUnits) > 0n ? "-" : undefined} /></div></div>
                  <div><span className="eyebrow">Closing</span><div className="value" style={{ fontSize: 21 }}><Amount value={data.closingBalanceBaseUnits} decimals={data.decimals} symbol={data.symbol} /></div></div>
                </div>
                {reconciliation && reconciliation.status === "break" && (
                  <div className="panel-body" style={{ borderTop: "1px solid var(--line-soft)", fontSize: 13.5 }}>
                    <span className="negative">The chain shows {displayUnits(reconciliation.chainBalanceBaseUnits, data.decimals, Math.min(data.decimals, 6))} {data.symbol}; the ledger shows {displayUnits(reconciliation.ledgerBalanceBaseUnits, data.decimals, Math.min(data.decimals, 6))} {data.symbol}.</span>
                    <span className="dim"> A difference usually means money moved outside Relay, for example a transfer made directly from a signer's wallet or an internal contract transfer the indexer does not see.</span>
                  </div>
                )}
              </section>
              <section className="panel">
                {data.lines.length === 0 ? (
                  <Empty title={`No activity in ${monthLabel(month)}`}>The balance did not change this month. Choose another month, treasury, or asset above.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>Date</th><th>Description</th><th>Type</th><th className="right">Amount</th><th className="right">Balance</th></tr></thead>
                      <tbody>
                        {data.lines.map((line, index) => {
                          const category = categoryLabel[line.category] ?? categoryLabel.other!;
                          const negative = BigInt(line.amountBaseUnits) < 0n;
                          const absolute = negative ? (-BigInt(line.amountBaseUnits)).toString() : line.amountBaseUnits;
                          return (
                            <tr key={`${line.effectiveAt}-${index}`}>
                              <td>{new Date(line.effectiveAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                              <td><div className="cell-title"><b style={{ fontWeight: 450 }}>{line.intentId ? <Link href={`/payments?intent=${line.intentId}`}>{line.description}</Link> : line.description}</b>{line.reference && <span className="address">{shortAddress(line.reference, 10, 8)}</span>}</div></td>
                              <td><Pill tone={category.tone}>{category.label}</Pill></td>
                              <td className={`right ${negative ? "" : "positive"}`}><Amount value={absolute} decimals={data.decimals} symbol={data.symbol} places={line.category === "fee" ? Math.min(data.decimals, 6) : undefined} sign={negative ? "-" : "+"} /></td>
                              <td className="right primary"><Amount value={line.runningBalanceBaseUnits} decimals={data.decimals} symbol={data.symbol} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
