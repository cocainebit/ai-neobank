# Product suite: the work-money operating system

Research date: 2026-09-16  
Primary audience: global freelancers and 1–50 person digital SMEs  
Product intersection: humans + AI agents + bank/card/stablecoin/machine rails

## Product thesis

Relay should become the financial operating system for people and small
businesses that earn, spend, and automate work globally.

> Get paid through the client's preferred rail, keep operating and tax money
> organized, pay people and software, and let AI handle the financial admin under
> human-owned rules.

The differentiator is not a wallet, a card, a multisig, or an AI chat window. It
is one delegation and evidence layer across every financial actor and rail:

```text
human owner ─┐
team member ─┼─> payment intent -> deterministic controls -> best eligible rail
AI agent ────┘                                      |       |       |       |
                                                bank    card  stablecoin  x402
```

Every action remains attributable to a principal, purpose, policy version,
approval, underlying rail, finality state, receipt, and ledger entry.

## Beachhead

Start with freelancers, agencies, AI consultancies, development studios, and
1–50 person digital SMEs that:

- invoice international clients
- pay global contractors or vendors
- have meaningful SaaS/API/AI spend
- already encounter stablecoins, or would use them if complexity were hidden
- lack a dedicated finance team
- need cleaner records for an accountant

The early economic buyer is the owner. As the customer grows, it becomes the
operations lead, finance manager, controller, or CFO.

## The core loop

```text
Create invoice
    -> client chooses bank/card/stablecoin rail
    -> receive and identify funds
    -> match payment to invoice
    -> split tax/owner-pay/operating reserves
    -> agent prepares follow-up actions
    -> human approves exceptions
    -> ledger, statement, and accounting export remain clean
```

This loop solves a repeated business problem and creates proprietary data for
matching, routing, forecasting, controls, and fraud detection. “Multichain” alone
does not.

## Product surfaces

### Home

- available, pending, reserved, and reversible balances
- invoices due and bills upcoming
- cash runway and expected inflows
- approval inbox
- policy, provider, and reconciliation alerts
- daily AI-prepared cash brief

### Get paid

- professional invoices and hosted payment pages
- unique payment instructions for each client/invoice
- bank/card/open-banking methods where partners support them
- USDC/EURC addresses and QR codes
- exact payer fee, recipient net, expected arrival, and reversibility
- automated reminders and invoice-aging workflows

### Accounts

- familiar USD/EUR/GBP account presentation
- smart pockets for tax/VAT, owner pay, payroll, operating costs, and savings
- underlying bank and stablecoin accounts remain distinct and inspectable
- no fictional omnichain or cross-provider spendable balance
- statements and account-level permissions

### Pay

- saved beneficiaries and verified recipient details
- bank and stablecoin transfers
- bills inbox and document extraction
- scheduled and recurring payments
- contractor and vendor batches
- rail recommendation based on recipient support, fee, arrival, policy, and risk
- human confirmation before any surprising routing or conversion

### Cards and credentials

- human employee/owner cards
- vendor-locked and subscription cards
- single-use agent credentials
- merchant, MCC, amount, geography, time, and velocity controls
- authorization, reversal, partial capture, refund, and dispute lifecycle
- raw PAN/CVC never enters an LLM context

This is an expansion surface after regulated partner onboarding, not part of the
non-custodial launch.

### Agents

- explicit agent identity, owner, purpose, and runtime
- budgets and per-payment/daily/monthly limits
- allowed beneficiaries, merchants, domains, programs, and function selectors
- allowed rails, currencies, networks, schedules, and intent types
- automatic, approval-required, and rejected decision levels
- credential rotation, expiry, revocation, and emergency freeze
- activity, rationale, receipts, and policy-decision history

Initial useful agents:

1. Receivables agent: drafts invoices, monitors aging, sends reminders, matches
   incoming payments.
2. Payables agent: extracts bills, detects duplicates, prepares beneficiaries and
   payment dates.
