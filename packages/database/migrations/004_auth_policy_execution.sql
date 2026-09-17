-- Organisation-scoped composite keys so a record can never reference another
-- organisation's treasury, principal, or agent.
alter table treasury_accounts add constraint treasury_accounts_org_id_unique unique (organization_id, id);
alter table agents add constraint agents_org_id_unique unique (organization_id, id);
alter table signers add constraint signers_org_id_unique unique (organization_id, id);

alter table intents add constraint intents_treasury_org_fk
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id);
alter table intents add constraint intents_requester_org_fk
  foreign key (organization_id, requester_principal_id) references principals (organization_id, id);
alter table agents add constraint agents_principal_org_fk
  foreign key (organization_id, principal_id) references principals (organization_id, id) on delete cascade;
alter table signers add constraint signers_agent_org_fk
  foreign key (organization_id, agent_id) references agents (organization_id, id) on delete set null;
alter table approvals add constraint approvals_approver_org_fk
  foreign key (organization_id, approver_principal_id) references principals (organization_id, id);
alter table executions add constraint executions_signer_org_fk
  foreign key (organization_id, signer_id) references signers (organization_id, id);
alter table policy_bindings add constraint policy_bindings_agent_org_fk
  foreign key (organization_id, agent_id) references agents (organization_id, id) on delete cascade;
alter table policy_bindings add constraint policy_bindings_treasury_org_fk
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id) on delete cascade;
alter table policy_bindings add constraint policy_bindings_version_org_fk
  foreign key (organization_id, policy_version_id) references policy_versions (organization_id, id);

-- Wallet identity for humans. A wallet may belong to several organisations, one principal each.
create table if not exists human_wallets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  principal_id uuid not null,
  chain_family text not null check (chain_family in ('evm', 'svm')),
  address text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, principal_id) references principals (organization_id, id) on delete cascade,
  unique (organization_id, chain_family, address)
);
create index if not exists human_wallets_lookup_idx on human_wallets (chain_family, address);

create table if not exists auth_challenges (
  nonce text primary key,
  chain_family text not null check (chain_family in ('evm', 'svm')),
  address text not null,
  domain text not null,
  message text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  organization_id uuid not null references organizations(id) on delete cascade,
  principal_id uuid not null,
  wallet_id uuid references human_wallets(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (organization_id, principal_id) references principals (organization_id, id) on delete cascade
);
create index if not exists sessions_principal_idx on sessions (principal_id) where revoked_at is null;

-- Agent runtimes authenticate with a key whose secret is stored only as a hash.
create table if not exists agent_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  agent_id uuid not null,
  key_id text not null unique,
  secret_hash text not null,
  label text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (organization_id, agent_id) references agents (organization_id, id) on delete cascade,
  foreign key (organization_id, created_by) references principals (organization_id, id)
);

-- Policy on the durable path.
alter table organizations add column if not exists autonomous_execution boolean not null default false;
alter table policy_versions add column if not exists status text not null default 'active' check (status in ('active', 'retired'));
alter table intents add column if not exists policy_version_id uuid references policy_versions(id);
alter table intents add column if not exists policy_decision jsonb;
alter table intents add column if not exists failure_reason text;
create unique index if not exists policy_bindings_agent_unique on policy_bindings (organization_id, agent_id)
  where agent_id is not null and treasury_account_id is null;
create unique index if not exists policy_bindings_treasury_unique on policy_bindings (organization_id, treasury_account_id)
  where treasury_account_id is not null and agent_id is null;

-- Assets the compiler may move. Native coins are seeded per network on first use.
create table if not exists assets (
  id text primary key,
  network text not null,
  chain_family text not null check (chain_family in ('evm', 'svm')),
  kind text not null check (kind in ('native', 'erc20', 'spl')),
  address text,
  symbol text not null,
  decimals integer not null check (decimals between 0 and 36),
  created_at timestamptz not null default now(),
  unique (network, kind, address)
);

-- Executions are signed and recorded before anything is broadcast, so a crash
-- between signing and sending can be resolved from the stored hash.
alter table executions drop constraint if exists executions_status_check;
alter table executions add constraint executions_status_check
  check (status in ('simulated', 'signed', 'submitted', 'finalized', 'failed'));
alter table executions add column if not exists signed_payload text;
alter table executions add column if not exists nonce text;
alter table executions add column if not exists valid_until text;
alter table executions add column if not exists broadcast_at timestamptz;
alter table executions add column if not exists confirmations integer;
alter table executions add column if not exists observed jsonb;

-- Ledger accounts are per treasury; expense accounts included.
alter table ledger_accounts drop constraint if exists ledger_accounts_organization_id_code_asset_id_key;
create unique index if not exists ledger_accounts_scope_idx on ledger_accounts
  (organization_id, coalesce(treasury_account_id, '00000000-0000-0000-0000-000000000000'::uuid), code, asset_id);
