"use client";

import { useMemo, useState } from "react";
import { api, invalidate, useApi } from "../lib/api";
import { useAssets, useBeneficiaries, useTreasuries } from "../lib/data";
import { displayUnits, networkLabel, parseUnits } from "../lib/format";
import type { Balance, Intent } from "../lib/types";
import { Field, Modal, Notice, useAction } from "./ui";

export function NewPayment({ onClose, onCreated, defaultTreasuryId }: { onClose(): void; onCreated?(intent: Intent): void; defaultTreasuryId?: string }) {
  const treasuries = useTreasuries();
  const assets = useAssets();
  const beneficiaries = useBeneficiaries();
  const { busy, run } = useAction();
  const active = (treasuries.data ?? []).filter((treasury) => treasury.status === "active");
  const [treasuryId, setTreasuryId] = useState(defaultTreasuryId ?? "");
  const treasury = active.find((candidate) => candidate.id === treasuryId) ?? active[0];
  const networkAssets = useMemo(() => (assets.data ?? []).filter((asset) => asset.network === treasury?.network), [assets.data, treasury?.network]);
  const payees = (beneficiaries.data ?? []).filter((beneficiary) => beneficiary.status === "active" && beneficiary.network === treasury?.network);
  const [assetId, setAssetId] = useState("");
  // Default to what this treasury actually holds, so the form does not open on an empty asset.
  const balances = useApi<{ balances: Balance[] }>(treasury ? `/v1/treasuries/${treasury.id}/balances` : null);
  const held = useMemo(() => [...(balances.data?.balances ?? [])].filter((balance) => BigInt(balance.balanceBaseUnits ?? "0") > 0n).sort((a, b) => (BigInt(b.balanceBaseUnits ?? "0") > BigInt(a.balanceBaseUnits ?? "0") ? 1 : -1)), [balances.data]);
  const fallback = networkAssets.find((candidate) => candidate.id === held[0]?.assetId) ?? networkAssets.find((candidate) => candidate.kind === "native") ?? networkAssets[0];
  const asset = networkAssets.find((candidate) => candidate.id === assetId) ?? fallback;
  const [recipient, setRecipient] = useState<"beneficiary" | "address">("beneficiary");
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const usingBeneficiary = recipient === "beneficiary" && payees.length > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!treasury || !asset) return;
    let amountBaseUnits: string;
    try { amountBaseUnits = parseUnits(amount, asset.decimals).toString(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Invalid amount"); return; }
    if (amountBaseUnits === "0") { setError("Enter an amount above zero"); return; }
    const chosen = payees.find((beneficiary) => beneficiary.id === beneficiaryId) ?? payees[0];
    const result = await run("create", () => api<{ data: Intent }>("/v1/intents", {
      method: "POST",
      body: { idempotencyKey: `console-${crypto.randomUUID()}`, treasuryAccountId: treasury.id, assetId: asset.id, amountBaseUnits, purpose, ...(usingBeneficiary && chosen ? { beneficiaryId: chosen.id } : { destination }) }
    }), "Payment requested");
    if (result) { invalidate("/v1/intents"); onCreated?.(result.data); onClose(); }
  }

  return (
    <Modal title="New payment" description="Policy and a chain simulation run before anyone is asked to approve." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="new-payment" disabled={busy !== null || !treasury || !asset}>{busy ? "Requesting…" : "Request payment"}</button></>}>
      {active.length === 0 ? <Notice>Add a treasury first. Payments leave from a treasury on its own network.</Notice> : (
        <form id="new-payment" className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="From" className="span-2">
            <select className="select" value={treasury?.id ?? ""} onChange={(event) => { setTreasuryId(event.target.value); setAssetId(""); setBeneficiaryId(""); }}>
              {active.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {networkLabel(candidate.network)}</option>)}
            </select>
          </Field>
          <Field label="To" className="span-2">
            <div className="segmented" role="group" aria-label="Recipient type">
              <button type="button" aria-pressed={usingBeneficiary} disabled={payees.length === 0} onClick={() => setRecipient("beneficiary")}>Beneficiary</button>
              <button type="button" aria-pressed={!usingBeneficiary} onClick={() => setRecipient("address")}>Address</button>
            </div>
          </Field>
          {usingBeneficiary ? (
            <Field label="Beneficiary" className="span-2">
              <select className="select" value={beneficiaryId || payees[0]?.id} onChange={(event) => setBeneficiaryId(event.target.value)}>
                {payees.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.name}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Address" className="span-2" hint={payees.length === 0 ? "No approved beneficiaries on this network yet. Policies can require one." : undefined}>
              <input className="input address" required value={destination} onChange={(event) => setDestination(event.target.value)} placeholder={treasury?.chainFamily === "evm" ? "0x…" : "Solana address"} />
            </Field>
          )}
          <Field label="Amount">
            <input className="input num" required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Asset">
            <select className="select" value={asset?.id ?? ""} onChange={(event) => setAssetId(event.target.value)}>
              {networkAssets.map((candidate) => {
                const balance = held.find((entry) => entry.assetId === candidate.id);
                return <option key={candidate.id} value={candidate.id}>{candidate.symbol}{balance ? ` · ${displayUnits(balance.balanceBaseUnits ?? "0", balance.decimals)} available` : ""}</option>;
              })}
            </select>
          </Field>
          <Field label="Purpose" className="span-2" hint="Shown to approvers and kept in the audit trail.">
            <input className="input" required minLength={3} maxLength={280} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Contractor payout for September" />
          </Field>
          {error && <div className="span-2"><Notice tone="negative">{error}</Notice></div>}
        </form>
      )}
    </Modal>
  );
}