3. Spend agent: provisions scoped software/API purchasing authority and gathers
   receipts.
4. Cash agent: prepares a daily brief, identifies upcoming shortfalls, and
   recommends movements without executing novel ones autonomously.
5. Close agent: categorizes activity and prepares the accountant export and
   exception queue.

### Activity

- one timeline across bank, card, stablecoin, Safe, Squads, x402, humans, and
  agents
- requested, authorized, submitted, pending, finalized, reversed, disputed, and
  reconciled states remain distinct
- search by client, vendor, project, agent, human, account, rail, or evidence
- receipt, invoice, approval, policy trace, and underlying transaction details

### Reports

- cash-flow summary
- receivables aging
- fees and FX leakage
- spend by vendor, project, team, and agent
- tax/VAT reserve balance
- monthly statements
- CSV and QuickBooks/Xero-compatible exports
- accountant workspace later

Do not claim to provide tax advice or a complete accounting ledger at launch.

### Team and controls

- freelancer mode: owner and accountant
- business mode: owner, operator, approver, finance, auditor, developer, agent
- maker-checker and amount-based approval rules
- beneficiary-change step-up
- passkey/wallet approval
- recovery, device/session management, global freeze, and immutable audit export

### Developer

- agent API and MCP server
- quote, payment-intent, status, balance, and receipt tools
- webhooks, idempotency, sandbox, and policy explanation
- x402/MPP for machine services
- no arbitrary raw-transaction endpoint

## Minimum lovable product

The non-custodial MLP should ship as one coherent work-account loop:

1. Human-owned USDC accounts on Base and Solana.
2. Clients and beneficiaries.
3. Invoices and stablecoin payment links.
4. Payment receipt identification and invoice matching.
5. Smart pockets for taxes, owner pay, and operating funds.
6. Human and agent roles with deterministic policies.
7. Approval inbox with semantic transaction simulation.
8. Wallet, beneficiary, and x402 payments.
9. Unified activity, evidence, statements, and accounting export.
10. Invoice reminders, bill extraction, duplicate detection, and daily cash brief.
11. Durable ledger, reconciliation, recovery, and emergency freeze.

The lovable demonstration:

> A freelancer receives USDC for an invoice. Relay matches it, allocates the tax
> reserve, and finds three vendor bills. One is rejected as a duplicate, one is
> prepared for approval, and one known low-value service is paid within policy.
> The owner receives a clean receipt and statement without touching chain UX.

## Regulated expansion

Once a sponsor/regulated partner is secured and customers complete required
identity verification:

- sponsored USD/EUR/GBP accounts and local account details
- ACH, SEPA, Faster Payments, wires, and regulated on/off-ramp
- virtual and physical cards
- single-use agent cards
- FX quotes and rule-based routing
- mobile approval and card controls
- deeper QuickBooks/Xero sync

Subsequent SME expansion:

- purchase requests and approval routing
- vendor onboarding and tax-document collection
- subscription discovery and renewal controls
- contractor onboarding and mass payouts through compliance partners
- purchase orders and two-/three-way matching
- month-end close workspace
- project/client/entity budgets
- multi-entity and intercompany accounting

Partner payroll and contractor tax infrastructure rather than rebuilding national
tax engines.

## What not to launch

- lending, credit underwriting, yield, staking, or leverage
- token trading or generic DeFi
- hidden cross-chain bridging
- autonomous swaps or treasury trading
- unrestricted browser agents with reusable card details
- full ERP, procurement, payroll, or accounting replacement
- “AI CFO” claims
- “global bank account,” “spend anywhere,” or “non-KYC neobank” claims

## Information architecture

Primary navigation:

```text
Home
Get paid
Pay
Accounts
Agents
Activity
Reports
```

Secondary navigation:

```text
Team & approvals
Security
Connections
Developer
Settings
```

Do not put chains, multisig, x402, or proposals in primary navigation. Approval
requests appear contextually in Home and Pay. Network details belong in an
expandable receipt or advanced account view.

