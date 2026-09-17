"use client";

import { useMemo, useState } from "react";
import { api, ApiError, invalidate } from "../lib/api";
import { useMembers, useNetworks } from "../lib/data";
import { networkLabel, shortAddress } from "../lib/format";
import { sessionWallet, waitForConfirmation } from "../lib/sign";
import type { Signer, Treasury } from "../lib/types";
import { sendEvmTransaction, signSolanaTransaction } from "../lib/wallet";
import { Icons } from "./icons";
import { useSession } from "./session";
import { Field, Modal, Notice, useAction } from "./ui";

type Kind = "direct" | "safe" | "squads" | "existing";

const kinds: { key: Kind; title: string; body: string; family?: "evm" | "svm" }[] = [
  { key: "safe", title: "New Safe", body: "Deploy a multisig on EVM. Owners sign; Relay's executor only submits what they approved.", family: "evm" },
  { key: "squads", title: "New Squads vault", body: "Create a multisig on Solana. Members vote on chain; Relay's executor cannot vote.", family: "svm" },
  { key: "existing", title: "Connect existing", body: "Register a Safe or Squads multisig you already own. Relay verifies it on chain." },
  { key: "direct", title: "Development account", body: "A single-key account whose key Relay holds. For local and test networks only." }
];

async function createExecutor(chainFamily: "evm" | "svm"): Promise<Signer> {
  const result = await api<{ data: Signer }>("/v1/signers", { method: "POST", body: { chainFamily } });
  return result.data;
}

