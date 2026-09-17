-- Format 2 envelopes: the signer secret is sealed under a per-signer data key,
-- and the data key is wrapped by a versioned key-encryption key (local keyring
-- or a KMS key). Rotation re-wraps data keys; the secret ciphertext is unchanged.
alter table signers add column if not exists data_key text;
alter table signers add column if not exists data_key_version text;
-- KMS custody: the private key never leaves the KMS; only its id is stored.
alter table signers add column if not exists kms_key_id text;
alter table signers add column if not exists rotated_at timestamptz;
alter table signers drop constraint if exists signers_kms_key_check;
alter table signers add constraint signers_kms_key_check check ((custody = 'kms') = (kms_key_id is not null));
create index if not exists signers_rewrap_idx on signers (data_key_version) where custody = 'encrypted_software';

-- Replacing a governed treasury's executor. Safe swaps immediately (the
-- executor is never an owner); Squads needs an on-chain config proposal the
-- owners approve, so the rotation has its own lifecycle.
create table if not exists executor_rotations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  treasury_account_id uuid not null,
  from_signer_id uuid not null,
  to_signer_id uuid not null,
  status text not null check (status in ('publishing', 'approval_required', 'executing', 'completed', 'rejected', 'failed')),
  external_ref jsonb,
  publication jsonb,
  failure_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, treasury_account_id) references treasury_accounts (organization_id, id),
  foreign key (organization_id, from_signer_id) references signers (organization_id, id),
  foreign key (organization_id, to_signer_id) references signers (organization_id, id),
  foreign key (organization_id, created_by) references principals (organization_id, id)
);
create unique index if not exists executor_rotations_open_idx on executor_rotations (treasury_account_id)
  where status in ('publishing', 'approval_required', 'executing');
