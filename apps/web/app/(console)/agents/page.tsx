"use client";

import Link from "next/link";
import { useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, Amount, CopyField, Drawer, Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, useAction } from "../../../components/ui";
import { api, invalidate, useApi } from "../../../lib/api";
import { assetMeta, useAgents, useAssets, useIntents, usePolicies } from "../../../lib/data";
import { intentStatus } from "../../../lib/format";
import type { Agent, Credential } from "../../../lib/types";

const statusTone = { active: "positive", frozen: "pending", revoked: "negative" } as const;

export default function AgentsPage() {
  const { can } = useSession();
  const agents = useAgents();
  const policies = usePolicies();
  const intents = useIntents();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = agents.data ?? [];
  const selected = rows.find((agent) => agent.id === open);

  return (
    <>
      <PageHead title="Agents" description="Software that asks for money. An agent holds an API key and a spending policy. It can request payments; it never holds a signing key and cannot approve its own requests."
        actions={can("owner", "operator") ? <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />New agent</button> : undefined} />
      <section className="panel">
        {agents.error ? <ErrorState error={agents.error} retry={() => void agents.reload()} /> : agents.loading && !agents.data ? <LoadingRows rows={3} /> : rows.length === 0 ? (
          <Empty title="No agents yet" action={can("owner", "operator") ? <button className="btn" onClick={() => setCreating(true)}><Icons.Plus />Create an agent</button> : undefined}>
            Create an agent, give it an API key, and bind a policy that caps what it can spend. Without a policy, every request waits for a person.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Agent</th><th>Policy</th><th>Requests</th><th>Last request</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((agent) => {
                  const bound = (policies.data ?? []).filter((policy) => policy.bindings.some((binding) => binding.agentId === agent.id));
                  const requests = (intents.data ?? []).filter((intent) => intent.requesterId === agent.principalId);
                  const waiting = requests.filter((intent) => intent.status === "approval_required").length;
                  return (
                    <tr key={agent.id} className="clickable" tabIndex={0} onClick={() => setOpen(agent.id)} onKeyDown={(event) => { if (event.key === "Enter") setOpen(agent.id); }}>
                      <td><div className="cell-title"><b>{agent.displayName}</b><span>{agent.purpose}</span></div></td>
                      <td>{bound.length ? bound.map((policy) => policy.name).join(", ") : <span className="faint">None, every request needs approval</span>}</td>
                      <td className="num">{requests.length}{waiting > 0 && <span style={{ color: "var(--pending)" }}> · {waiting} waiting</span>}</td>
                      <td>{requests[0] ? <Ago iso={requests[0].createdAt} /> : <span className="faint">Never</span>}</td>
                      <td><Pill tone={statusTone[agent.status]}>{agent.status === "active" ? "Active" : agent.status === "frozen" ? "Frozen" : "Revoked"}</Pill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <CreateAgent onClose={() => setCreating(false)} onCreated={(agent) => setOpen(agent.id)} />}
      {selected && <AgentDrawer agent={selected} onClose={() => setOpen(null)} />}
    </>
  );
}

function CreateAgent({ onClose, onCreated }: { onClose(): void; onCreated(agent: Agent): void }) {
  const { busy, run } = useAction();
  const [displayName, setDisplayName] = useState("");
  const [purpose, setPurpose] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await run("create", () => api<{ data: Agent }>("/v1/agents", { method: "POST", body: { displayName, purpose } }), `${displayName} created`);
    if (result) { invalidate("/v1/agents"); onClose(); onCreated(result.data); }
  }

  return (
    <Modal title="New agent" description="Next, create an API key for it and bind a spending policy." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="create-agent" disabled={busy !== null}>{busy ? "Creating…" : "Create agent"}</button></>}>
      <form id="create-agent" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="Name" className="span-2"><input className="input" required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Procurement agent" /></Field>
        <Field label="Purpose" className="span-2" hint="Shown to approvers next to every request this agent makes."><textarea className="textarea" required minLength={3} maxLength={280} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Buys API credits and pays data vendors under $500" /></Field>
      </form>
    </Modal>
  );
}

function AgentDrawer({ agent, onClose }: { agent: Agent; onClose(): void }) {
  const { can } = useSession();
  const policies = usePolicies();
  const intents = useIntents();
  const assets = useAssets();
  const credentials = useApi<Credential[]>(can("owner", "developer") ? `/v1/agents/${agent.id}/credentials` : null);
  const { busy, run } = useAction();
  const [label, setLabel] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [policyId, setPolicyId] = useState("");
  const bound = (policies.data ?? []).filter((policy) => policy.bindings.some((binding) => binding.agentId === agent.id));
  const others = (policies.data ?? []).filter((policy) => !bound.includes(policy));
  const requests = (intents.data ?? []).filter((intent) => intent.requesterId === agent.principalId).slice(0, 6);
  const revoked = agent.status === "revoked";

  const setStatus = (status: Agent["status"]) => run(status, async () => {
    await api(`/v1/agents/${agent.id}/status`, { method: "PATCH", body: { status } });
    invalidate("/v1/agents");
  }, status === "active" ? "Agent unfrozen" : status === "frozen" ? "Agent frozen" : "Agent revoked");

  async function createKey() {
    const result = await run("key", () => api<{ data: Credential; token: string }>(`/v1/agents/${agent.id}/credentials`, { method: "POST", body: label ? { label } : {} }));
    if (result) { setToken(result.token); setLabel(""); invalidate(`/v1/agents/${agent.id}/credentials`); }
  }

  async function bind() {
    const chosen = policyId || others[0]?.id;
    if (!chosen) return;
    await run("bind", async () => {
      await api(`/v1/policies/${chosen}/bindings`, { method: "POST", body: { agentId: agent.id } });
      invalidate("/v1/policies");
    }, bound.length ? "Policy replaced" : "Policy bound");
  }

  return (
    <Drawer title={agent.displayName} description={agent.purpose} onClose={onClose}
      footer={can("owner") && !revoked ? (
        <>
          <button className="btn danger" style={{ marginRight: "auto" }} disabled={busy !== null} onClick={() => void setStatus("revoked")}>Revoke agent</button>
          <button className="btn" disabled={busy !== null} onClick={() => void setStatus(agent.status === "frozen" ? "active" : "frozen")}><Icons.Freeze />{agent.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
        </>
      ) : undefined}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Pill tone={statusTone[agent.status]}>{agent.status === "active" ? "Active" : agent.status === "frozen" ? "Frozen: requests are refused and in-flight ones stop before signing" : "Revoked: keys no longer work"}</Pill>
      </div>

      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Spending policy</div>
        {bound.length === 0 ? <Notice tone="pending">No policy is bound, so every request waits for a person to approve it.</Notice> : (
          <div className="panel"><div className="rows">
            {bound.map((policy) => {
              const definition = policy.latest.definition;
              const asset = assetMeta(assets.byId, definition.allowedAssets[0] ?? "");
              return (
                <div key={policy.id} className="row">
                  <span className="cell-title"><b>{policy.name}</b><span>Version {policy.latest.version} · up to <Amount value={definition.maxPerTransactionBaseUnits} decimals={asset.decimals} symbol={asset.symbol} /> per payment, <Amount value={definition.maxDailyBaseUnits} decimals={asset.decimals} symbol={asset.symbol} /> a day</span></span>
                  <Link className="btn small ghost" href="/policies">Open</Link>
                </div>
              );
            })}
          </div></div>
        )}
        {can("owner") && others.length > 0 && !revoked && (
          <div className="btn-row" style={{ marginTop: 10 }}>
            <select className="select" style={{ flex: 1, minWidth: 0 }} value={policyId || others[0]?.id} onChange={(event) => setPolicyId(event.target.value)} aria-label="Policy to bind">
              {others.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}
            </select>
            <button className="btn" disabled={busy !== null} onClick={() => void bind()}>{bound.length ? "Replace policy" : "Bind policy"}</button>
          </div>
        )}
        {can("owner") && (policies.data ?? []).length === 0 && <p className="faint" style={{ margin: "10px 0 0", fontSize: 13 }}>No policies exist yet. <Link href="/policies" style={{ textDecoration: "underline" }}>Create one</Link>.</p>}
      </div>

      {can("owner", "developer") && (
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>API keys</div>
          {token && (
            <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
              <Notice tone="pending"><b>Copy this key now.</b> It is shown once. Put it in the agent runtime's secret store, never in a prompt.</Notice>
              <CopyField value={token} label={`${token.slice(0, 28)}…`} />
            </div>
          )}
          {credentials.loading && !credentials.data ? <LoadingRows rows={2} /> : (credentials.data ?? []).length === 0 ? <p className="dim" style={{ margin: "0 0 10px", fontSize: 13.5 }}>No keys yet. The agent cannot call the API until it has one.</p> : (
            <div className="panel" style={{ marginBottom: 10 }}><div className="rows">
              {(credentials.data ?? []).map((credential) => (
                <div key={credential.id} className="row">
                  <span className="cell-title"><b>{credential.label ?? "Unnamed key"} <span className="faint address" style={{ fontWeight: 400 }}>rl_agent_{credential.keyId}</span></b><span>Created <Ago iso={credential.createdAt} /> · {credential.lastUsedAt ? <>last used <Ago iso={credential.lastUsedAt} /></> : "never used"}</span></span>
                  {credential.status === "active" ? (
                    <button className="btn small ghost danger" disabled={busy !== null} onClick={() => void run("revoke-key", async () => { await api(`/v1/agents/${agent.id}/credentials/${credential.keyId}`, { method: "DELETE" }); invalidate(`/v1/agents/${agent.id}/credentials`); }, "Key revoked")}>Revoke</button>
                  ) : <Pill tone="negative">Revoked</Pill>}
                </div>
              ))}
            </div></div>
          )}
          {!revoked && (
            <div className="btn-row">
              <input className="input" style={{ flex: 1, minWidth: 0 }} maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label, for example production" aria-label="Key label" />
              <button className="btn" disabled={busy !== null} onClick={() => void createKey()}><Icons.Key />Create key</button>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>Recent requests</div>
        {requests.length === 0 ? <p className="dim" style={{ margin: 0, fontSize: 13.5 }}>This agent has not requested a payment. See <Link href="/developers" style={{ textDecoration: "underline" }}>Developers</Link> for the API.</p> : (
          <div className="panel"><div className="rows">
            {requests.map((intent) => {
              const meta = assetMeta(assets.byId, intent.assetId);
              const status = intentStatus(intent.status);
              return (
                <Link key={intent.id} href={`/payments?intent=${intent.id}`} className="row">
                  <span className="cell-title"><b>{intent.purpose}</b><span><Ago iso={intent.createdAt} /></span></span>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}><Amount value={intent.amountBaseUnits} decimals={meta.decimals} symbol={meta.symbol} /><Pill tone={status.tone}>{status.label}</Pill></span>
                </Link>
              );
            })}
          </div></div>
        )}
      </div>
    </Drawer>
  );
}
