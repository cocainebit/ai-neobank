"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, invalidate, useApi } from "../lib/api";
import { shortAddress } from "../lib/format";
import type { Health, Intent } from "../lib/types";
import { Icons } from "./icons";
import { useSession } from "./session";
import { useToast } from "./ui";

const groups: { label: string; items: { href: string; label: string; icon: keyof typeof Icons; count?: "approvals" }[] }[] = [
  { label: "Money", items: [
    { href: "/", label: "Overview", icon: "Overview" },
    { href: "/payments", label: "Payments", icon: "Payments", count: "approvals" },
    { href: "/treasuries", label: "Treasuries", icon: "Treasury" },
    { href: "/invoices", label: "Invoices", icon: "Invoice" },
    { href: "/recurring", label: "Recurring", icon: "Recurring" },
    { href: "/statements", label: "Statements", icon: "Statement" }
  ] },
  { label: "Control", items: [
    { href: "/agents", label: "Agents", icon: "Agent" },
    { href: "/policies", label: "Policies", icon: "Policy" },
    { href: "/beneficiaries", label: "Beneficiaries", icon: "Beneficiary" },
    { href: "/members", label: "Members", icon: "Members" }
  ] }
];

const titles: Record<string, string> = {
  "/": "Overview", "/payments": "Payments", "/treasuries": "Treasuries", "/invoices": "Invoices", "/recurring": "Recurring", "/statements": "Statements",
  "/agents": "Agents", "/policies": "Policies", "/beneficiaries": "Beneficiaries", "/members": "Members", "/developers": "Developers", "/settings": "Settings"
};

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { session, signOut, reload } = useSession();
  const toast = useToast();
  const approvals = useApi<Intent[]>("/v1/intents?status=approval_required", { refreshMs: 10_000 });
  const health = useApi<Health>("/health", { refreshMs: 30_000, raw: true });
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const pending = approvals.data?.length ?? 0;
  const section = pathname === "/" ? "/" : `/${pathname.split("/")[1]}`;
  const others = session.memberships.filter((membership) => membership.organizationId !== session.organization.id);

  async function switchTo(organizationId: string) {
    try {
      await api("/v1/auth/switch", { method: "POST", body: { organizationId } });
      setSwitcherOpen(false);
      invalidate();
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not switch", "negative");
    }
  }

  const chainState = (() => {
    const integrations = health.data?.integrations;
    if (!integrations) return { tone: "", label: "Checking networks" };
    const configured = [integrations.evm, integrations.solana].filter((value) => value && value !== "not_configured");
    if (configured.length === 0) return { tone: "negative", label: "No networks configured" };
    if (configured.some((value) => value?.startsWith("rpc_unreachable"))) return { tone: "negative", label: "A network is unreachable" };
    const names = configured.map((value) => value!.split(":").slice(1).join(":")).map((network) => network.includes("31337") || network.includes("localnet") ? "local" : network);
    return { tone: "positive", label: `Connected: ${[...new Set(names)].join(", ")}` };
  })();

  return (
    <div className="shell">
      <aside className={`sidebar ${navOpen ? "open" : ""}`} onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setNavOpen(false); }}>
        <div className="brand">
          <span className="brand-mark"><Icons.Logo /></span>Relay
          <button className="nav-toggle" aria-expanded={navOpen} aria-label={navOpen ? "Hide navigation" : "Show navigation"} onClick={() => setNavOpen((open) => !open)}>
            {navOpen ? <Icons.Close /> : <Icons.Menu />}
          </button>
        </div>
        <div style={{ position: "relative" }}>
          <button className="org-card" onClick={() => setSwitcherOpen((open) => !open)} aria-expanded={switcherOpen} aria-label="Switch organization">
            <span className="org-card-top">
              <span className="org-avatar">{session.organization.name.slice(0, 1).toUpperCase()}</span>
              <span style={{ minWidth: 0 }}>
                <span className="org-name truncate" style={{ display: "block" }}>{session.organization.name}</span>
                <span className="faint" style={{ fontSize: 12.5 }}>{session.principal?.displayName ?? "Member"}</span>
              </span>
              <Icons.Chevrons style={{ width: 16, color: "var(--faint)" }} />
            </span>
            <span className="org-meta">
              <span className="chip">Role <b>{session.principal?.role ?? "none"}</b></span>
              {session.wallet && <span className="chip address">{session.wallet.chainFamily === "evm" ? <Icons.Ethereum style={{ width: 12 }} /> : <Icons.Solana style={{ width: 12 }} />}{shortAddress(session.wallet.address, 5, 4)}</span>}
              {session.organization.frozen && <span className="chip" style={{ color: "var(--negative)" }}>Frozen</span>}
            </span>
          </button>
          {switcherOpen && (
            <div className="panel" style={{ position: "absolute", top: "calc(100% - 10px)", left: 0, right: 0, zIndex: 20, boxShadow: "var(--shadow-float)" }}>
              <div className="rows">
                {others.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>Your wallet belongs to one organization.</span></div>}
                {others.map((membership) => (
                  <button key={membership.organizationId} className="row" style={{ width: "100%", background: "none", border: 0, textAlign: "left" }} onClick={() => void switchTo(membership.organizationId)}>
                    <span className="truncate">{membership.organizationName}</span><span className="faint" style={{ fontSize: 12 }}>{membership.role}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {groups.map((group) => (
          <nav className="nav-group" key={group.label} aria-label={group.label}>
            <span className="eyebrow">{group.label}</span>
            {group.items.map((item) => {
              const Glyph = Icons[item.icon];
              return (
                <Link key={item.href} href={item.href} className="nav-link" aria-current={section === item.href ? "page" : undefined}>
                  <Glyph />{item.label}
                  {item.count === "approvals" && pending > 0 && <span className="nav-count" aria-label={`${pending} awaiting approval`}>{pending}</span>}
                </Link>
              );
            })}
          </nav>
        ))}
        <div className="sidebar-foot">
          <Link href="/developers" className="nav-link" aria-current={section === "/developers" ? "page" : undefined}><Icons.Code />Developers</Link>
          <Link href="/settings" className="nav-link" aria-current={section === "/settings" ? "page" : undefined}><Icons.Settings />Settings</Link>
          <button className="nav-link" style={{ background: "none", border: 0, width: "100%" }} onClick={() => void signOut()}><Icons.Logout />Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumbs"><span className="truncate" style={{ maxWidth: 220 }}>{session.organization.name}</span><span>/</span><b>{titles[section] ?? "Relay"}</b></div>
          <div className="topbar-actions">
            <span className="network-status"><span className={`dot ${chainState.tone}`} />{chainState.label}</span>
          </div>
        </header>
        {session.organization.frozen && (
          <div style={{ padding: "12px 32px 0" }}>
            <div className="notice negative"><Icons.Freeze /><div><b>Organization frozen.</b> No payment can be requested, approved, or signed until an owner unfreezes it in <Link href="/settings" style={{ textDecoration: "underline" }}>Settings</Link>.</div></div>
          </div>
        )}
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
