"use client";

import { useEffect, useMemo, useState } from "react";

type View = "Dashboard" | "Transactions" | "Agents" | "Treasury" | "Proposals" | "Policies" | "Developers" | "Settings";
type Proposal = { id: number; title: string; agent: string; network: string; amount: string; destination: string; status: "Pending" | "Approved" | "Rejected" };
type Agent = { name: string; role: string; spent: number; limit: number; active: boolean; color: string };

const initialAgents: Agent[] = [
  { name: "Research", role: "APIs and data", spent: 1284, limit: 5000, active: true, color: "#4967d8" },
  { name: "Operations", role: "Compute and infrastructure", spent: 840, limit: 2500, active: true, color: "#7852b5" },
  { name: "Procurement", role: "Vendor payments", spent: 4202, limit: 10000, active: false, color: "#b46a3f" }
];
const initialProposals: Proposal[] = [{ id: 1, title: "Vendor payment", agent: "Procurement", network: "Base Sepolia", amount: "1,900 USDC", destination: "0x71C4…89E2", status: "Pending" }];
const activities = [
  ["API access", "Research", "Base Sepolia", "− 24.00 USDC", "Completed", "4 min"],
  ["Compute credits", "Operations", "Solana Devnet", "− 85.00 USDC", "Completed", "22 min"],
  ["Vendor payment", "Procurement", "Base Sepolia", "− 1,900.00 USDC", "Pending", "1 hr"],
  ["Treasury deposit", "Ari", "Solana Devnet", "+ 5,000.00 USDC", "Completed", "3 hr"]
];
const nav: { name: View; icon: string }[] = [
  { name: "Dashboard", icon: "▥" }, { name: "Transactions", icon: "ϟ" }, { name: "Agents", icon: "♙" },
  { name: "Treasury", icon: "♜" }, { name: "Proposals", icon: "▤" }, { name: "Policies", icon: "◇" }
];

declare global {
  interface Window {
    ethereum?: { request(args: { method: string }): Promise<string[]> };
    solana?: { connect(): Promise<{ publicKey: { toString(): string } }> };
  }
}

const shortAddress = (address: string) => `${address.slice(0, 5)}…${address.slice(-4)}`;

