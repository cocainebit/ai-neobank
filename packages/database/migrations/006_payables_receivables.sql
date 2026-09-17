-- Beneficiaries: saved, owner-approved recipients. Policies can require them.
create table if not exists beneficiaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  chain_family text not null check (chain_family in ('evm', 'svm')),
  network text not null,
  address text not null,
  email text,
  notes text,
  status text not null default 'pending' check (status in ('pending', 'active', 'archived')),
  created_by uuid,
  approved_by uuid,
  approval_signature text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, network, address),
  unique (organization_id, id),
  foreign key (organization_id, created_by) references principals (organization_id, id),
  foreign key (organization_id, approved_by) references principals (organization_id, id)
);

-- Recurring payments create ordinary intents, so policy and approval apply to every occurrence.
create table if not exists payment_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid not null,
  beneficiary_id uuid not null,
  requester_principal_id uuid not null,
  asset_id text not null references assets(id),
  amount_base_units numeric(78, 0) not null check (amount_base_units > 0),
  purpose text not null,
  interval_unit text not null check (interval_unit in ('day', 'week', 'month')),
  interval_count integer not null default 1 check (interval_count between 1 and 365),
  start_at timestamptz not null,
  end_at timestamptz,
  max_occurrences integer check (max_occurrences is null or max_occurrences > 0),
  next_run_at timestamptz not null,
  occurrences_created integer not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id),
  foreign key (organization_id, beneficiary_id) references beneficiaries (organization_id, id),
  foreign key (organization_id, requester_principal_id) references principals (organization_id, id)
);
create index if not exists payment_schedules_due_idx on payment_schedules (next_run_at) where status = 'active';

alter table intents add column if not exists beneficiary_id uuid;
alter table intents add column if not exists schedule_id uuid;
alter table intents add column if not exists occurrence integer;
alter table intents add constraint intents_beneficiary_org_fk foreign key (organization_id, beneficiary_id) references beneficiaries (organization_id, id);
alter table intents add constraint intents_schedule_org_fk foreign key (organization_id, schedule_id) references payment_schedules (organization_id, id);
create unique index if not exists intents_schedule_occurrence_idx on intents (schedule_id, occurrence) where schedule_id is not null;

-- Receivables.
alter table organizations add column if not exists invoice_sequence integer not null default 0;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  number text not null,
  treasury_account_id uuid not null,
  asset_id text not null references assets(id),
  network text not null,
  customer_name text not null,
  customer_email text,
  memo text,
  line_items jsonb not null,
  subtotal_base_units numeric(78, 0) not null check (subtotal_base_units > 0),
  -- EVM token invoices add a sub-cent identifier so the payment can be matched from its amount.
  amount_due_base_units numeric(78, 0) not null check (amount_due_base_units >= subtotal_base_units),
  amount_paid_base_units numeric(78, 0) not null default 0,
  -- Solana: a reference public key included in the payment transaction (Solana Pay).
  reference text,
  public_token text not null unique,
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void')),
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  unique (organization_id, id),
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id),
  foreign key (organization_id, created_by) references principals (organization_id, id)
);
create index if not exists invoices_open_idx on invoices (treasury_account_id, asset_id, amount_due_base_units) where status = 'open';
create unique index if not exists invoices_reference_idx on invoices (reference) where reference is not null;

-- What the chain says came in. The indexer's output; invoices and the ledger are fed from here.
create table if not exists treasury_inflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid not null,
  network text not null,
  asset_id text not null,
  transaction_hash text not null,
  event_key text not null,
  amount_base_units numeric(78, 0) not null check (amount_base_units > 0),
  from_address text,
  block_cursor text,
  invoice_id uuid,
  method text not null default 'transfer' check (method in ('transfer', 'x402')),
  observed_at timestamptz not null default now(),
  unique (network, transaction_hash, asset_id, event_key),
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
create index if not exists treasury_inflows_treasury_idx on treasury_inflows (treasury_account_id, observed_at desc);

-- Per treasury and asset: where the indexer has read to.
create table if not exists treasury_sync_cursors (
  treasury_account_id uuid not null references treasury_accounts(id) on delete cascade,
  asset_id text not null,
  cursor text not null,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (treasury_account_id, asset_id)
);

-- Chain balance against ledger balance, per sync.
create table if not exists reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid not null references treasury_accounts(id) on delete cascade,
  asset_id text not null,
  chain_balance_base_units numeric(78, 0) not null,
  ledger_balance_base_units numeric(78, 0) not null,
  pending_outbound_base_units numeric(78, 0) not null,
  difference_base_units numeric(78, 0) not null,
  status text not null check (status in ('matched', 'break')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists reconciliation_runs_latest_idx on reconciliation_runs (treasury_account_id, asset_id, created_at desc);
