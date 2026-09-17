-- Governed treasuries (Safe, Squads): the organisation designates an executor
-- signer that is never an owner. It submits what the owners have approved.
alter table treasury_accounts add column if not exists executor_signer_id uuid;
alter table treasury_accounts add constraint treasury_executor_org_fk
  foreign key (organization_id, executor_signer_id) references signers (organization_id, id);

-- Where the approval lives outside the database: the Safe transaction hash and
-- parameters, or the Squads multisig, transaction index, and proposal account.
alter table approval_requests add column if not exists external_ref jsonb;

-- The wallet that produced an approval signature or on-chain vote.
alter table approvals add column if not exists signer_address text;

-- Squads publication is tracked before anything is broadcast so a retry can
-- find the proposal it already created.
alter table intents drop constraint if exists intents_status_check;
alter table intents add constraint intents_status_check
  check (status in ('received', 'validating', 'policy_evaluated', 'rejected', 'compiling', 'simulation_failed', 'approval_required', 'auto_authorized', 'approved', 'executing', 'submitted', 'finalized', 'reconciled', 'failed', 'expired'));
alter table intents add column if not exists publication jsonb;

-- On-chain votes can come from a wallet the organisation has not registered as
-- a principal; they still count toward the on-chain threshold.
alter table approvals alter column approver_principal_id drop not null;
create unique index if not exists approvals_signer_idx on approvals (intent_id, signer_address) where signer_address is not null;