export function Dashboard() {
  const [view, setView] = useState<View>("Dashboard");
  const [agents, setAgents] = useState(initialAgents);
  const [proposals, setProposals] = useState(initialProposals);
  const [modal, setModal] = useState<"proposal" | "fund" | "wallet" | null>(null);
  const [wallet, setWallet] = useState<{ type: string; address: string } | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("relay-demo-state");
    if (!saved) return;
    try { const state = JSON.parse(saved) as { agents: Agent[]; proposals: Proposal[] }; setAgents(state.agents); setProposals(state.proposals); }
    catch { localStorage.removeItem("relay-demo-state"); }
  }, []);
  useEffect(() => { localStorage.setItem("relay-demo-state", JSON.stringify({ agents, proposals })); }, [agents, proposals]);

  const pending = proposals.filter((proposal) => proposal.status === "Pending").length;
  const spend = useMemo(() => agents.reduce((total, agent) => total + agent.spent, 0), [agents]);
  function flash(message: string) { setNotice(message); window.setTimeout(() => setNotice(""), 2800); }

  async function connect(kind: "evm" | "solana") {
    try {
      if (kind === "evm") {
        if (!window.ethereum) return flash("No EVM wallet extension detected.");
        const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
        if (address) setWallet({ type: "EVM", address });
      } else {
        if (!window.solana) return flash("No Solana wallet extension detected.");
        const response = await window.solana.connect(); setWallet({ type: "Solana", address: response.publicKey.toString() });
      }
      setModal(null);
    } catch { flash("Wallet connection was cancelled."); }
  }
  function createProposal(form: FormData) {
    const next: Proposal = { id: Date.now(), title: String(form.get("title") || "Payment"), agent: String(form.get("agent")), network: String(form.get("network")), amount: `${String(form.get("amount") || "0")} ${String(form.get("asset") || "USDC")}`, destination: String(form.get("destination")), status: "Pending" };
    setProposals((items) => [next, ...items]); setModal(null); setView("Proposals"); flash("Proposal created and saved locally.");
  }
  function decide(id: number, status: "Approved" | "Rejected") {
    setProposals((items) => items.map((item) => item.id === id ? { ...item, status } : item));
    flash(status === "Approved" ? "Approved locally. Chain submission is not enabled yet." : "Proposal rejected.");
  }

  return <div className="app-shell">
    {notice && <div className="toast">{notice}</div>}
    <aside className="side">
      <button className="wordmark" onClick={() => setView("Dashboard")}><span className="relay-logo">R</span><strong>RELAY</strong></button>
      <button className="account-card" onClick={() => setView("Treasury")}><span className="vault-logo">A</span><span><small>Acme Labs</small><b>$84,320.42</b></span><span className="updown">⌃<br />⌄</span><span className="threshold">Threshold <b>2/3</b></span><span className="account-menu">⌘</span></button>
      <nav className="dark-nav">{nav.map((item) => <button key={item.name} className={view === item.name ? "selected" : ""} onClick={() => setView(item.name)}><span className="nav-icon">{item.icon}</span>{item.name}{item.name === "Proposals" && pending > 0 && <em>{pending}</em>}</button>)}</nav>
      <div className="side-bottom"><button className={view === "Developers" ? "selected" : ""} onClick={() => setView("Developers")}><span>‹/›</span> Developers</button><button className={view === "Settings" ? "selected" : ""} onClick={() => setView("Settings")}><span>⚙</span> Settings</button><button onClick={() => flash("Support channel copied: support@relay.local")}><span>?</span> Help & Support</button></div>
    </aside>
    <section className="main-panel">
      <header className="dark-topbar"><div><span className="live-dot" /> Test networks</div><button className="connect" onClick={() => wallet ? flash(`${wallet.type}: ${wallet.address}`) : setModal("wallet")}><span>▭</span>{wallet ? shortAddress(wallet.address) : "Connect"}</button></header>
      <div className="page"><div className="page-heading"><div><h1>{view}</h1><p>{subtitle(view)}</p></div><PageAction view={view} onProposal={() => setModal("proposal")} onFund={() => setModal("fund")} /></div>
        {view === "Dashboard" && <Overview agents={agents} pending={pending} spend={spend} onReview={() => setView("Proposals")} onAgents={() => setView("Agents")} />}
        {view === "Treasury" && <Treasury onFund={() => setModal("fund")} />}
        {view === "Agents" && <Agents agents={agents} setAgents={setAgents} flash={flash} />}
        {view === "Proposals" && <Proposals proposals={proposals} decide={decide} />}
        {view === "Transactions" && <Transactions />}{view === "Policies" && <Policies agents={agents} />}
        {view === "Developers" && <Developers flash={flash} />}{view === "Settings" && <Settings />}
      </div>
    </section>
    {modal && <Modal type={modal} close={() => setModal(null)} connect={connect} createProposal={createProposal} flash={flash} />}
  </div>;
}

function subtitle(view: View) { const labels: Record<View, string> = { Dashboard: "Human-controlled treasuries. Delegated agent spending.", Transactions: "Activity across every connected account.", Agents: "Control who can spend, where, and how much.", Treasury: "Balances remain native to each chain.", Proposals: "Review intent before any transaction reaches a signer.", Policies: "Deterministic limits enforced outside the model.", Developers: "Integrate agents with scoped capabilities.", Settings: "Organization and security configuration." }; return labels[view]; }
function PageAction({ view, onProposal, onFund }: { view: View; onProposal(): void; onFund(): void }) { if (view === "Treasury") return <button className="main-action" onClick={onFund}>＋ Add funds</button>; if (["Dashboard", "Proposals"].includes(view)) return <button className="main-action" onClick={onProposal}>＋ Create proposal</button>; return null; }