async function registerWithRetry(body: Record<string, unknown>, attempts = 30): Promise<Treasury> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await api<{ data: Treasury }>("/v1/treasuries", { method: "POST", body })).data;
    } catch (error) {
      const notYetVisible = error instanceof ApiError && ["safe_not_found_on_chain", "multisig_not_found_on_chain"].includes(error.code);
      if (!notYetVisible || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function AddTreasury({ onClose, onCreated }: { onClose(): void; onCreated(treasury: Treasury): void }) {
  const { session } = useSession();
  const networks = useNetworks();
  const members = useMembers();
  const { busy, run } = useAction();
  const [kind, setKind] = useState<Kind>("safe");
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [family, setFamily] = useState<"evm" | "svm">(session.wallet?.chainFamily ?? "evm");
  const [existingGovernance, setExistingGovernance] = useState<"safe" | "squads">("safe");
  const [address, setAddress] = useState("");
  const [multisigPda, setMultisigPda] = useState("");
  const [progress, setProgress] = useState<string | null>(null);

  const chosenFamily: "evm" | "svm" = kind === "safe" ? "evm" : kind === "squads" ? "svm" : kind === "existing" ? (existingGovernance === "safe" ? "evm" : "svm") : family;
  const network = chosenFamily === "evm" ? networks.data?.evm?.network : networks.data?.solana?.network;
  const owners = useMemo(() => (members.data ?? []).filter((member) => member.status === "active" && ["owner", "approver"].includes(member.role)).flatMap((member) => member.wallets.filter((wallet) => wallet.chainFamily === chosenFamily).map((wallet) => ({ name: member.displayName, address: wallet.address }))), [members.data, chosenFamily]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const chosenOwners = owners.filter((owner) => !excluded.has(owner.address));
  const mustSignFrom = session.wallet?.chainFamily === chosenFamily;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!network) return;
    const label = name.trim() || (kind === "direct" ? "Development account" : kind === "squads" ? "Squads vault" : "Safe");
    const created = await run("create", async () => {
      if (kind === "direct") {
        setProgress("Creating a key sealed under the server's keyring");
        const signer = await createExecutor(chosenFamily);
        return (await api<{ data: Treasury }>("/v1/treasuries", { method: "POST", body: { name: label, chainFamily: chosenFamily, network, address: signer.address, governance: "direct" } })).data;
      }
      if (kind === "existing") {
        setProgress("Creating an executor key for Relay");
        const executor = await createExecutor(chosenFamily);
        setProgress("Verifying the multisig on chain");
        return registerWithRetry({ name: label, chainFamily: chosenFamily, network, address: address.trim(), governance: existingGovernance, executorSignerId: executor.id, ...(existingGovernance === "squads" ? { multisigPda: multisigPda.trim() } : {}) }, 0);
      }
      if (!mustSignFrom) throw new Error(`Sign in with a ${chosenFamily === "evm" ? "Ethereum" : "Solana"} wallet to create this. It becomes an owner and pays the deployment.`);
      const wallet = await sessionWallet(session);
      setProgress("Creating an executor key for Relay");
      const executor = await createExecutor(chosenFamily);
      setProgress("Preparing the deployment");
      const prepared = await api<{ data: { predictedAddress?: string; transaction?: { to: string; data: string; value: string }; multisigPda?: string; vaultPda?: string; transactionBase64?: string } }>("/v1/treasuries/prepare", {
        method: "POST", body: { governance: kind, network, owners: chosenOwners.map((owner) => owner.address), threshold, executorSignerId: executor.id }
      });
      if (kind === "safe") {
        setProgress("Confirm the deployment in your wallet");
        const hash = await sendEvmTransaction(wallet.address, prepared.data.transaction!);
        setProgress("Waiting for the deployment to confirm");
        await waitForConfirmation("evm", hash);
        setProgress("Verifying owners and threshold on chain");
        return registerWithRetry({ name: label, chainFamily: "evm", network, address: prepared.data.predictedAddress, governance: "safe", executorSignerId: executor.id });
      }
      setProgress("Sign the vault creation in your wallet");
      const signed = await signSolanaTransaction(prepared.data.transactionBase64!);
      const relayed = await api<{ data: { signature: string } }>("/v1/relay/solana", { method: "POST", body: { transactionBase64: signed } });
      setProgress("Waiting for the vault to confirm");
      await waitForConfirmation("solana", relayed.data.signature);
      setProgress("Verifying members and threshold on chain");
      return registerWithRetry({ name: label, chainFamily: "svm", network, address: prepared.data.vaultPda, governance: "squads", executorSignerId: executor.id, multisigPda: prepared.data.multisigPda });
    }, "Treasury added");
    setProgress(null);
    if (created) { invalidate("/v1/treasuries"); invalidate("/v1/signers"); onCreated(created); }
  }

  const unavailable = !network ? `The API is not connected to a ${chosenFamily === "evm" ? "EVM" : "Solana"} network.` : null;
  const ownerProblem = (kind === "safe" || kind === "squads") && (chosenOwners.length === 0 ? `No ${chosenFamily === "evm" ? "Ethereum" : "Solana"} wallets among owners and approvers. Add members with ${chosenFamily === "evm" ? "EVM" : "Solana"} wallets first.` : threshold > chosenOwners.length ? "Threshold is higher than the number of owners." : null);

  return (
    <Modal wide title="Add a treasury" description="Money moves from treasuries. Choose who controls this one." onClose={onClose}
      footer={<>
        {progress && <span className="dim" style={{ marginRight: "auto", fontSize: 13, alignSelf: "center" }}>{progress}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" form="add-treasury" disabled={busy !== null || Boolean(unavailable) || Boolean(ownerProblem)}>{busy ? "Working…" : kind === "existing" ? "Verify and add" : kind === "direct" ? "Create account" : "Create and deploy"}</button>
      </>}>
      <div className="grid-2" style={{ gap: 10 }}>
        {kinds.map((option) => (
          <button key={option.key} type="button" className="wallet-option" style={{ gridTemplateColumns: "minmax(0, 1fr)", borderColor: kind === option.key ? "var(--text)" : undefined }} aria-pressed={kind === option.key} onClick={() => setKind(option.key)}>
            <span><b style={{ display: "block", fontWeight: 600 }}>{option.title}</b><span className="faint" style={{ fontSize: 12.5 }}>{option.body}</span></span>
          </button>
        ))}
      </div>
      <form id="add-treasury" className="form-grid" onSubmit={(event) => void submit(event)}>
        <Field label="Name" className="span-2"><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Operating account" maxLength={80} /></Field>
        {kind === "direct" && (
          <Field label="Chain" className="span-2">
            <div className="segmented"><button type="button" aria-pressed={family === "evm"} onClick={() => setFamily("evm")}>EVM</button><button type="button" aria-pressed={family === "svm"} onClick={() => setFamily("svm")}>Solana</button></div>
          </Field>
        )}
        {kind === "existing" && (
          <>
            <Field label="Kind" className="span-2">
              <div className="segmented"><button type="button" aria-pressed={existingGovernance === "safe"} onClick={() => setExistingGovernance("safe")}>Safe</button><button type="button" aria-pressed={existingGovernance === "squads"} onClick={() => setExistingGovernance("squads")}>Squads</button></div>
            </Field>
            {existingGovernance === "squads" && <Field label="Multisig account" className="span-2"><input className="input address" required value={multisigPda} onChange={(event) => setMultisigPda(event.target.value)} placeholder="Squads multisig address" /></Field>}
            <Field label={existingGovernance === "safe" ? "Safe address" : "Vault address (index 0)"} className="span-2"><input className="input address" required value={address} onChange={(event) => setAddress(event.target.value)} placeholder={existingGovernance === "safe" ? "0x…" : "Vault address"} /></Field>
            <div className="span-2"><Notice>Relay creates an executor key. {existingGovernance === "safe" ? "It must not be an owner; Safe owners keep signing." : "Add it to the multisig as a member with Initiate and Execute permissions only, then register. It must not be able to vote."}</Notice></div>
          </>
        )}
        {(kind === "safe" || kind === "squads") && (
          <>
            <div className="field span-2">
              <span>Owners</span>
              <div className="panel"><div className="rows">
                {owners.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>No owners or approvers with {chosenFamily === "evm" ? "EVM" : "Solana"} wallets yet.</span></div>}
                {owners.map((owner) => (
                  <label key={owner.address} className="row" style={{ cursor: "pointer" }}>
                    <span className="cell-title"><b>{owner.name}</b><span className="address">{shortAddress(owner.address, 10, 8)}</span></span>
                    <input type="checkbox" checked={!excluded.has(owner.address)} onChange={(event) => setExcluded((current) => { const next = new Set(current); if (event.target.checked) next.delete(owner.address); else next.add(owner.address); return next; })} />
                  </label>
                ))}
              </div></div>
              <small>Owners come from members with the owner or approver role. Add teammates in Members first.</small>
            </div>
            <Field label="Approvals required" hint={`Out of ${chosenOwners.length} owner${chosenOwners.length === 1 ? "" : "s"}. Enforced on chain.`}>
              <input className="input num" type="number" min={1} max={Math.max(chosenOwners.length, 1)} value={threshold} onChange={(event) => setThreshold(Math.max(1, Number(event.target.value)))} />
            </Field>
            <Field label="Network"><input className="input" readOnly value={network ? networkLabel(network) : "Not connected"} /></Field>
          </>
        )}
        {unavailable && <div className="span-2"><Notice tone="negative">{unavailable}</Notice></div>}
        {ownerProblem && <div className="span-2"><Notice tone="pending">{ownerProblem}</Notice></div>}
        {(kind === "safe" || kind === "squads") && mustSignFrom && session.wallet && (
          <div className="span-2" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span className="faint" style={{ fontSize: 12.5 }}>Your wallet <span className="address">{shortAddress(session.wallet.address)}</span> pays for the {kind === "safe" ? "deployment" : "vault account"}.</span>
            <FundButton address={session.wallet.address} chainFamily={chosenFamily} />
          </div>
        )}
        {(kind === "safe" || kind === "squads") && !mustSignFrom && <div className="span-2"><Notice tone="pending">You are signed in with a {session.wallet?.chainFamily === "evm" ? "Ethereum" : "Solana"} wallet. Creating a {kind === "safe" ? "Safe" : "Squads vault"} needs a {chosenFamily === "evm" ? "Ethereum" : "Solana"} wallet to sign and pay for it.</Notice></div>}
        {kind === "direct" && <div className="span-2"><Notice tone="pending"><b>Development custody.</b> Relay holds this key, sealed under the server keyring. Production servers refuse this unless keys are KMS-wrapped; use a Safe or Squads vault for real funds.</Notice></div>}
      </form>
    </Modal>
  );
}

export function FundButton({ address, chainFamily, label = "Local faucet" }: { address: string; chainFamily: "evm" | "svm"; label?: string }) {
  const networks = useNetworks();
  const { busy, run } = useAction();
  const local = chainFamily === "evm" ? networks.data?.evm?.local : networks.data?.solana?.local;
  if (!local || networks.data?.environment !== "development") return null;
  return (
    <button className="btn small" disabled={busy !== null} onClick={() => void run("fund", async () => { await api("/v1/dev/fund", { method: "POST", body: { chainFamily, address } }); invalidate("/v1/treasuries"); }, chainFamily === "evm" ? "Added 10 ETH on the local chain" : "Airdropped 5 SOL on the local chain")}>
      <Icons.Plus />{busy ? "Funding…" : label}
    </button>
  );
}
