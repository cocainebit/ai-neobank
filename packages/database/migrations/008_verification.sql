-- Verification (KYB) as a state on the organisation, in the shape the other
-- organisation-wide flags already use (frozen, autonomous_execution).
--
-- No verification provider is connected, so nothing writes 'verified' on its
-- own: the only path to it is a decision a named principal recorded, which is
-- why decided_by and decided_at are here and why method defaults to nothing.
-- Identity documents are never stored: these columns hold a state, a provider
-- case reference, the timestamps, and a short reason.
alter table organizations add column if not exists verification_status text not null default 'unstarted';
alter table organizations drop constraint if exists organizations_verification_status_check;
alter table organizations add constraint organizations_verification_status_check
  check (verification_status in ('unstarted', 'started', 'pending', 'verified', 'rejected', 'expired'));

alter table organizations add column if not exists verification_provider text;
alter table organizations add column if not exists verification_reference text;
alter table organizations add column if not exists verification_method text;
alter table organizations drop constraint if exists organizations_verification_method_check;
alter table organizations add constraint organizations_verification_method_check
  check (verification_method is null or verification_method in ('manual', 'provider'));

alter table organizations add column if not exists verification_started_at timestamptz;
alter table organizations add column if not exists verification_decided_at timestamptz;
alter table organizations add column if not exists verification_decided_by uuid;
alter table organizations add column if not exists verification_reason text;
alter table organizations drop constraint if exists organizations_verification_reason_check;
alter table organizations add constraint organizations_verification_reason_check
  check (verification_reason is null or char_length(verification_reason) <= 500);
alter table organizations add column if not exists verification_expires_at timestamptz;

-- The decider is a principal of this same organisation.
alter table organizations drop constraint if exists organizations_verification_decided_by_fkey;
alter table organizations add constraint organizations_verification_decided_by_fkey
  foreign key (id, verification_decided_by) references principals (organization_id, id);

-- A decided state always names who decided it and when.
alter table organizations drop constraint if exists organizations_verification_decision_check;
alter table organizations add constraint organizations_verification_decision_check
  check (verification_status not in ('verified', 'rejected') or (verification_decided_by is not null and verification_decided_at is not null));