function Overview({ agents, pending, spend, onReview, onAgents }: { agents: Agent[]; pending: number; spend: number; onReview(): void; onAgents(): void }) {
  return <><section className="hero-card"><div className="balance-pane"><label>TOTAL BALANCE</label><strong>$84,320<span>.42</span></strong><p><b>↗ 2.4%</b> past 30 days</p><div className="chain-balances"><span><i className="sol" />Solana<b>$49,210.12</b></span><span><i className="evm" />EVM<b>$35,110.30</b></span></div></div><div className="allowance-pane"><label>AGENT ALLOWANCE</label><strong>$17,500</strong><p>${spend.toLocaleString()} used this month</p><div className="line"><i style={{ width: `${Math.min(100, spend / 175)}%` }} /></div></div><div className="attention-pane"><label>NEEDS ATTENTION</label><strong>{pending} proposal{pending === 1 ? "" : "s"}</strong><p>Waiting for human approval</p><button onClick={onReview}>Review proposals →</button></div></section>
    <div className="section-header"><div><h2>Agent allowances</h2><p>Delegated limits across all treasuries</p></div><button onClick={onAgents}>Manage agents</button></div><section className="agent-cards">{agents.map((agent) => <article key={agent.name}><div><span className="agent-logo" style={{ background: agent.color }}>{agent.name[0]}</span><span className={`pill ${agent.active ? "green" : "grey"}`}>● {agent.active ? "Active" : "Approval only"}</span></div><h3>{agent.name}</h3><p>${agent.spent.toLocaleString()} of ${agent.limit.toLocaleString()}</p><div className="line"><i style={{ width: `${agent.spent / agent.limit * 100}%` }} /></div><footer>Monthly allowance <span>›</span></footer></article>)}</section>
    <div className="section-header"><div><h2>Recent activity</h2><p>Transactions across every connected chain</p></div></div><ActivityTable /></>;
}
function Treasury({ onFund }: { onFund(): void }) { const accounts = [["Solana treasury", "Squads", "Solana Devnet", "$49,210.12", "7YhF…k2sP"], ["EVM treasury", "Safe", "Base Sepolia", "$35,110.30", "0x71…89E2"]]; return <><div className="tabs"><button className="active">Accounts</button><button>Assets</button></div><section className="treasury-grid">{accounts.map((a) => <article key={a[0]}><div className="treasury-top"><span className="vault-logo">{a[0][0]}</span><span className="pill green">● Connected</span></div><h3>{a[0]}</h3><strong>{a[3]}</strong><dl><div><dt>Governance</dt><dd>{a[1]}</dd></div><div><dt>Network</dt><dd>{a[2]}</dd></div><div><dt>Address</dt><dd>{a[4]}</dd></div></dl><button onClick={onFund}>Deposit</button></article>)}</section></>; }
function Agents({ agents, setAgents, flash }: { agents: Agent[]; setAgents: React.Dispatch<React.SetStateAction<Agent[]>>; flash(s: string): void }) { return <section className="list-panel">{agents.map((agent, index) => <article className="agent-row" key={agent.name}><span className="agent-logo" style={{ background: agent.color }}>{agent.name[0]}</span><span><b>{agent.name}</b><small>{agent.role}</small></span><span><small>MONTHLY LIMIT</small><b>${agent.limit.toLocaleString()}</b></span><span><small>SPENT</small><b>${agent.spent.toLocaleString()}</b></span><span className={`pill ${agent.active ? "green" : "grey"}`}>● {agent.active ? "Active" : "Frozen"}</span><button onClick={() => { setAgents((items) => items.map((a, i) => i === index ? { ...a, active: !a.active } : a)); flash(`${agent.name} ${agent.active ? "frozen" : "activated"}.`); }}>{agent.active ? "Freeze" : "Activate"}</button></article>)}</section>; }
function Proposals({ proposals, decide }: { proposals: Proposal[]; decide(id: number, status: "Approved" | "Rejected"): void }) { return <section className="list-panel">{proposals.length === 0 ? <div className="empty">No proposals yet.</div> : proposals.map((p) => <article className="proposal-row" key={p.id}><div><span className="tx-symbol">↗</span><span><b>{p.title}</b><small>{p.agent} · {p.network}</small></span></div><span><small>DESTINATION</small><b>{p.destination}</b></span><strong>{p.amount}</strong><span className={`pill ${p.status === "Approved" ? "green" : p.status === "Rejected" ? "red" : "amber"}`}>● {p.status}</span>{p.status === "Pending" ? <div className="decision"><button onClick={() => decide(p.id, "Rejected")}>Reject</button><button className="approve" onClick={() => decide(p.id, "Approved")}>Approve</button></div> : <span />}</article>)}</section>; }
function Transactions() { return <ActivityTable expanded />; }
function ActivityTable({ expanded = false }: { expanded?: boolean }) { const rows = expanded ? [...activities, ...activities] : activities; return <div className="dark-table"><table><thead><tr><th>ACTIVITY</th><th>INITIATED BY</th><th>NETWORK</th><th>AMOUNT</th><th>STATUS</th><th>TIME</th></tr></thead><tbody>{rows.map((r, i) => <tr key={`${r[0]}-${i}`}><td><span className="tx-symbol">↗</span><b>{r[0]}</b></td><td>{r[1]}</td><td><i className={r[2].startsWith("Solana") ? "sol" : "evm"} />{r[2]}</td><td>{r[3]}</td><td><span className={`pill ${r[4] === "Completed" ? "green" : "amber"}`}>● {r[4]}</span></td><td>{r[5]}</td></tr>)}</tbody></table></div>; }
function Policies({ agents }: { agents: Agent[] }) { return <section className="policy-grid">{agents.map((a) => <article key={a.name}><span className="pill green">ENFORCED</span><h3>{a.name} spending policy</h3><p>Deterministic rules evaluated before a transaction can be compiled.</p><dl><div><dt>Per transaction</dt><dd>${Math.round(a.limit / 4).toLocaleString()}</dd></div><div><dt>Monthly</dt><dd>${a.limit.toLocaleString()}</dd></div><div><dt>Networks</dt><dd>2 allowed</dd></div><div><dt>Human approval</dt><dd>Above threshold</dd></div></dl><button>Edit policy</button></article>)}</section>; }
function Developers({ flash }: { flash(s: string): void }) { return <section className="developer-card"><span className="pill amber">TEST MODE</span><h2>Agent capability API</h2><p>Submit structured payment intents. Raw transactions and treasury keys are never accepted.</p><label>API KEY</label><div className="api-key"><code>relay_test_••••••••7h2k</code><button onClick={() => { void navigator.clipboard.writeText("relay_test_demo_only"); flash("Test key copied."); }}>Copy</button></div><pre>{`POST /v1/intents/evaluate\n{\n  "network": "eip155:84532",\n  "kind": "x402",\n  "amountBaseUnits": "25000000"\n}`}</pre></section>; }
function Settings() { return <section className="settings-card"><h2>Organization security</h2>{[["Approval threshold", "2 of 3 owners"], ["Execution networks", "Test networks only"], ["Autonomous mainnet execution", "Disabled"], ["Emergency freeze", "Available to owners"]].map((s) => <div key={s[0]}><span><b>{s[0]}</b><small>{s[1]}</small></span><button>Configure</button></div>)}</section>; }

