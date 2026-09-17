"use client";

import { useState } from "react";
import { AddTreasury, FundButton } from "../../../components/add-treasury";
import { Icons } from "../../../components/icons";
import { NewPayment } from "../../../components/new-payment";
import { useSession } from "../../../components/session";
import { BalanceList } from "../../../components/treasury-balances";
import { Ago, CopyField, Empty, LoadingRows, Modal, Notice, PageHead, Pill, useAction } from "../../../components/ui";
import { api, invalidate, useApi } from "../../../lib/api";
import { governanceLabel, useMembers, useSigners, useTreasuries } from "../../../lib/data";
import { networkLabel, sentence, shortAddress } from "../../../lib/format";
import type { Reconciliation, Rotation, Treasury } from "../../../lib/types";

export default function TreasuriesPage() {
  const { can } = useSession();
  const treasuries = useTreasuries();
  const reconciliations = useApi<Reconciliation[]>("/v1/reconciliation", { refreshMs: 20_000 });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [rotating, setRotating] = useState<Treasury | null>(null);

  return (
    <>
      <PageHead title="Treasuries" description="Accounts money moves from. Balances are read from chain; the ledger is reconciled against them after every sync."
        actions={can("owner") ? <button className="btn primary" onClick={() => setAdding(true)}><Icons.Plus />Add treasury</button> : undefined} />
      {(treasuries.data ?? []).length > 0 && <TreasurySummary treasuries={treasuries.data ?? []} reconciliations={reconciliations.data ?? []} />}
      {treasuries.loading && !treasuries.data ? <section className="panel"><LoadingRows rows={4} /></section> : (treasuries.data ?? []).length === 0 ? (
        <section className="panel">
          <Empty title="No treasuries yet" action={can("owner") ? <button className="btn" onClick={() => setAdding(true)}><Icons.Plus />Add a treasury</button> : undefined}>
            Deploy a Safe or create a Squads vault from your wallet, connect one you already own, or on a local chain use a development account.
          </Empty>
        </section>
      ) : (
        <div className="grid-2">
          {(treasuries.data ?? []).map((treasury) => (
            <TreasuryCard key={treasury.id} treasury={treasury} reconciliations={reconciliations.data ?? []} onPay={() => setPaying(treasury.id)} onRotate={() => setRotating(treasury)} />
          ))}
        </div>
      )}
      {adding && <AddTreasury onClose={() => setAdding(false)} onCreated={() => setAdding(false)} />}
      {paying && <NewPayment defaultTreasuryId={paying} onClose={() => setPaying(null)} />}
      {rotating && <RotateExecutor treasury={rotating} onClose={() => setRotating(null)} />}
    </>
  );
}

function TreasurySummary({ treasuries, reconciliations }: { treasuries: Treasury[]; reconciliations: Reconciliation[] }) {
  const networks = new Set(treasuries.map((treasury) => treasury.network));
  const governed = treasuries.filter((treasury) => treasury.governance !== "direct").length;
  const matched = reconciliations.filter((entry) => entry.status === "matched").length;
  const breaks = reconciliations.filter((entry) => entry.status === "break").length;
  const latest = reconciliations.map((entry) => entry.createdAt).sort().at(-1);
  return (
    <section className="panel milled" style={{ marginBottom: 16 }}>
      <div className="stat-strip" style={{ ["--stats" as string]: 4 }}>
        <div><span className="eyebrow">Treasuries</span><div className="value">{treasuries.length}</div><div className="sub">{governed} multisig, {treasuries.length - governed} direct</div></div>
        <div><span className="eyebrow">Networks</span><div className="value">{networks.size}</div><div className="sub truncate">{[...networks].map(networkLabel).join(", ")}</div></div>
        <div><span className="eyebrow">Reconciled</span><div className="value">{matched}</div><div className="sub">{breaks ? <span className="negative">{breaks} with a difference</span> : reconciliations.length ? "Every balance matches the ledger" : "Waiting for the first sync"}</div></div>
        <div><span className="eyebrow">Last sync</span><div className="value" style={{ fontSize: 20, marginTop: 14 }}>{latest ? <Ago iso={latest} /> : "Not yet"}</div><div className="sub">The worker syncs every 15 seconds</div></div>
      </div>
    </section>
  );
}

