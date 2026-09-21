"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi, type ApiError } from "../lib/api";
import { useTreasuries } from "../lib/data";
import { formatDate } from "../lib/format";
import { Icons } from "./icons";
import { Empty, ErrorState, LoadingRows, Notice, Pill } from "./ui";
import { endpointMissing, VerificationBanner, VerificationPanel, useVerification, type CapabilityDecision } from "./verification-banner";

/**
 * Cards in the Relay console.
 *
 * Nothing here invents a card. Relay has no card provider, no licence, and no
 * verification provider connected, so the card list is whatever the API returns
 * (nothing today) and every action is locked. What the page does explain is what
 * a card here would be, so that the lock is understandable rather than blank.
 */

/** A card as the API would describe one. Only fields the API sends are ever shown. */
export interface Card {
  id: string;
  status: string;
  holderPrincipalId?: string | null;
  holderName?: string | null;
  holderKind?: "member" | "agent" | null;
  treasuryAccountId?: string | null;
  form?: "virtual" | "physical" | null;
  last4?: string | null;
  spendLimitBaseUnits?: string | null;
  createdAt?: string | null;
}

interface CardsPayload { provider?: string | null; cards?: Card[] }

interface CardsState {
  cards: Card[];
  provider: string | null;
  /** True when this server has no card route at all. */
  routeMissing: boolean;
  loading: boolean;
  error: ApiError | undefined;
  reload(): Promise<void>;
}

function useCards(): CardsState {
  const resource = useApi<Card[] | CardsPayload>("/v1/cards");
  const routeMissing = endpointMissing(resource.error);
  const payload = resource.data;
  const cards = Array.isArray(payload) ? payload : payload?.cards ?? [];
  const provider = Array.isArray(payload) ? null : payload?.provider ?? null;
  return { cards, provider, routeMissing, loading: resource.loading, error: routeMissing ? undefined : resource.error, reload: resource.reload };
}

const tabs = [
  { key: "cards", label: "Cards" },
  { key: "spending", label: "Spending" },
  { key: "controls", label: "Controls" }
] as const;

export function CardsPanel() {
  const verification = useVerification();
  const cards = useCards();
  const [tab, setTab] = useState<(typeof tabs)[number]["key"]>("cards");
  // The API decides what is locked and why: an unverified organization and a
  // verified one with no card issuer behind it are different states, and the
  // page says which one this is.
  const gate = verification.capability("cards");
  const locked = !gate.allowed;

  return (
    <>
      <VerificationBanner verification={verification} capability="cards" feature="Cards" />

      <div className="tabs" role="tablist" style={{ marginTop: 18 }}>
        {tabs.map((entry) => (
          <button key={entry.key} role="tab" aria-selected={tab === entry.key} onClick={() => setTab(entry.key)}>{entry.label}</button>
        ))}
      </div>

      {tab === "cards" && <CardsTab cards={cards} gate={gate} locked={locked} />}
      {tab === "spending" && <SpendingTab gate={gate} anyCards={cards.cards.length > 0} />}
      {tab === "controls" && <ControlsTab locked={locked} />}

      <div style={{ marginTop: 16 }}><VerificationPanel verification={verification} /></div>
    </>
  );
}

