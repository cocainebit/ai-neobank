"use client";

import { useEffect, useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, Empty, Field, LoadingRows, Modal, Notice, PageHead, Pill, Toggle, useAction } from "../../../components/ui";
import { useVerification, VerificationPanel } from "../../../components/verification-banner";
import { api, invalidate, useApi } from "../../../lib/api";
import { useAssets, useNetworks, usePrincipalNames, useSigners, useTreasuries } from "../../../lib/data";
import { networkLabel, sentence, shortAddress, type Tone } from "../../../lib/format";
import type { Asset, AuditEvent, Health } from "../../../lib/types";

const integrationNames: Record<string, string> = {
  evm: "EVM network", solana: "Solana network", directExecution: "Direct accounts", safe: "Safe multisig", squads: "Squads vaults",
  x402: "x402 payments", softwareSigners: "Sealed software keys", kmsSigners: "KMS-held keys"
};

function integrationState(value: string): { tone: Tone; label: string } {
  if (value.startsWith("rpc_reachable")) return { tone: "positive", label: `Connected, ${value.split(":").slice(1).join(":")}` };
  if (value.startsWith("rpc_unreachable")) return { tone: "negative", label: "Unreachable" };
  if (value === "not_configured" || value === "disabled") return { tone: "neutral", label: value === "disabled" ? "Disabled" : "Not configured" };
  if (value === "e2e_local") return { tone: "info", label: "Verified on local chains" };
  return { tone: "info", label: sentence(value) };
}

