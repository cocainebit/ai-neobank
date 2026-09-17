# AI Neobank

A non-custodial financial control plane for humans and their AI agents.

The product presents one control plane over human-controlled smart accounts:
Squads Protocol on Solana and Safe on EVM. Agents can request payments and may
receive narrowly scoped spending authority, but never own a treasury or an
unrestricted signing key.

## MVP boundary

- Solana devnet and Base Sepolia as the first reference networks
- Squads Protocol v4 for Solana treasury custody and governance
- Safe Protocol for EVM treasury custody and governance
- Native and token transfers on both chain families
- x402 payments on Solana devnet and Base Sepolia
- Deterministic off-chain policy evaluation backed by on-chain spending limits
- Human approvals, transaction simulation, audit history, and emergency freeze
- No fiat custody, bank accounts, payment cards, cash-out, or claims of universal
  merchant acceptance
- No KYC collection because the MVP does not provide regulated fiat services
- No cross-chain bridge in the trust boundary; each treasury remains native to
  its own network

See [docs/PRODUCT-SUITE.md](docs/PRODUCT-SUITE.md),
[docs/BACKEND-ARCHITECTURE.md](docs/BACKEND-ARCHITECTURE.md),
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[DESIGN.md](DESIGN.md), and [docs/INTEGRATION-VERIFICATION.md](docs/INTEGRATION-VERIFICATION.md).

## Status

Architecture plus executable foundation. The monorepo now contains the web app,
Fastify API, PostgreSQL control-plane schema and store, deterministic policy
engine, and EVM/Solana chain adapters. An integration is not considered
supported until its verification gate is checked in
`docs/INTEGRATION-VERIFICATION.md`.

Local native-transfer execution is verified on Anvil and Solana's local
validator. PostgreSQL migration, persistence, idempotency, transactional
outbox/audit writes, and a production-built API read-after-write lifecycle are
also verified locally. Safe, Squads, and x402 remain disabled pending their
dedicated governance/payment lifecycle tests.

The current custody foundation can generate EVM or Solana executor addresses,
bind them to agents, and persist their secret material using AES-256-GCM envelope
encryption. Software signers are disabled by default and intended only for local
development; production deployments must use an HSM/KMS or user wallet. Direct
accounts are likewise a local execution harness, not a substitute for Safe or
Squads governance.