function Modal({ type, close, connect, createProposal, flash }: { type: "proposal" | "fund" | "wallet"; close(): void; connect(k: "evm" | "solana"): void; createProposal(f: FormData): void; flash(s: string): void }) {
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="modal"><button className="modal-close" onClick={close}>×</button>
    {type === "wallet" && <><h2>Connect wallet</h2><p>Connect as a human signer. Relay never receives your private keys.</p><button className="wallet-choice" onClick={() => void connect("evm")}><span className="evm-badge">◆</span><span><b>EVM wallet</b><small>MetaMask or compatible provider</small></span><strong>→</strong></button><button className="wallet-choice" onClick={() => void connect("solana")}><span className="sol-badge">≋</span><span><b>Solana wallet</b><small>Phantom or compatible provider</small></span><strong>→</strong></button></>}
    {type === "fund" && <><h2>Add funds</h2><p>Send test-network assets to the matching treasury address.</p>{[["Base Sepolia", "0x71C4E1aA7b5F246Bef1989E2"], ["Solana Devnet", "7YhFgC4Mzf3F5ZQX9ak2sP"]].map((a) => <div className="deposit" key={a[0]}><label>{a[0]}</label><code>{a[1]}</code><button onClick={() => { void navigator.clipboard.writeText(a[1]); flash("Address copied."); }}>Copy</button></div>)}<div className="warning">Only send test-network assets. These addresses are interface placeholders until treasury deployment is enabled.</div></>}
    {type === "proposal" && <><h2>Create proposal</h2><p>Create a human-readable payment intent. Approval does not submit it on-chain yet.</p><form action={createProposal}><label>Title<input name="title" required placeholder="Vendor payment" /></label><div className="form-grid"><label>Agent<select name="agent">{initialAgents.map((a) => <option key={a.name}>{a.name}</option>)}</select></label><label>Network<select name="network"><option>Base Sepolia</option><option>Solana Devnet</option></select></label></div><div className="form-grid"><label>Amount<input name="amount" required inputMode="decimal" placeholder="100" /></label><label>Asset<select name="asset"><option>USDC</option><option>ETH</option><option>SOL</option></select></label></div><label>Destination<input name="destination" required placeholder="Wallet or service address" /></label><button className="submit" type="submit">Create proposal</button></form></>}
  </section></div>;
}
