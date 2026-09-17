alter table treasury_accounts drop constraint if exists treasury_accounts_governance_check;
alter table treasury_accounts add constraint treasury_accounts_governance_check
  check (governance in ('safe', 'squads', 'direct'));

create table if not exists signers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  chain_family text not null check (chain_family in ('evm', 'svm')),
  address text not null,
  custody text not null check (custody in ('encrypted_software', 'external_wallet', 'kms')),
  encrypted_secret text,
  encryption_nonce text,
  auth_tag text,
  key_version integer,
  status text not null default 'active' check (status in ('active', 'frozen', 'revoked')),
  created_at timestamptz not null default now(),
  unique (organization_id, chain_family, address),
  check ((custody = 'encrypted_software') = (encrypted_secret is not null))
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  intent_id uuid not null references intents(id) on delete cascade,
  approver_principal_id uuid not null references principals(id),
  decision text not null check (decision in ('approved', 'rejected')),
  signed_payload text,
  created_at timestamptz not null default now(),
  unique (intent_id, approver_principal_id)
);

create table if not exists executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  intent_id uuid not null references intents(id) on delete cascade,
  signer_id uuid references signers(id),
  network text not null,
  compiled_payload jsonb not null,
  compiled_hash text not null,
  simulation jsonb not null,
  status text not null check (status in ('simulated', 'submitted', 'finalized', 'failed')),
  transaction_hash text,
  block_cursor text,
  fee_base_units numeric(78,0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (intent_id)
);

create table if not exists ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid references treasury_accounts(id),
  code text not null,
  name text not null,
  asset_id text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, code, asset_id)
);

create table if not exists ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  intent_id uuid references intents(id),
  external_reference text,
  description text not null,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, external_reference)
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references ledger_transactions(id) on delete cascade,
  account_id uuid not null references ledger_accounts(id),
  direction text not null check (direction in ('debit', 'credit')),
  amount_base_units numeric(78,0) not null check (amount_base_units > 0),
  created_at timestamptz not null default now()
);

create index if not exists approvals_intent_idx on approvals(intent_id, created_at);
create index if not exists executions_status_idx on executions(status, updated_at);
