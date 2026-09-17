"use client";

import { useMemo, useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Amount, Empty, ErrorState, Field, LoadingRows, Modal, Notice, PageHead, Pill, Toggle, useAction } from "../../../components/ui";
import { api, invalidate } from "../../../lib/api";
import { assetMeta, useAgents, useAssets, usePolicies, useTreasuries } from "../../../lib/data";
import { formatUnits, networkLabel, parseUnits } from "../../../lib/format";
import type { Policy, PolicyDefinition } from "../../../lib/types";

export default function PoliciesPage() {
  const { can } = useSession();
  const policies = usePolicies();
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const [binding, setBinding] = useState<Policy | null>(null);
  const rows = policies.data ?? [];

  return (
    <>
      <PageHead title="Policies" description="Rules checked when a payment is requested and again right before it is signed. Anything a policy does not allow is refused, not escalated."
        actions={can("owner") ? <button className="btn primary" onClick={() => setEditing("new")}><Icons.Plus />New policy</button> : undefined} />
      {policies.error ? <section className="panel"><ErrorState error={policies.error} retry={() => void policies.reload()} /></section> : policies.loading && !policies.data ? <section className="panel"><LoadingRows rows={3} /></section> : rows.length === 0 ? (
        <section className="panel">
          <Empty title="No policies yet" action={can("owner") ? <button className="btn" onClick={() => setEditing("new")}><Icons.Plus />Create a policy</button> : undefined}>
            A policy sets per-payment and daily caps, the assets and networks allowed, and how much an agent may spend without a person. Bind it to an agent or a treasury.
          </Empty>
        </section>
      ) : (
        <div className="grid-2">
          {rows.map((policy) => <PolicyCard key={policy.id} policy={policy} onEdit={() => setEditing(policy)} onBind={() => setBinding(policy)} />)}
        </div>
      )}
      {editing && <PolicyEditor policy={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {binding && <BindPolicy policy={binding} onClose={() => setBinding(null)} />}
    </>
  );
}

function PolicyCard({ policy, onEdit, onBind }: { policy: Policy; onEdit(): void; onBind(): void }) {
  const { can } = useSession();
  const assets = useAssets();
  const agents = useAgents();
  const treasuries = useTreasuries();
  const definition = policy.latest.definition;
  const asset = assetMeta(assets.byId, definition.allowedAssets[0] ?? "");
  const approvalRule = definition.humanApprovalRequired ? "A person approves every payment" : BigInt(definition.autoApproveUpToBaseUnits) === 0n ? "A person approves every payment" : null;
  const boundTo = policy.bindings.map((binding) => binding.agentId ? agents.data?.find((agent) => agent.id === binding.agentId)?.displayName : treasuries.data?.find((treasury) => treasury.id === binding.treasuryAccountId)?.name).filter(Boolean);

  return (
    <section className="panel milled">
      <header className="panel-head" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="truncate">{policy.name}</h2>
          <p>Version {policy.latest.version} · {boundTo.length ? `Applies to ${boundTo.join(", ")}` : "Not bound to anything yet"}</p>
        </div>
        <Pill tone={definition.frozen ? "negative" : "positive"}>{definition.frozen ? "Frozen" : "In force"}</Pill>
      </header>
      <div className="stat-strip" style={{ ["--stats" as string]: 3, borderBottom: "1px solid var(--line-soft)" }}>
        <div><span className="eyebrow">Per payment</span><div className="value" style={{ fontSize: 20 }}><Amount value={definition.maxPerTransactionBaseUnits} decimals={asset.decimals} symbol={asset.symbol} /></div></div>
        <div><span className="eyebrow">Per day</span><div className="value" style={{ fontSize: 20 }}><Amount value={definition.maxDailyBaseUnits} decimals={asset.decimals} symbol={asset.symbol} /></div></div>
        <div><span className="eyebrow">Without a person</span><div className="value" style={{ fontSize: 20 }}>{approvalRule ? "None" : <Amount value={definition.autoApproveUpToBaseUnits} decimals={asset.decimals} symbol={asset.symbol} />}</div></div>
      </div>
      <div className="panel-body">
        <dl className="kv" style={{ margin: 0 }}>
          <dt>Assets</dt><dd>{definition.allowedAssets.map((id) => `${assetMeta(assets.byId, id).symbol || id} on ${networkLabel(id.split("/")[0] ?? "")}`).join(", ")}</dd>
          <dt>Payment types</dt><dd>{definition.allowedKinds.map((kind) => kind === "x402" ? "x402 purchases" : "Transfers").join(", ")}</dd>
          <dt>Recipients</dt><dd>{definition.requireBeneficiary ? "Approved beneficiaries only" : definition.allowedDestinations.length ? `${definition.allowedDestinations.length} listed ${definition.allowedDestinations.length === 1 ? "address" : "addresses"}` : "Any address"}</dd>
          <dt>Approvals</dt><dd>{approvalRule ?? "Above the no-person limit, a person approves"} · at least {definition.minApprovals}</dd>
        </dl>
        {can("owner") && (
          <div className="btn-row" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-soft)" }}>
            <button className="btn small" onClick={onEdit}>Edit</button>
            <button className="btn small ghost" onClick={onBind}><Icons.Link />Bind</button>
          </div>
        )}
      </div>
    </section>
  );
}

function PolicyEditor({ policy, onClose }: { policy: Policy | null; onClose(): void }) {
  const assets = useAssets();
  const { busy, run } = useAction();
  const initial = policy?.latest.definition;
  const initialAsset = assetMeta(assets.byId, initial?.allowedAssets[0] ?? "");
  const [name, setName] = useState(policy?.name ?? "");
  const [selected, setSelected] = useState<string[]>(initial?.allowedAssets ?? []);
  const toDecimal = (value: string | undefined) => value && initialAsset.decimals ? formatUnits(value, initialAsset.decimals) : "";
  const [perPayment, setPerPayment] = useState(toDecimal(initial?.maxPerTransactionBaseUnits));
  const [perDay, setPerDay] = useState(toDecimal(initial?.maxDailyBaseUnits));
  const [autoUpTo, setAutoUpTo] = useState(initial && !initial.humanApprovalRequired ? toDecimal(initial.autoApproveUpToBaseUnits) : "0");
  const [humanAlways, setHumanAlways] = useState(initial?.humanApprovalRequired ?? true);
  const [minApprovals, setMinApprovals] = useState(initial?.minApprovals ?? 1);
  const [requireBeneficiary, setRequireBeneficiary] = useState(initial?.requireBeneficiary ?? false);
  const [x402, setX402] = useState(initial?.allowedKinds.includes("x402") ?? false);
  const [destinations, setDestinations] = useState((initial?.allowedDestinations ?? []).join("\n"));
  const [frozen, setFrozen] = useState(initial?.frozen ?? false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => (assets.data ?? []).filter((asset) => selected.includes(asset.id)), [assets.data, selected]);
  const decimals = new Set(chosen.map((asset) => asset.decimals));
  const unit = chosen.length ? chosen.map((asset) => asset.symbol).join(" / ") : "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (chosen.length === 0) { setError("Choose at least one asset."); return; }
    if (decimals.size > 1) { setError("These assets use different decimals, so one amount cannot cap them all. Make a policy per asset."); return; }
    const places = chosen[0]!.decimals;
    let definition: PolicyDefinition;
    try {
      definition = {
        frozen,
        maxPerTransactionBaseUnits: parseUnits(perPayment, places).toString(),
        maxDailyBaseUnits: parseUnits(perDay, places).toString(),
        autoApproveUpToBaseUnits: humanAlways ? "0" : parseUnits(autoUpTo || "0", places).toString(),
        allowedNetworks: [...new Set(chosen.map((asset) => asset.network))],
        allowedAssets: chosen.map((asset) => asset.id),
        allowedDestinations: destinations.split(/\s+/).map((line) => line.trim()).filter(Boolean),
        allowedKinds: x402 ? ["transfer", "x402"] : ["transfer"],
        humanApprovalRequired: humanAlways,
        minApprovals,
        requireBeneficiary
      };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the amounts"); return;
    }
    if (BigInt(definition.maxDailyBaseUnits) < BigInt(definition.maxPerTransactionBaseUnits)) { setError("The daily cap is below the per-payment cap."); return; }
    if (BigInt(definition.autoApproveUpToBaseUnits) > BigInt(definition.maxPerTransactionBaseUnits)) { setError("The no-person limit is above the per-payment cap."); return; }
    const result = await run("save", () => policy
      ? api(`/v1/policies/${policy.id}/versions`, { method: "POST", body: { definition } })
      : api("/v1/policies", { method: "POST", body: { name, definition } }), policy ? `Version ${policy.latest.version + 1} saved` : "Policy created");
    if (result) { invalidate("/v1/policies"); onClose(); }
  }

  return (
    <Modal wide title={policy ? `Edit ${policy.name}` : "New policy"} description={policy ? "Saving creates a new version that applies at once, including to approved payments not yet signed: every payment is checked again right before signing." : "Bind it to an agent or treasury after creating it."} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="policy-editor" disabled={busy !== null}>{busy ? "Saving…" : policy ? "Save new version" : "Create policy"}</button></>}>
      <form id="policy-editor" className="form-grid" onSubmit={(event) => void submit(event)}>
        {!policy && <Field label="Name" className="span-2"><input className="input" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Vendor payments" /></Field>}
        <Field label="Assets" className="span-2" hint="Caps apply to each asset separately.">
          <div className="btn-row">
            {(assets.data ?? []).map((asset) => {
              const on = selected.includes(asset.id);
              return (
                <button key={asset.id} type="button" className={`btn small ${on ? "" : "ghost"}`} aria-pressed={on} style={on ? { borderColor: "var(--text)" } : { border: "1px solid var(--line)" }}
                  onClick={() => setSelected((current) => on ? current.filter((id) => id !== asset.id) : [...current, asset.id])}>
                  {on && <Icons.Check />}{asset.symbol} <span className="faint">{networkLabel(asset.network)}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={`Per payment${unit ? ` (${unit})` : ""}`}><input className="input num" required inputMode="decimal" value={perPayment} onChange={(event) => setPerPayment(event.target.value)} placeholder="500" /></Field>
        <Field label={`Per day${unit ? ` (${unit})` : ""}`} hint="Rolling total per requester, per asset"><input className="input num" required inputMode="decimal" value={perDay} onChange={(event) => setPerDay(event.target.value)} placeholder="2000" /></Field>
        <div className="span-2 panel" style={{ background: "var(--panel-2)" }}>
          <div className="rows">
            <SettingRow title="A person approves every payment" description="Turn off to let small payments go through on policy alone, if the organization allows autonomous execution in Settings.">
              <Toggle label="A person approves every payment" checked={humanAlways} onChange={setHumanAlways} />
            </SettingRow>
            {!humanAlways && (
              <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) 200px" }}>
                <span className="cell-title"><b>Without a person, up to</b><span>Payments above this wait for approval.</span></span>
                <input className="input num" inputMode="decimal" value={autoUpTo} onChange={(event) => setAutoUpTo(event.target.value)} aria-label="Limit without approval" />
              </div>
            )}
            <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) 120px" }}>
              <span className="cell-title"><b>Approvals needed</b><span>On a Safe or Squads treasury the on-chain threshold also applies; the higher number wins.</span></span>
              <input className="input num" type="number" min={1} max={20} value={minApprovals} onChange={(event) => setMinApprovals(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} aria-label="Approvals needed" />
            </div>
            <SettingRow title="Only approved beneficiaries" description="Transfers must go to a beneficiary an owner has signed for.">
              <Toggle label="Only approved beneficiaries" checked={requireBeneficiary} onChange={setRequireBeneficiary} />
            </SettingRow>
            <SettingRow title="Allow x402 purchases" description="Lets an agent pay for HTTP resources that ask for x402 payment, from a direct treasury.">
              <Toggle label="Allow x402 purchases" checked={x402} onChange={setX402} />
            </SettingRow>
            {policy && (
              <SettingRow title="Freeze this policy" description="Everything bound to it is refused until unfrozen.">
                <Toggle label="Freeze this policy" checked={frozen} onChange={setFrozen} />
              </SettingRow>
            )}
          </div>
        </div>
        <Field label="Allowed addresses" className="span-2" hint="Optional. One per line. Leave empty to allow any address the other rules permit.">
          <textarea className="textarea address" value={destinations} onChange={(event) => setDestinations(event.target.value)} placeholder={"0x…\nSolana address"} />
        </Field>
      </form>
      {error && <Notice tone="negative">{error}</Notice>}
    </Modal>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="cell-title"><b>{title}</b><span style={{ whiteSpace: "normal" }}>{description}</span></span>
      {children}
    </div>
  );
}

function BindPolicy({ policy, onClose }: { policy: Policy; onClose(): void }) {
  const agents = useAgents();
  const treasuries = useTreasuries();
  const policies = usePolicies();
  const { busy, run } = useAction();
  const [target, setTarget] = useState("");
  // An agent or treasury has at most one policy; binding replaces the current one.
  const current = (match: (binding: Policy["bindings"][number]) => boolean) => (policies.data ?? []).find((candidate) => candidate.id !== policy.id && candidate.bindings.some(match))?.name;
  const options = [
    ...(agents.data ?? []).filter((agent) => agent.status !== "revoked").map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.displayName}`, bound: policy.bindings.some((binding) => binding.agentId === agent.id), replaces: current((binding) => binding.agentId === agent.id) })),
    ...(treasuries.data ?? []).map((treasury) => ({ value: `treasury:${treasury.id}`, label: `Treasury · ${treasury.name}`, bound: policy.bindings.some((binding) => binding.treasuryAccountId === treasury.id), replaces: current((binding) => binding.treasuryAccountId === treasury.id) }))
  ].filter((option) => !option.bound);
  const chosen = target || options[0]?.value;

  async function submit() {
    if (!chosen) return;
    const [kind, id] = chosen.split(":");
    const result = await run("bind", () => api(`/v1/policies/${policy.id}/bindings`, { method: "POST", body: kind === "agent" ? { agentId: id } : { treasuryAccountId: id } }), "Policy bound");
    if (result) { invalidate("/v1/policies"); onClose(); }
  }

  return (
    <Modal title={`Bind ${policy.name}`} description="Each agent and treasury has one policy. An agent's policy applies to its requests; a treasury's policy covers people and agents without their own." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy !== null || !chosen} onClick={() => void submit()}>{busy ? "Binding…" : "Bind"}</button></>}>
      {options.length === 0 ? <Notice>Everything available is already bound to this policy.</Notice> : (
        <Field label="Apply to">
          <select className="select" value={chosen} onChange={(event) => setTarget(event.target.value)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}{option.replaces ? ` (replaces ${option.replaces})` : ""}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}
