# DESIGN.md: Squads-inspired agent treasury

## Source

- Product reference: https://app.squads.so
- Marketing reference: https://squads.xyz
- Capture date: 2026-09-16
- Evidence: Firecrawl branding and public-page captures in `/Users/achi/.firecrawl/`
- Important limitation: authenticated Squads screens require a connected wallet;
  authenticated layouts are treated as interaction inspiration, not copied assets.

## Design summary

Build a quiet, high-density financial operations console. It should feel like a
multisig workspace: persistent organization context, a compact left rail,
ledger-first content, restrained surfaces, and explicit proposal states. Preserve
the usability and spatial rhythm of Squads without reusing its logo, copy,
illustrations, or other proprietary assets.

## Design tokens

### Colors

Observed from the public app shell:

- Canvas: `#E2E2E2`
- Primary text: `#1D1E22`
- Strong text/action: `#000000`
- Raised surface: `#F5F5F5`

Product tokens:

- `--canvas: #e5e5e3`
- `--surface: #f5f5f3`
- `--surface-raised: #ffffff`
- `--text: #1d1e22`
- `--text-muted: #68696d`
- `--border: #d4d4d1`
- `--accent: #2f5cff` (original product accent)
- `--success: #1f8a55`
- `--warning: #a96800`
- `--danger: #c43d3d`

Do not use Squads' blue or brand marks as product identifiers.

### Typography

- Squads app shell observation: Neue Montreal, approximately 15px for headings
  and body UI.
- Squads marketing-site observation: Inter with 56px display headings and 16px
  body text.
- Production rule: use Neue Montreal only if the repository receives a valid web
  font license. Default to Inter Variable until then.
- UI body: 14-15px, 1.4 line height, weight 400.
- Labels/meta: 12px, 1.3 line height, weight 500.
- Page title: 24px, 1.2 line height, weight 500.
- Numeric balances: tabular numerals; 28-36px on overview cards.

### Spacing and layout

- Four-pixel base grid; common spaces: 4, 8, 12, 16, 24, 32.
- Desktop rail: 232px; collapsed rail: 64px.
- Top bar: 56px.
- Main content max width: 1440px with 24px gutters.
- Surface radius: 6px; interactive controls: 8px.
- Borders over shadows. Use a subtle shadow only for menus and blocking dialogs.
- Dense tables use 44px rows and sticky headers.

## Components

- **Organization switcher:** owner avatar, organization name, network and account
  status. It anchors the top of the navigation rail.
- **Navigation rail:** Overview, Treasury, Agents, Proposals, Transactions,
  Policies, Integrations, Developers, Settings.
- **Balance header:** consolidated value, asset balances, deposit action, and a
  highly visible freeze control.
- **Agent row/card:** identity, owner, runtime status, rolling allowance, policy
  summary, last action, and freeze toggle.
- **Proposal table:** requested action, requester, policy result, signatures,
  simulation result, status, and age.
- **Policy editor:** human-readable rule builder with an exact JSON preview.
- **Transaction drawer:** intent, decoded instructions, simulation, signatures,
  on-chain links, receipt, and policy decision trace.
- **Approval dialog:** names the asset, amount, destination, agent, risk flags,
  and resulting authority. Never present opaque transaction blobs as the primary
  approval content.
- **Status pills:** neutral, awaiting approval, approved, executing, completed,
  rejected, expired, failed, frozen.

## Page patterns

1. Persistent rail and organization context.
2. Plain-language page title with one primary action.
3. Summary strip for balances, pending proposals, and current policy exposure.
4. Ledger/table as the dominant content area.
5. Detail opens in a right-side drawer; destructive or signing actions use a
   focused modal.
6. Mobile uses a bottom navigation shell and full-screen detail views. Signing
   remains possible, but policy authoring is desktop-first.

## Content style

- Direct, operational, and specific.
- Prefer `Approve 125 USDC to api.vendor.xyz` over `Confirm transaction`.
- Always distinguish requested, authorized, submitted, finalized, and reconciled.
- Never label devnet assets as money or imply deposit insurance, banking, card
  acceptance, or regulatory approval.

## Agent build instructions

- Use React/Next.js with accessible headless primitives and CSS variables.
- Recreate density, hierarchy, sidebar proportions, tables, and proposal flows;
  do not copy Squads source code or protected brand assets.
- Render amounts with tabular numerals and asset precision.
- Make every action state explicit and replayable from the audit trail.
- Keep agent inference outside signing and policy enforcement components.
- Treat the licensed Neue Montreal font as an optional asset; Inter is the
  checked-in default.

## Rerun inputs

```yaml
workflow: firecrawl-website-design-clone
source_urls:
  - https://app.squads.so
  - https://squads.xyz
target_stack: Next.js + TypeScript
output: DESIGN.md
```