function CardsTab({ cards, gate, locked }: { cards: CardsState; gate: CapabilityDecision; locked: boolean }) {
  const treasuries = useTreasuries();

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Cards</h2>
            <p>Debit cards that spend from a treasury you already hold, under the policy that treasury already has.</p>
          </div>
          <button className="btn primary" disabled title={gate.allowed ? "No card issuer is connected to this server." : gate.reason}>
            <Icons.Card style={{ width: 16 }} />Order a card
          </button>
        </header>
        <div className="panel-body stack">
          <div className="card-face" aria-hidden="true">
            <span className="card-face-lock">{locked ? <Icons.Lock style={{ width: 18 }} /> : <Icons.Card style={{ width: 18 }} />}</span>
            <span className="card-face-text">{locked ? "Locked" : "No card to show"}</span>
          </div>

          {cards.error ? <ErrorState error={cards.error} retry={() => void cards.reload()} />
            : cards.loading && cards.cards.length === 0 ? <LoadingRows rows={3} />
            : cards.cards.length === 0 ? (
              <Empty title={locked ? "Cards are locked" : "No card has been issued"}>
                {!gate.allowed
                  ? gate.reason
                  : cards.routeMissing
                    ? "This server has no card route yet, so there is nothing to list."
                    : "Nothing has been issued. When a card issuer is connected, cards you order appear here with their holder, their treasury, and their limit."}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Card</th><th>Holder</th><th>Spends from</th><th>Status</th><th>Issued</th></tr></thead>
                  <tbody>
                    {cards.cards.map((card) => {
                      const treasury = treasuries.data?.find((candidate) => candidate.id === card.treasuryAccountId);
                      return (
                        <tr key={card.id}>
                          <td className="primary"><div className="cell-title"><b>{card.form === "physical" ? "Physical" : "Virtual"}</b><span className="num">{card.last4 ? `ending ${card.last4}` : "no number shared"}</span></div></td>
                          <td>{card.holderName ?? <span className="faint">Unknown</span>}{card.holderKind === "agent" && <span className="faint"> · agent</span>}</td>
                          <td>{treasury?.name ?? <span className="faint">Not recorded</span>}</td>
                          <td><Pill tone={card.status === "active" ? "positive" : card.status === "frozen" ? "negative" : "pending"}>{card.status}</Pill></td>
                          <td>{card.createdAt ? formatDate(card.createdAt) : <span className="faint">Unknown</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><div><h2>What happens when cards open</h2><p>Nothing below is live yet. It is how a card here is meant to work, so the lock makes sense.</p></div></header>
        <div className="panel-body">
          <ol className="steps">
            <li><b>Verify the business</b><span>A regulated partner has to know who you are before anyone holds a card. Relay has no verification provider connected yet.</span></li>
            <li><b>Pick the treasury it spends from</b><span>A card does not hold a balance of its own. It draws on a vault or account you already control.</span></li>
            <li><b>Pick the holder and the limit</b><span>A person, or an agent. The limit is the policy already bound to them, not a second set of rules.</span></li>
            <li><b>Every authorisation becomes a payment</b><span>It shows in Payments, lands in Statements, and is reconciled against the chain like any other movement.</span></li>
          </ol>
        </div>
      </section>
    </div>
  );
}

function SpendingTab({ gate, anyCards }: { gate: CapabilityDecision; anyCards: boolean }) {
  return (
    <div className="stack">
      <section className="panel milled">
        <div className="stat-strip" style={{ ["--stats" as string]: 3 }}>
          <div><span className="eyebrow">Cards issued</span><div className="value">None</div><div className="sub">No card issuer is connected</div></div>
          <div><span className="eyebrow">Card spending</span><div className="value">None</div><div className="sub">Nothing has been authorised</div></div>
          <div><span className="eyebrow">Declines</span><div className="value">None</div><div className="sub">There is nothing to decline</div></div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><div><h2>Card spending</h2><p>Every authorisation, the treasury it came out of, and whether it settled.</p></div></header>
        <div className="panel-body">
          <Empty title="Nothing to show">
            {!gate.allowed
              ? gate.reason
              : anyCards
                ? "No authorisation has come through yet."
                : "No card has been issued, so nothing has been spent on one."}
          </Empty>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><div><h2>Where card spending will appear</h2></div></header>
        <div className="panel-body stack">
          <Notice>
            <b>A card payment is a payment.</b> It is checked against the same policy, it appears in <Link href="/payments" style={{ textDecoration: "underline" }}>Payments</Link> with the merchant as the destination, it lands in <Link href="/statements" style={{ textDecoration: "underline" }}>Statements</Link> with everything else, and it is reconciled against the chain. There is no separate card ledger to keep in your head.
          </Notice>
          <small className="faint">
            One difference is worth knowing in advance: a card authorises first and settles later, so the amount can change between the two. Relay will show both, and the statement line follows what settled.
          </small>
        </div>
      </section>
    </div>
  );
}

function ControlsTab({ locked }: { locked: boolean }) {
  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head"><div><h2>Who could hold one</h2><p>Two kinds of holder, with deliberately different rules.</p></div></header>
        <div className="panel-body">
          <div className="grid-2">
            <div className="fact-card">
              <b>A person</b>
              <p>A member with the owner, approver, or operator role. The card is theirs, it can be used in a shop or online, and it spends from a treasury you choose. Freezing the person freezes the card.</p>
            </div>
            <div className="fact-card">
              <b>An agent</b>
              <p>An agent card is not a card to carry. It exists for one machine, it is single use or narrow by default, it has no physical form, and it dies with the agent's key. An agent that is frozen cannot authorise anything.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><div><h2>What limits apply</h2><p>The rules you already wrote, not a second set to keep in step.</p></div></header>
        <div className="panel-body stack">
          <ul className="fact-list">
            <li>The <Link href="/policies" style={{ textDecoration: "underline" }}>policy</Link> bound to the holder and the treasury decides the per-payment and daily ceiling.</li>
            <li>Anything above the auto-approve amount needs a person, the same as any other payment.</li>
            <li>Freezing the organization, the treasury, or the holder stops the card with them.</li>
            <li>A card cannot reach a treasury it is not bound to, and cannot move funds another way.</li>
          </ul>
          <Notice tone={locked ? "pending" : "neutral"}>
            <b>None of this is switched on.</b> There is no card provider behind this console, so no control here can be set yet. The policies and freezes it will use already work today for payments.
          </Notice>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head"><div><h2>What Relay will not do</h2></div></header>
        <div className="panel-body">
          <ul className="fact-list">
            <li>No credit and no overdraft. A card can only spend what the treasury holds.</li>
            <li>No reusable card details handed to an autonomous agent.</li>
            <li>No card that spends from a treasury the holder has no claim on.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
