"use client";

import { useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, useAction } from "../../../components/ui";
import { api, invalidate } from "../../../lib/api";
import { useMembers, useTreasuries } from "../../../lib/data";
import { shortAddress } from "../../../lib/format";
import type { Member, Role } from "../../../lib/types";

const roles: { role: Exclude<Role, "agent">; label: string; description: string }[] = [
  { role: "owner", label: "Owner", description: "Everything, including members, policies, treasuries, and freezing" },
  { role: "approver", label: "Approver", description: "Approves or rejects payments with their wallet" },
  { role: "operator", label: "Operator", description: "Requests payments, invoices, and recurring payments" },
  { role: "developer", label: "Developer", description: "Manages agent API keys" },
  { role: "auditor", label: "Auditor", description: "Reads everything, changes nothing" }
];
const roleLabel = Object.fromEntries(roles.map((entry) => [entry.role, entry.label])) as Record<string, string>;

export default function MembersPage() {
  const { can } = useSession();
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const rows = members.data ?? [];

  return (
    <>
      <PageHead title="Members" description="People in this workspace sign in with their wallet. Roles decide what they can do here; on a Safe or Squads treasury, the chain also checks that an approver is an owner or voting member."
        actions={can("owner") ? <button className="btn primary" onClick={() => setAdding(true)}><Icons.Plus />Add member</button> : undefined} />
      <div className="grid-main">
        <section className="panel">
          <header className="panel-head"><div><h2>{rows.length} {rows.length === 1 ? "member" : "members"}</h2><p>Frozen members cannot sign in or approve. Revoking is permanent.</p></div></header>
          {members.error ? <ErrorState error={members.error} retry={() => void members.reload()} /> : members.loading && !members.data ? <LoadingRows rows={3} /> : rows.length === 0 ? (
            <Empty title="No members">Members appear here once added.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Name</th><th>Role</th><th>Wallet</th><th>Status</th><th className="right" aria-label="Actions" /></tr></thead>
                <tbody>{rows.map((member) => <MemberRow key={member.id} member={member} />)}</tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel">
          <header className="panel-head"><div><h2>Roles</h2><p>What each role can do in Relay</p></div></header>
          <div className="rows">
            {roles.map((entry) => (
              <div key={entry.role} className="row" style={{ gridTemplateColumns: "96px minmax(0, 1fr)", alignItems: "start" }}>
                <b style={{ fontWeight: 550 }}>{entry.label}</b>
                <span className="dim" style={{ fontSize: 13 }}>{entry.description}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      {adding && <AddMember onClose={() => setAdding(false)} />}
    </>
  );
}

function MemberRow({ member }: { member: Member }) {
  const { session, can } = useSession();
  const treasuries = useTreasuries();
  const { busy, run } = useAction();
  const self = member.id === session.principal?.id;
  const wallet = member.wallets[0];
  const governs = (treasuries.data ?? []).filter((treasury) => member.wallets.some((candidate) => {
    const configuration = treasury.observedConfiguration;
    const keys = treasury.governance === "safe" ? configuration.owners ?? [] : (configuration.members ?? []).filter((entry) => entry.canVote).map((entry) => entry.key);
    return keys.some((key) => key.toLowerCase() === candidate.address.toLowerCase());
  }));

  const setStatus = (status: Member["status"]) => run(status, async () => {
    await api(`/v1/members/${member.id}`, { method: "PATCH", body: { status } });
    invalidate("/v1/members");
  }, status === "active" ? `${member.displayName} reactivated` : status === "frozen" ? `${member.displayName} frozen` : `${member.displayName} revoked`);

  return (
    <tr>
      <td><div className="cell-title"><b>{member.displayName}{self && <span className="faint" style={{ fontWeight: 400 }}> · you</span>}</b><span>{governs.length ? `Signs for ${governs.map((treasury) => treasury.name).join(", ")}` : "Not a signer on any treasury"}</span></div></td>
      <td>{roleLabel[member.role] ?? member.role}</td>
      <td>{wallet ? <span className="address" title={wallet.address}>{wallet.chainFamily === "evm" ? "EVM" : "Solana"} · {shortAddress(wallet.address, 8, 6)}</span> : <span className="faint">No wallet</span>}</td>
      <td><Pill tone={member.status === "active" ? "positive" : member.status === "frozen" ? "pending" : "negative"}>{member.status === "active" ? "Active" : member.status === "frozen" ? "Frozen" : "Revoked"}</Pill></td>
      <td className="right">
        {can("owner") && !self && member.status !== "revoked" && (
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn small ghost" disabled={busy !== null} onClick={() => void setStatus(member.status === "frozen" ? "active" : "frozen")}>{member.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
            <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void setStatus("revoked")}>Revoke</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function AddMember({ onClose }: { onClose(): void }) {
  const { busy, run } = useAction();
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Exclude<Role, "agent">>("approver");
  const [chainFamily, setChainFamily] = useState<"evm" | "svm">("evm");
  const [address, setAddress] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await run("add", () => api("/v1/members", { method: "POST", body: { displayName, role, wallet: { chainFamily, address: address.trim() } } }), `${displayName} added`);
    if (result) { invalidate("/v1/members"); onClose(); }
  }

  return (
    <Modal title="Add member" description="They sign in with this wallet. No invitation email: share the console address with them." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-member" disabled={busy !== null}>{busy ? "Adding…" : "Add member"}</button></>}>
      <form id="add-member" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="Name" className="span-2"><input className="input" required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Dana Whitfield" /></Field>
        <Field label="Role" className="span-2" hint={roles.find((entry) => entry.role === role)?.description}>
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            {roles.map((entry) => <option key={entry.role} value={entry.role}>{entry.label}</option>)}
          </select>
        </Field>
        <Field label="Wallet" className="span-2">
          <div className="segmented" role="group" aria-label="Wallet type">
            <button type="button" aria-pressed={chainFamily === "evm"} onClick={() => setChainFamily("evm")}>Ethereum</button>
            <button type="button" aria-pressed={chainFamily === "svm"} onClick={() => setChainFamily("svm")}>Solana</button>
          </div>
        </Field>
        <Field label="Wallet address" className="span-2"><input className="input address" required value={address} onChange={(event) => setAddress(event.target.value)} placeholder={chainFamily === "evm" ? "0x…" : "Solana address"} /></Field>
      </form>
      {role === "approver" && <Notice>To approve payments from a Safe or Squads treasury, this wallet must also be an owner or voting member on chain. Adding them here does not change the multisig.</Notice>}
    </Modal>
  );
}
