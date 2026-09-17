alter table jobs add column if not exists dedupe_key text;
create unique index if not exists jobs_dedupe_idx on jobs(dedupe_key) where dedupe_key is not null;

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  intent_id uuid not null references intents(id) on delete cascade,
  required_approvals integer not null default 1 check (required_approvals > 0),
  compiled_hash text,
  simulation_hash text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(intent_id)
);

create index if not exists approval_requests_pending_idx on approval_requests(expires_at) where status = 'pending';