function TreasuryCard({ treasury, reconciliations, onPay, onRotate }: { treasury: Treasury; reconciliations: Reconciliation[]; onPay(): void; onRotate(): void }) {
  const { can, session } = useSession();
  const signers = useSigners();
  const members = useMembers();
  const { busy, run } = useAction();
  const executor = signers.data?.find((signer) => signer.id === treasury.executorSignerId);
  const ownerName = (address: string) => session.wallet?.address.toLowerCase() === address.toLowerCase() ? "You" : members.data?.find((member) => member.wallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase()))?.displayName;
  const configuration = treasury.observedConfiguration;
  const voters = treasury.governance === "safe" ? configuration.owners ?? [] : (configuration.members ?? []).filter((member) => member.canVote).map((member) => member.key);
  const frozen = treasury.status === "frozen";

  return (
    <section className="panel milled">
      <header className="panel-head" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
          <span className="icon-tile">{treasury.chainFamily === "evm" ? <Icons.Ethereum /> : <Icons.Solana />}</span>
          <div style={{ minWidth: 0 }}>
            <h2 className="truncate">{treasury.name}</h2>
            <p>{governanceLabel[treasury.governance]} · {networkLabel(treasury.network)}</p>
          </div>
        </div>
        <Pill tone={frozen ? "negative" : "positive"}>{frozen ? "Frozen" : "Active"}</Pill>
      </header>
      <div className="panel-body" style={{ display: "grid", gap: 16 }}>
        <CopyField value={treasury.address} label={shortAddress(treasury.address, 12, 10)} />
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Balances</div>
          <BalanceList treasury={treasury} reconciliations={reconciliations} />
        </div>
        {treasury.governance !== "direct" && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>{treasury.governance === "safe" ? "Owners" : "Voting members"} · {configuration.threshold ?? "?"} of {voters.length} to approve</div>
            <div className="rows panel" style={{ background: "var(--panel-2)" }}>
              {voters.map((address) => (
                <div key={address} className="row" style={{ padding: "9px 12px", minHeight: 0 }}>
                  <span className="truncate">{ownerName(address) ?? <span className="faint">Not a member here</span>}</span>
                  <span className="address faint" style={{ fontSize: 12.5 }}>{shortAddress(address)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {treasury.governance !== "direct" && (
          <div style={{ display: "grid", gap: 6 }}>
            <div className="eyebrow">Relay executor</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 13.5 }}>
              <span className="dim">{executor ? <><span className="address">{shortAddress(executor.address)}</span> · {executor.custody === "kms" ? "Held in KMS" : "Sealed key"}</> : "Loading"}</span>
              <span className="faint" style={{ fontSize: 12.5 }}>{treasury.governance === "safe" ? "Submits owner-signed transactions" : "Proposes and executes, never votes"}</span>
            </div>
            {executor && <span className="faint" style={{ fontSize: 12.5 }}>The executor pays network fees from its own balance.</span>}
          </div>
        )}
        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          {can("owner", "operator") && <button className="btn small" onClick={onPay} disabled={frozen}><Icons.Out />Pay</button>}
          <FundButton address={treasury.address} chainFamily={treasury.chainFamily} label="Fund treasury" />
          {executor && <FundButton address={executor.address} chainFamily={treasury.chainFamily} label="Fund executor" />}
          {can("owner", "operator") && <button className="btn small ghost" disabled={busy !== null} onClick={() => void run("sync", async () => { await api(`/v1/treasuries/${treasury.id}/sync`, { method: "POST", body: {} }); }, "Sync queued")}><Icons.Refresh />Sync</button>}
          {can("owner") && treasury.governance !== "direct" && <button className="btn small ghost" onClick={onRotate}><Icons.Key />Rotate executor</button>}
          {can("owner") && (
            <button className={`btn small ghost ${frozen ? "" : "danger"}`} style={{ marginLeft: "auto" }} disabled={busy !== null}
              onClick={() => void run("freeze", async () => { await api(`/v1/treasuries/${treasury.id}/status`, { method: "PATCH", body: { status: frozen ? "active" : "frozen" } }); invalidate("/v1/treasuries"); }, frozen ? "Treasury unfrozen" : "Treasury frozen")}>
              <Icons.Freeze />{frozen ? "Unfreeze" : "Freeze"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function RotateExecutor({ treasury, onClose }: { treasury: Treasury; onClose(): void }) {
  const rotations = useApi<Rotation[]>(`/v1/treasuries/${treasury.id}/executor-rotations`, { refreshMs: 5_000 });
  const { busy, run } = useAction();
  const latest = rotations.data?.[0];
  const open = latest && ["publishing", "approval_required", "executing"].includes(latest.status);

  async function start() {
    await run("rotate", async () => {
      const signer = (await api<{ data: { id: string } }>("/v1/signers", { method: "POST", body: { chainFamily: treasury.chainFamily } })).data;
      await api(`/v1/treasuries/${treasury.id}/executor-rotations`, { method: "POST", body: { signerId: signer.id } });
      invalidate(`/v1/treasuries`);
    }, treasury.governance === "safe" ? "Executor replaced" : "Rotation proposed on chain");
  }

  return (
    <Modal title="Rotate executor" description={treasury.governance === "safe" ? "A Safe's executor is not an owner, so replacing it changes nothing on chain." : "The current executor proposes swapping itself for a new key. Voting members approve it on chain."} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={busy !== null || Boolean(open)} onClick={() => void start()}>{busy ? "Working…" : "Create new executor"}</button></>}>
      <Notice>Rotation is refused while payments are in flight on this treasury. {treasury.governance === "squads" ? "A config change makes earlier Squads proposals stale." : ""}</Notice>
      {rotations.loading && !rotations.data ? <LoadingRows rows={2} /> : (rotations.data ?? []).length === 0 ? <p className="dim" style={{ margin: 0 }}>No rotations yet.</p> : (
        <div className="panel"><div className="rows">
          {(rotations.data ?? []).map((rotation) => (
            <div key={rotation.id} className="row">
              <span className="cell-title"><b>{sentence(rotation.status)}</b><span>{rotation.failureReason ?? (rotation.status === "approval_required" ? "Members vote with their wallets, for example from the Squads app" : new Date(rotation.createdAt).toLocaleString())}</span></span>
              <Pill tone={rotation.status === "completed" ? "positive" : rotation.status === "failed" || rotation.status === "rejected" ? "negative" : "pending"}>{sentence(rotation.status)}</Pill>
            </div>
          ))}
        </div></div>
      )}
    </Modal>
  );
}
