"use client";

import { useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, CopyField, Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, useAction } from "../../../components/ui";
import { api, invalidate } from "../../../lib/api";
import { useBeneficiaries, useMembers, useNetworks } from "../../../lib/data";
import { networkLabel, shortAddress } from "../../../lib/format";
import { signPlain } from "../../../lib/sign";
import type { Beneficiary } from "../../../lib/types";

const statusTone = { pending: "pending", active: "positive", archived: "neutral" } as const;
const statusLabel = { pending: "Needs owner approval", active: "Approved", archived: "Archived" } as const;

export default function BeneficiariesPage() {
  const { can } = useSession();
  const beneficiaries = useBeneficiaries();
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const all = beneficiaries.data ?? [];
  const rows = all.filter((beneficiary) => showArchived || beneficiary.status !== "archived");
  const pending = all.filter((beneficiary) => beneficiary.status === "pending").length;
  const archived = all.filter((beneficiary) => beneficiary.status === "archived").length;

  return (
    <>
      <PageHead title="Beneficiaries" description="People and businesses you pay. A new address becomes payable only after an owner signs its exact address with their wallet, so a changed digit cannot slip through."
        actions={can("owner", "operator") ? <button className="btn primary" onClick={() => setAdding(true)}><Icons.Plus />Add beneficiary</button> : undefined} />
      {pending > 0 && can("owner") && (
        <div style={{ marginBottom: 16 }}><Notice tone="pending"><b>{pending} waiting for your signature.</b> Check each address against a source you trust (an invoice, a call), then approve.</Notice></div>
      )}
      <section className="panel">
        <header className="panel-head">
          <div><h2>{rows.length} {rows.length === 1 ? "beneficiary" : "beneficiaries"}</h2><p>Policies can require that transfers only go to approved beneficiaries.</p></div>
          {archived > 0 && <button className="btn small ghost" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Hide archived" : `Show archived (${archived})`}</button>}
        </header>
        {beneficiaries.error ? <ErrorState error={beneficiaries.error} retry={() => void beneficiaries.reload()} /> : beneficiaries.loading && !beneficiaries.data ? <LoadingRows rows={4} /> : rows.length === 0 ? (
          <Empty title="No beneficiaries yet" action={can("owner", "operator") ? <button className="btn" onClick={() => setAdding(true)}><Icons.Plus />Add a beneficiary</button> : undefined}>
            Add the people and vendors you pay regularly. Recurring payments go only to approved beneficiaries.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Address</th><th>Network</th><th>Status</th><th>Added</th><th className="right" aria-label="Actions" /></tr></thead>
              <tbody>{rows.map((beneficiary) => <BeneficiaryRow key={beneficiary.id} beneficiary={beneficiary} />)}</tbody>
            </table>
          </div>
        )}
      </section>
      {adding && <AddBeneficiary onClose={() => setAdding(false)} />}
    </>
  );
}

function BeneficiaryRow({ beneficiary }: { beneficiary: Beneficiary }) {
  const { session, can } = useSession();
  const { busy, run } = useAction();

  async function approve() {
    await run("approve", async () => {
      const { data } = await api<{ data: { message: string } }>(`/v1/beneficiaries/${beneficiary.id}/approval-message`);
      const signature = await signPlain(session, data.message);
      await api(`/v1/beneficiaries/${beneficiary.id}/approve`, { method: "POST", body: { signature } });
      invalidate("/v1/beneficiaries");
    }, `${beneficiary.name} approved`);
  }

  async function archive() {
    await run("archive", async () => {
      await api(`/v1/beneficiaries/${beneficiary.id}/archive`, { method: "POST", body: {} });
      invalidate("/v1/beneficiaries");
    }, `${beneficiary.name} archived`);
  }

  return (
    <tr>
      <td><div className="cell-title"><b>{beneficiary.name}</b>{beneficiary.email && <span>{beneficiary.email}</span>}</div></td>
      <td><span className="address" title={beneficiary.address}>{shortAddress(beneficiary.address, 10, 8)}</span></td>
      <td>{networkLabel(beneficiary.network)}</td>
      <td><Pill tone={statusTone[beneficiary.status]}>{statusLabel[beneficiary.status]}</Pill></td>
      <td>{beneficiary.approvedAt ? <span title="Approved">Approved <Ago iso={beneficiary.approvedAt} /></span> : <Ago iso={beneficiary.createdAt} />}</td>
      <td className="right">
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          {beneficiary.status === "pending" && can("owner") && (
            <button className="btn small" disabled={busy !== null || !session.wallet} title={session.wallet ? undefined : "Sign in with a wallet to approve"} onClick={() => void approve()}>
              <Icons.Check />{busy === "approve" ? "Waiting for wallet…" : "Approve"}
            </button>
          )}
          {beneficiary.status !== "archived" && can("owner") && <button className="btn small ghost" disabled={busy !== null} onClick={() => void archive()}>Archive</button>}
        </div>
      </td>
    </tr>
  );
}

function AddBeneficiary({ onClose }: { onClose(): void }) {
  const networks = useNetworks();
  const members = useMembers();
  const { can } = useSession();
  const { busy, run } = useAction();
  const options = [networks.data?.evm && { network: networks.data.evm.network, family: "evm" as const }, networks.data?.solana && { network: networks.data.solana.network, family: "svm" as const }].filter(Boolean) as { network: string; family: "evm" | "svm" }[];
  const [network, setNetwork] = useState("");
  const chosen = options.find((option) => option.network === network) ?? options[0];
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [created, setCreated] = useState<Beneficiary | null>(null);
  const ownerCount = (members.data ?? []).filter((member) => member.role === "owner" && member.status === "active").length;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    const result = await run("create", () => api<{ data: Beneficiary }>("/v1/beneficiaries", {
      method: "POST",
      body: { name, chainFamily: chosen.family, network: chosen.network, address: address.trim(), ...(email ? { email } : {}), ...(notes ? { notes } : {}) }
    }));
    if (result) { invalidate("/v1/beneficiaries"); setCreated(result.data); }
  }

  if (created) {
    return (
      <Modal title="Beneficiary added" description="It is not payable until an owner approves it with a wallet signature." onClose={onClose}
        footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <CopyField value={created.address} />
        <Notice tone="pending">{can("owner") ? "Approve it from the list once you have checked the address with the recipient." : `Ask ${ownerCount === 1 ? "the owner" : "an owner"} to approve it.`}</Notice>
      </Modal>
    );
  }

  return (
    <Modal title="Add beneficiary" description="Checked against the chain's address format. Owners approve it before money can go there." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-beneficiary" disabled={busy !== null || !chosen}>{busy ? "Adding…" : "Add beneficiary"}</button></>}>
      {options.length === 0 ? <Notice tone="negative">The API is not connected to any network.</Notice> : (
        <form id="add-beneficiary" className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="Name" className="span-2"><input className="input" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Northwind Design LLC" /></Field>
          <Field label="Network" className="span-2">
            <select className="select" value={chosen?.network ?? ""} onChange={(event) => setNetwork(event.target.value)}>
              {options.map((option) => <option key={option.network} value={option.network}>{networkLabel(option.network)}</option>)}
            </select>
          </Field>
          <Field label="Address" className="span-2"><input className="input address" required value={address} onChange={(event) => setAddress(event.target.value)} placeholder={chosen?.family === "evm" ? "0x…" : "Solana address"} /></Field>
          <Field label="Email" hint="Optional"><input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="billing@northwind.com" /></Field>
          <Field label="Notes" hint="Optional"><input className="input" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Confirmed on a call" /></Field>
        </form>
      )}
    </Modal>
  );
}
