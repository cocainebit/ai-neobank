"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icons } from "../../../components/icons";
import { useSession } from "../../../components/session";
import { Ago, CopyField, Empty, LoadingRows, PageHead, Pill } from "../../../components/ui";
import { useApi } from "../../../lib/api";
import { useAgents, useAssets, useTreasuries } from "../../../lib/data";
import { sentence } from "../../../lib/format";

interface Job { id: string; type: string; attempts: number; maxAttempts: number; status: string; lastError: string | null; runAt: string; intentId: string | null }

const statuses: [string, string][] = [
  ["received", "Accepted and waiting for the policy check"],
  ["policy_evaluated", "Passed policy; the Safe or Squads proposal is being published"],
  ["approval_required", "Waiting for people to approve with their wallets"],
  ["approved", "Approved; queued for signing"],
  ["executing", "Policy checked again, transaction being signed"],
  ["submitted", "Broadcast; waiting for finality"],
  ["reconciled", "Final on chain and booked in the ledger"],
  ["rejected", "Refused by policy or by an approver. Read failureReason"],
  ["failed", "Could not be executed. Read failureReason"],
  ["expired", "Not approved before expiresAt"]
];

export default function DevelopersPage() {
  const { can } = useSession();
  const treasuries = useTreasuries();
  const assets = useAssets();
  const agents = useAgents();
  const jobs = useApi<Job[]>(can("owner", "operator") ? "/v1/jobs" : null, { refreshMs: 10_000 });
  const [base, setBase] = useState("");
  useEffect(() => { setBase(`${window.location.origin}/api`); }, []);

  const treasury = treasuries.data?.find((candidate) => candidate.status === "active");
  const asset = assets.data?.find((candidate) => candidate.network === treasury?.network);
  const treasuryId = treasury?.id ?? "<treasury id>";
  const assetId = asset?.id ?? "<asset id>";
  const url = base || "<console url>/api";

  const examples = {
    capabilities: `curl ${url}/v1/agent/capabilities \\\n  -H "Authorization: Bearer $RELAY_AGENT_KEY"`,
    create: `curl ${url}/v1/agent/intents \\\n  -H "Authorization: Bearer $RELAY_AGENT_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "idempotencyKey": "invoice-4471-payout",\n    "treasuryAccountId": "${treasuryId}",\n    "assetId": "${assetId}",\n    "amountBaseUnits": "${asset ? (10n ** BigInt(asset.decimals)).toString() : "1000000"}",\n    "destination": "${treasury?.chainFamily === "svm" ? "<solana address>" : "0x..."}",\n    "purpose": "Pay invoice 4471 from Northwind"\n  }'`,
    status: `curl ${url}/v1/agent/intents/<intent id> \\\n  -H "Authorization: Bearer $RELAY_AGENT_KEY"`,
    x402: `curl ${url}/v1/agent/x402/quote \\\n  -H "Authorization: Bearer $RELAY_AGENT_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "url": "https://api.example.com/report", "treasuryAccountId": "${treasuryId}", "assetId": "<usdc asset id>", "maxAmountBaseUnits": "250000" }'`
  };

  return (
    <>
      <PageHead title="Developers" description="Agents call the same API the console uses, with their own key. They can read what they are allowed to spend, request payments, and follow each one to settlement. They cannot approve, sign, or change policy." />
      <div className="grid-main">
        <div className="stack">
          <section className="panel milled">
            <header className="panel-head"><div><h2>Base URL</h2><p>Send the agent key as a bearer token. Keys start with rl_agent_.</p></div></header>
            <div className="panel-body" style={{ display: "grid", gap: 14 }}>
              <CopyField value={url} />
              <ol className="steps">
                <li><b>Create an agent and a key</b><span>{(agents.data ?? []).length ? `${agents.data!.length} ${agents.data!.length === 1 ? "agent" : "agents"} so far.` : "No agents yet."} <Link href="/agents">Open Agents</Link></span></li>
                <li><b>Bind a spending policy</b><span>Without one, every request waits for a person. <Link href="/policies">Open Policies</Link></span></li>
                <li><b>Request a payment</b><span>Amounts are integers in the asset&apos;s base units, for example 1000000 for 1 USDC.</span></li>
              </ol>
            </div>
          </section>
          <Example title="What can this agent spend?" description="Its active treasuries, bound policies, and the assets on their networks." code={examples.capabilities} />
          <Example title="Request a payment" description="Retrying with the same idempotencyKey returns the original request instead of creating a second one. Use beneficiaryId instead of destination to pay a saved recipient." code={examples.create} />
          <Example title="Follow it to settlement" description="Poll until the status is reconciled, rejected, failed, or expired. The response includes the transaction hash once broadcast." code={examples.status} />
          <Example title="Quote an x402 purchase" description="Fetches the seller's payment terms without paying. Then request an intent with kind x402 and the same url; it is signed only after policy and approval." code={examples.x402} />
        </div>
        <div className="stack">
          <section className="panel">
            <header className="panel-head"><div><h2>Payment statuses</h2><p>The status field on every intent</p></div></header>
            <div className="rows">
              {statuses.map(([status, meaning]) => (
                <div key={status} className="row" style={{ gridTemplateColumns: "132px minmax(0, 1fr)", alignItems: "start", padding: "10px 18px", minHeight: 0 }}>
                  <b style={{ fontWeight: 550, fontSize: 13 }}>{status}</b>
                  <span className="dim" style={{ fontSize: 13 }}>{meaning}</span>
                </div>
              ))}
            </div>
          </section>
          {can("owner", "operator") && (
            <section className="panel">
              <header className="panel-head"><div><h2>Worker queue</h2><p>Recent background jobs for this workspace</p></div></header>
              {jobs.loading && !jobs.data ? <LoadingRows rows={4} /> : jobs.error ? <div className="panel-body"><span className="negative">{jobs.error.message}</span></div> : (jobs.data ?? []).length === 0 ? (
                <Empty title="No jobs yet">Jobs appear when payments are requested and treasuries sync.</Empty>
              ) : (
                <div className="rows">
                  {(jobs.data ?? []).slice(0, 12).map((job) => (
                    <div key={job.id} className="row" style={{ padding: "10px 18px", minHeight: 0 }}>
                      <span className="cell-title"><b style={{ fontWeight: 500 }}>{sentence(job.type.replaceAll(".", " "))}</b><span title={job.lastError ?? undefined}>{job.lastError ? job.lastError.slice(0, 80) : <>Attempt {job.attempts} of {job.maxAttempts} · <Ago iso={job.runAt} /></>}</span></span>
                      <Pill tone={job.status === "succeeded" ? "positive" : job.status === "dead" ? "negative" : job.status === "retry" ? "pending" : "info"}>{sentence(job.status)}</Pill>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Example({ title, description, code }: { title: string; description: string; code: string }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div><h2>{title}</h2><p style={{ whiteSpace: "normal" }}>{description}</p></div>
        <CopyButton value={code} />
      </header>
      <div className="panel-body"><code className="code">{code}</code></div>
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn small ghost" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Icons.Check /> : <Icons.Copy />}{copied ? "Copied" : "Copy"}
    </button>
  );
}