## Payment-routing model

Normalize the intent, not the balance:

```text
“Pay contractor X $1,250 by Friday”
                 |
        identity and policy
                 |
       recipient capabilities
                 |
   fee / ETA / reversibility / risk
                 |
 ACH | wire | local rail | card | stablecoin | x402
                 |
      finality, receipt, ledger, reconciliation
```

The user can override a recommended rail where policy allows. The product never
hides a conversion, fee, bridge, irreversible action, or reduced dispute right.

## Launch geography

Research supports two separate stages:

1. Non-custodial product: available only where legal review permits self-hosted
   wallet software; no promise of fiat conversion or local banking.
2. Neobank product: initially target verified US freelancers, sole proprietors,
   and US entities using a sponsor/regulated banking and issuing stack, with
   supported global contractor/vendor payouts.

Expand to the UK/EEA only after explicit EMI/issuing coverage, then selected
LATAM corridors through local regulated partners. Optimize specific corridors;
do not claim theoretical global coverage.

## Packaging

Recommended starting bands, subject to customer interviews and partner costs:

| Plan | Price | Shape |
| --- | ---: | --- |
| Solo | $0–19/month | one human, two agents, invoices, pockets, statements, basic automation |
| Business | $49–79/month | five humans, ten agents, approvals, bills, accounting sync, API |
| Scale | $149–299/month | more humans/agents, multi-entity, advanced controls and reporting |
| Platform | custom | embedded accounts, SSO/SCIM, retention, SLA, white-label APIs |

Charge per active agent rather than every created agent. Add transparent fees for
FX, card acceptance, instant payout, international payout, and payment execution.
Do not rely on interchange as the primary business model.

## Competitive position

- Wise/Payoneer: global receiving and payout utilities
- Mercury: founder-friendly US banking and workflow baseline
- Ramp/Brex: spend, cards, AP, procurement, and finance automation
- Airwallex/Revolut: multicurrency accounts, cards, FX, and global operations
- Deel/Gusto: contractor and workforce compliance
- Crossmint/Skyfire/Nevermined/Catena: agent payment and governance primitives
- Safe/Squads: smart-account custody and approval substrates

Relay must not try to beat each product feature-for-feature. Its wedge is:

> A universal delegation, routing, and evidence layer for financial work carried
> out by humans and machines, packaged as a simple work-money account.

The defensible assets are the authorization graph, labeled intent and outcome
history, cross-rail reconciliation, accounting/AP integrations, fraud/risk
signals, and partner/network approvals. The dashboard and wallet are not a moat.

## Source anchors

- [Wise freelancer business account](https://wise.com/us/business/freelancer)
- [Mercury pricing](https://mercury.com/pricing)
- [Ramp pricing](https://ramp.com/pricing)
- [Ramp agentic payments](https://agents.ramp.com/docs/guides/agentic-payments)
- [Brex](https://www.brex.com/)
- [Airwallex pricing example](https://www.airwallex.com/en-sg/pricing?topics=business_banking)
- [Revolut business expense cards](https://www.revolut.com/business/cards/business-expense-cards/)
- [Deel stablecoin wallet](https://www.deel.com/blog/introducing-stablecoin-wallet/)
- [Gusto embedded contractor APIs](https://docs.gusto.com/embedded-payroll/docs/manage-contractors)
- [Stripe agentic commerce](https://stripe.com/use-cases/agentic-commerce)
- [Visa Intelligent Commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce)
- [Mastercard Agent Pay](https://www.mastercard.com/us/en/business/artificial-intelligence/mastercard-agent-pay.html)
- [Crossmint agentic cards](https://www.crossmint.com/products/agentic-cards)
- [FinCEN convertible virtual currency guidance](https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-persons-administering)
- [EBA Travel Rule guidance](https://www.eba.europa.eu/publications-and-media/press-releases/eba-issues-travel-rule-guidance-tackle-money-laundering-and-terrorist-financing-transfers-funds-and)

