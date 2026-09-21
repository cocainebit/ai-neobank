"use client";

import Link from "next/link";
import { useState } from "react";
import { CreateVault } from "../../../components/create-vault";
import { formatDuration, GovernanceControls, observedConfig, voterAddresses } from "../../../components/governance-controls";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, Empty, ErrorState, LoadingRows, PageHead, Pill } from "../../../components/ui";
import { governanceLabel, useIntents, useTreasuries } from "../../../lib/data";
import { networkLabel, shortAddress } from "../../../lib/format";
import type { Intent, Treasury } from "../../../lib/types";

export default function VaultsPage() {
  const { can } = useSession();
  const treasuries = useTreasuries();
  const intents = useIntents();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Treasury | null>(null);

  const all = treasuries.data ?? [];
  const vaults = all.filter((treasury) => treasury.governance !== "direct");
  const direct = all.length - vaults.length;
  const waiting = (intents.data ?? []).filter((intent) => ["approval_required", "approved", "executing", "submitted"].includes(intent.status));

  const createButton = can("owner")
    ? <button className="btn primary" onClick={() => setCreating(true)}><Icons.Plus />Create a vault</button>
    : undefined;

  return (
    <>
      <PageHead
        title="Vaults"
        description="The multisigs that hold your money. Your wallet owns them; Relay can propose and submit, and never approves."
        actions={createButton}
      />

      {vaults.length > 0 && <VaultSummary vaults={vaults} waiting={waiting} />}

      {treasuries.error ? <section className="panel"><ErrorState error={treasuries.error} retry={() => void treasuries.reload()} /></section>
        : treasuries.loading && !treasuries.data ? <section className="panel"><LoadingRows rows={4} /></section>
        : vaults.length === 0 ? (
          <section className="panel">
            <Empty title="No vaults yet" action={createButton}>
              A vault is a Safe on an EVM chain or a Squads vault on Solana. You deploy it from your own wallet, choose who can approve, and decide how long an approved payment waits before it can move.
            </Empty>
          </section>
        ) : (
          <div className="grid-2">
            {vaults.map((vault) => (
              <VaultCard
                key={vault.id}
                vault={vault}
                waiting={waiting.filter((intent) => intent.treasuryAccountId === vault.id).length}
                onOpen={() => setOpen(vault)}
              />
            ))}
          </div>
        )}

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-body" style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <span className="dim" style={{ fontSize: 13.5 }}>
            Balances, payments, and reconciliation for every account, vaults included, live in <Link href="/treasuries" style={{ textDecoration: "underline" }}>Treasuries</Link>.
            {direct > 0 ? ` ${direct} account${direct === 1 ? " is" : "s are"} a single key rather than a vault.` : ""}
          </span>
        </div>
      </section>

      {creating && <CreateVault onClose={() => setCreating(false)} onCreated={(treasury) => { setCreating(false); setOpen(treasury); }} />}
      {open && <GovernanceControls treasury={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function VaultSummary({ vaults, waiting }: { vaults: Treasury[]; waiting: Intent[] }) {
  const ids = new Set(vaults.map((vault) => vault.id));
  const delayed = vaults.filter((vault) => (observedConfig(vault).timeLock ?? 0) > 0);
  const longest = Math.max(0, ...delayed.map((vault) => observedConfig(vault).timeLock ?? 0));
  const signers = new Set(vaults.flatMap((vault) => voterAddresses(vault).map((address) => address.toLowerCase())));
  const pending = waiting.filter((intent) => ids.has(intent.treasuryAccountId)).length;

  return (
    <section className="panel milled" style={{ marginBottom: 16 }}>
      <div className="stat-strip" style={{ ["--stats" as string]: 4 }}>
        <div>
          <span className="eyebrow">Vaults</span>
          <div className="value">{vaults.length}</div>
          <div className="sub">{vaults.filter((vault) => vault.governance === "safe").length} Safe, {vaults.filter((vault) => vault.governance === "squads").length} Squads</div>
        </div>
        <div>
          <span className="eyebrow">People who can approve</span>
          <div className="value">{signers.size}</div>
          <div className="sub">Distinct wallets across every vault</div>
        </div>
        <div>
          <span className="eyebrow">Time locks</span>
          <div className="value">{delayed.length}</div>
          <div className="sub">{delayed.length === 0 ? "No vault makes a payment wait" : `Longest is ${formatDuration(longest)}`}</div>
        </div>
        <div>
          <span className="eyebrow">Waiting</span>
          <div className="value">{pending}</div>
          <div className="sub">{pending === 0 ? "Nothing is mid-flight" : "Payments awaiting an approval, a delay, or a signature"}</div>
        </div>
      </div>
    </section>
  );
}

function VaultCard({ vault, waiting, onOpen }: { vault: Treasury; waiting: number; onOpen(): void }) {
  const configuration = observedConfig(vault);
  const voters = voterAddresses(vault);
  const timeLock = vault.governance === "squads" ? configuration.timeLock ?? 0 : 0;
  const frozen = vault.status === "frozen";
  const unread = voters.length === 0;

  return (
    <section className="panel milled">
      <header className="panel-head" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
          <span className="icon-tile">{vault.chainFamily === "evm" ? <Icons.Ethereum /> : <Icons.Solana />}</span>
          <div style={{ minWidth: 0 }}>
            <h2 className="truncate">{vault.name}</h2>
            <p>{governanceLabel[vault.governance]} · {networkLabel(vault.network)}</p>
          </div>
        </div>
        <Pill tone={frozen ? "negative" : "positive"}>{frozen ? "Frozen" : "Active"}</Pill>
      </header>
      <div className="panel-body" style={{ display: "grid", gap: 14 }}>
        <span className="address faint" style={{ fontSize: 12.5 }}>{shortAddress(vault.address, 14, 10)}</span>
        <dl className="kv">
          <dt>Approvals</dt>
          <dd>{unread ? <span className="faint">Not read from the chain yet</span> : <>{configuration.threshold ?? "?"} of {voters.length} {vault.governance === "safe" ? "owners" : "voting members"}</>}</dd>
          <dt>Time lock</dt>
          <dd>{vault.governance === "squads" ? (timeLock > 0 ? formatDuration(timeLock) : "No delay") : "Not part of a Safe"}</dd>
          {configuration.observedAt && <><dt>Last read</dt><dd><Ago iso={configuration.observedAt} /></dd></>}
        </dl>
        <div className="btn-row" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
          <button className="btn small" onClick={onOpen}><Icons.Policy />Governance</button>
          {waiting > 0 && <Pill tone="pending">{waiting} waiting</Pill>}
        </div>
      </div>
    </section>
  );
}
