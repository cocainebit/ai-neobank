-- The verification application: what an owner says about the ENTITY, and the
-- attestation they signed when they sent it for review.
--
-- Nothing here is checked against anything. Floatlane has no verification
-- provider connected, so a row is a claim the owner made and signed with a
-- wallet already bound to them, plus the exact text they signed, so a reviewer
-- can read what was claimed and a later reader can re-check the signature.
--
-- Entity facts only: legal name, entity type, registration number,
-- jurisdiction, registered address, website and the business in the owner's own
-- words, all of it public register data. No control person, no date of birth,
-- no government identifier, no document, no scan and no photograph. Control
-- persons are disclosed to a provider on the day one exists, and they are not
-- stored here even then.
--
-- Safe to run twice: every statement is conditional.
create table if not exists verification_cases (
  organization_id uuid primary key references organizations(id) on delete cascade,
  -- The draft the owner is filling in. Written through the profile schema, so a
  -- free-text field here has already been refused a long digit run or a data URL.
  profile jsonb,
  -- The submission. All of it or none of it: see the constraint below.
  attestation_statement text,
  attestation_signature text,
  attestation_address text,
  attestation_chain_family text,
  submitted_at timestamptz,
  submitted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table verification_cases add column if not exists profile jsonb;
alter table verification_cases add column if not exists attestation_statement text;
alter table verification_cases add column if not exists attestation_signature text;
alter table verification_cases add column if not exists attestation_address text;
alter table verification_cases add column if not exists attestation_chain_family text;
alter table verification_cases add column if not exists submitted_at timestamptz;
alter table verification_cases add column if not exists submitted_by uuid;

alter table verification_cases drop constraint if exists verification_cases_profile_object_check;
alter table verification_cases add constraint verification_cases_profile_object_check
  check (profile is null or jsonb_typeof(profile) = 'object');

-- Both chain families the console signs with, and nothing else.
alter table verification_cases drop constraint if exists verification_cases_chain_family_check;
alter table verification_cases add constraint verification_cases_chain_family_check
  check (attestation_chain_family is null or attestation_chain_family in ('evm', 'svm'));

-- A submission is all of its parts or none of them. A signature with no
-- statement proves nothing, and a statement with no signer is not an
-- attestation, so a half-written row is refused rather than displayed.
alter table verification_cases drop constraint if exists verification_cases_submission_check;
alter table verification_cases add constraint verification_cases_submission_check
  check (
    (submitted_at is null and submitted_by is null and attestation_statement is null
      and attestation_signature is null and attestation_address is null and attestation_chain_family is null)
    or (submitted_at is not null and submitted_by is not null and attestation_statement is not null
      and attestation_signature is not null and attestation_address is not null and attestation_chain_family is not null)
  );

-- The submitter is a principal of this same organisation.
alter table verification_cases drop constraint if exists verification_cases_submitted_by_fkey;
alter table verification_cases add constraint verification_cases_submitted_by_fkey
  foreign key (organization_id, submitted_by) references principals (organization_id, id);