export default function SettingsPage() {
  const { session, can, reload } = useSession();
  const health = useApi<Health>("/health", { raw: true, refreshMs: 30_000 });
  const audit = useApi<AuditEvent[]>(can("owner", "auditor", "approver", "operator", "developer") ? "/v1/audit" : null, { refreshMs: 30_000 });
  const signers = useSigners();
  const treasuries = useTreasuries();
  const names = usePrincipalNames();
  // Verification is a state on the organization, so it is started and decided
  // here. The locked features link back to this page for exactly that reason.
  const verification = useVerification();
  const { busy, run } = useAction();
  const [name, setName] = useState(session.organization.name);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [limit, setLimit] = useState(25);
  useEffect(() => { setName(session.organization.name); }, [session.organization.name]);
  const owner = can("owner");

  const patch = (body: Record<string, unknown>, success: string) => run("patch", async () => {
    await api("/v1/organization", { method: "PATCH", body });
    await reload();
    invalidate();
  }, success);

  return (
    <>
      <PageHead title="Settings" description="Workspace controls, the keys Relay holds, what this server is connected to, and a record of every change." />
      <div className="grid-main">
        <div className="stack">
          <section className="panel">
            <header className="panel-head"><div><h2>Workspace</h2><p>Only owners can change these.</p></div></header>
            <div className="rows">
              <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 320px)" }}>
                <span className="cell-title"><b>Name</b><span>Shown to members, and to customers on invoices.</span></span>
                <form className="btn-row" style={{ flexWrap: "nowrap" }} onSubmit={(event) => { event.preventDefault(); void patch({ name: name.trim() }, "Name saved"); }}>
                  <input className="input" required maxLength={120} disabled={!owner} value={name} onChange={(event) => setName(event.target.value)} aria-label="Workspace name" />
                  <button className="btn" disabled={!owner || busy !== null || name.trim() === session.organization.name || !name.trim()}>Save</button>
                </form>
              </div>
              <div className="row">
                <span className="cell-title"><b>Autonomous execution</b><span style={{ whiteSpace: "normal" }}>When on, payments a policy authorizes without a person are signed and sent automatically. When off, they still wait for approval.</span></span>
                <Toggle label="Autonomous execution" disabled={!owner || busy !== null} checked={session.organization.autonomousExecution} onChange={(value) => void patch({ autonomousExecution: value }, value ? "Autonomous execution on" : "Autonomous execution off")} />
              </div>
              <div className="row">
                <span className="cell-title"><b>{session.organization.frozen ? "Workspace is frozen" : "Freeze workspace"}</b><span style={{ whiteSpace: "normal" }}>{session.organization.frozen ? "No payment can be requested, approved, or signed. Payments already broadcast still settle." : "Stops every payment at once: nothing new is requested, approved, or signed until an owner unfreezes."}</span></span>
                {session.organization.frozen
                  ? <button className="btn" disabled={!owner || busy !== null} onClick={() => void patch({ frozen: false }, "Workspace unfrozen")}>Unfreeze</button>
                  : <button className="btn danger" disabled={!owner || busy !== null} onClick={() => setConfirmFreeze(true)}><Icons.Freeze />Freeze</button>}
              </div>
            </div>
          </section>

          <VerificationPanel verification={verification} />

          <section className="panel">
            <header className="panel-head"><div><h2>Activity log</h2><p>Append-only record of changes to money, people, keys, and rules</p></div></header>
            {audit.loading && !audit.data ? <LoadingRows rows={6} /> : (audit.data ?? []).length === 0 ? <Empty title="Nothing recorded yet">Changes appear here as they happen.</Empty> : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
                    <tbody>
                      {(audit.data ?? []).slice(0, limit).map((event) => (
                        <tr key={event.id}>
                          <td><Ago iso={event.createdAt} /></td>
                          <td>{event.actorPrincipalId ? names.get(event.actorPrincipalId)?.name ?? <span className="faint">Former member</span> : <span className="faint">Relay</span>}</td>
                          <td className="primary">{sentence(event.action.replaceAll(".", " "))}</td>
                          <td><span className="truncate" style={{ display: "block", maxWidth: 280 }} title={JSON.stringify(event.data)}>{describe(event)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(audit.data ?? []).length > limit && <div className="panel-body" style={{ borderTop: "1px solid var(--line-soft)", padding: "10px 18px" }}><button className="btn small ghost" onClick={() => setLimit((current) => current + 50)}>Show more</button></div>}
              </>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <header className="panel-head"><div><h2>Connections</h2><p>{health.data ? `API ${health.data.environment}, database ${health.data.database}` : "Checking the API"}</p></div></header>
            {!health.data ? <LoadingRows rows={5} /> : (
              <div className="rows">
                {Object.entries(health.data.integrations).map(([key, value]) => {
                  const state = integrationState(value);
                  return (
                    <div key={key} className="row" style={{ padding: "10px 18px", minHeight: 0 }}>
                      <span style={{ fontSize: 13.5 }}>{integrationNames[key] ?? sentence(key)}</span>
                      <Pill tone={state.tone}>{state.label}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <Assets />

          <section className="panel">
            <header className="panel-head"><div><h2>Relay-held keys</h2><p>Executors submit transactions and pay fees. On a Safe or Squads treasury they cannot move money alone.</p></div></header>
            {signers.loading && !signers.data ? <LoadingRows rows={3} /> : (signers.data ?? []).length === 0 ? <Empty title="No keys">Relay creates an executor key when you add a treasury.</Empty> : (
              <div className="rows">
                {(signers.data ?? []).map((signer) => {
                  const uses = (treasuries.data ?? []).filter((treasury) => treasury.executorSignerId === signer.id || (treasury.governance === "direct" && treasury.address.toLowerCase() === signer.address.toLowerCase()));
                  return (
                    <div key={signer.id} className="row" style={{ padding: "11px 18px" }}>
                      <span className="cell-title">
                        <b style={{ fontWeight: 500 }} className="address">{shortAddress(signer.address, 8, 6)}</b>
                        <span>{signer.custody === "kms" ? "Held in KMS" : signer.custody === "encrypted_software" ? "Sealed software key" : "External wallet"} · {uses.length ? uses.map((treasury) => treasury.name).join(", ") : "Not in use"}</span>
                      </span>
                      <Pill tone={signer.status === "active" ? "positive" : signer.status === "frozen" ? "pending" : "negative"}>{sentence(signer.status)}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {confirmFreeze && (
        <Modal title="Freeze the workspace?" description="Every payment stops before its next step. Unfreezing takes one click from this page." onClose={() => setConfirmFreeze(false)}
          footer={<><button className="btn" onClick={() => setConfirmFreeze(false)}>Cancel</button><button className="btn primary" disabled={busy !== null} onClick={() => { setConfirmFreeze(false); void patch({ frozen: true }, "Workspace frozen"); }}>Freeze now</button></>}>
          <Notice tone="pending">Transactions already broadcast cannot be recalled; they settle normally. Recurring payments are not created while frozen.</Notice>
        </Modal>
      )}
    </>
  );
}

function describe(event: AuditEvent): string {
  const data = event.data;
  const pick = (key: string) => typeof data[key] === "string" || typeof data[key] === "number" || typeof data[key] === "boolean" ? String(data[key]) : null;
  const parts = [pick("name"), pick("displayName"), pick("status"), pick("role"), pick("number"), pick("version") && `version ${pick("version")}`, pick("decision"), pick("address") && shortAddress(pick("address")!)].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return `${sentence(event.resourceType.replaceAll("_", " "))} ${event.resourceId.slice(0, 8)}`;
}

/** Tokens this workspace can hold, invoice in, and pay with. Native coins are always known. */
function Assets() {
  const { session, can } = useSession();
  const assets = useAssets();
  const networks = useNetworks();
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const local = networks.data?.environment === "development" && (networks.data.evm?.local || networks.data.solana?.local);
  const tokens = (assets.data ?? []).filter((asset) => asset.kind !== "native");

  return (
    <section className="panel">
      <header className="panel-head">
        <div><h2>Assets</h2><p>Tokens are registered per network by contract address</p></div>
        {can("owner") && <button className="btn small" onClick={() => setAdding(true)}><Icons.Plus />Add token</button>}
      </header>
      {assets.loading && !assets.data ? <LoadingRows rows={2} /> : (
        <div className="rows">
          {(assets.data ?? []).map((asset) => (
            <div key={asset.id} className="row" style={{ padding: "11px 18px" }}>
              <span className="cell-title">
                <b style={{ fontWeight: 550 }}>{asset.symbol} <span className="faint" style={{ fontWeight: 400 }}>{networkLabel(asset.network)}</span></b>
                <span className="address">{asset.address ? shortAddress(asset.address, 10, 8) : `Native coin · ${asset.decimals} decimals`}</span>
              </span>
              {local && asset.kind === "erc20" && session.wallet?.chainFamily === "evm" && (
                <button className="btn small ghost" disabled={busy !== null} title="Sends 1,000 test tokens to your wallet on the local chain"
                  onClick={() => void run(`fund-${asset.id}`, async () => { await api("/v1/dev/fund", { method: "POST", body: { chainFamily: "evm", address: session.wallet!.address, assetId: asset.id } }); }, `Sent 1,000 ${asset.symbol} to your wallet`)}>
                  <Icons.Plus />Local faucet
                </button>
              )}
            </div>
          ))}
          {tokens.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>No tokens registered. EVM invoices need a token; native coins cannot be attributed to an invoice.</span></div>}
        </div>
      )}
      {adding && <AddToken onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddToken({ onClose }: { onClose(): void }) {
  const networks = useNetworks();
  const { busy, run } = useAction();
  const options = [networks.data?.evm && { network: networks.data.evm.network, kind: "erc20" as const }, networks.data?.solana && { network: networks.data.solana.network, kind: "spl" as const }].filter(Boolean) as { network: string; kind: "erc20" | "spl" }[];
  const [network, setNetwork] = useState("");
  const chosen = options.find((option) => option.network === network) ?? options[0];
  const [address, setAddress] = useState("");
  const [symbol, setSymbol] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    const result = await run("add", () => api<{ data: Asset }>("/v1/assets", { method: "POST", body: { network: chosen.network, kind: chosen.kind, address: address.trim(), symbol: symbol.trim().toUpperCase() } }), "Token registered");
    if (result) { invalidate("/v1/assets"); onClose(); }
  }

  return (
    <Modal title="Add a token" description="Relay reads the token's decimals from the chain, so amounts are exact." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-token" disabled={busy !== null || !chosen}>{busy ? "Checking the chain…" : "Add token"}</button></>}>
      {options.length === 0 ? <Notice tone="negative">The API is not connected to any network.</Notice> : (
        <form id="add-token" className="form-grid" onSubmit={(event) => void submit(event)}>
          <Field label="Network" className="span-2">
            <select className="select" value={chosen?.network ?? ""} onChange={(event) => setNetwork(event.target.value)}>
              {options.map((option) => <option key={option.network} value={option.network}>{networkLabel(option.network)}</option>)}
            </select>
          </Field>
          <Field label="Contract address" className="span-2"><input className="input address" required value={address} onChange={(event) => setAddress(event.target.value)} placeholder={chosen?.kind === "erc20" ? "0x…" : "Mint address"} /></Field>
          <Field label="Symbol" className="span-2" hint="Shown in Relay. The chain decides the decimals."><input className="input" required maxLength={16} value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="USDC" /></Field>
        </form>
      )}
    </Modal>
  );
}
