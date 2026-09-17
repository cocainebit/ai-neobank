create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  environment text not null default 'test' check (environment in ('test', 'production')),
  frozen boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists principals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  type text not null check (type in ('human', 'agent', 'service')),
  display_name text not null,
  role text not null check (role in ('owner', 'approver', 'operator', 'auditor', 'developer', 'agent')),
  status text not null default 'active' check (status in ('active', 'frozen', 'revoked')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table if not exists treasury_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  chain_family text not null check (chain_family in ('evm', 'svm')),
  network text not null check (network ~ '^[a-z0-9]+:[A-Za-z0-9-]+$'),
  address text not null,
  governance text not null check (governance in ('safe', 'squads')),
  status text not null default 'pending_verification' check (status in ('pending_verification', 'active', 'degraded', 'frozen')),
  observed_configuration jsonb not null default '{}'::jsonb,
  last_reconciled_cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, network, address)
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  principal_id uuid not null references principals(id) on delete cascade,
  owner_principal_id uuid references principals(id),
  purpose text not null,
  status text not null default 'active' check (status in ('active', 'frozen', 'revoked')),
  capability_version integer not null default 1 check (capability_version > 0),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, principal_id)
);

create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references policies(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  version integer not null check (version > 0),
  definition jsonb not null,
  definition_hash text not null,
  created_by uuid references principals(id),
  created_at timestamptz not null default now(),
  unique (policy_id, version),
  unique (organization_id, id)
);

create table if not exists policy_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  policy_version_id uuid not null references policy_versions(id),
  agent_id uuid references agents(id) on delete cascade,
  treasury_account_id uuid references treasury_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (agent_id is not null or treasury_account_id is not null)
);

create table if not exists intents (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid not null references treasury_accounts(id),
  requester_principal_id uuid not null references principals(id),
  idempotency_key text not null,
  kind text not null check (kind in ('transfer', 'contract_call', 'x402')),
  network text not null,
  asset_id text not null,
  amount_base_units numeric(78, 0) not null check (amount_base_units > 0),
  destination text not null,
  purpose text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null check (status in ('received', 'validating', 'policy_evaluated', 'rejected', 'compiling', 'simulation_failed', 'approval_required', 'auto_authorized', 'approved', 'executing', 'submitted', 'finalized', 'reconciled', 'failed', 'expired')),
  version integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, requester_principal_id, idempotency_key),
  unique (organization_id, id)
);

create index if not exists intents_org_status_created_idx on intents (organization_id, status, created_at desc);
create index if not exists intents_treasury_created_idx on intents (treasury_account_id, created_at desc);

create table if not exists intent_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  intent_id uuid not null references intents(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  actor_principal_id uuid references principals(id),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (intent_id, sequence)
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_principal_id uuid references principals(id),
  action text not null,
  resource_type text not null,
  resource_id text not null,
  request_id text,
  payload_hash text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx on audit_events (organization_id, created_at desc);

create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  topic text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists outbox_ready_idx on outbox_events (available_at, created_at) where processed_at is null;

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'retry', 'dead')),
  run_at timestamptz not null default now(),
  leased_until timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_ready_idx on jobs (run_at, created_at) where status in ('queued', 'retry');

