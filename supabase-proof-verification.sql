-- Result of the automated proof-of-address check.
--
-- The renter uploads a document and types a name and address. Until now nobody
-- compared the two until a person opened the file by hand, which on a launch
-- weekend means not at all.
--
-- Three verdicts, deliberately not two. A file that is not a proof of address is
-- a clear reject. A name or address that does not quite line up is not: people
-- have bills in a spouse's name, maiden names, a flat number the form dropped.
-- Auto-rejecting those turns away paying customers, so they go to a human.

alter table public.renters add column if not exists proof_verdict     text;   -- accept | review | reject
alter table public.renters add column if not exists proof_reason      text;
alter table public.renters add column if not exists proof_doc_type    text;   -- utility bill, bank statement...
alter table public.renters add column if not exists proof_doc_date    text;
alter table public.renters add column if not exists proof_name_seen   text;
alter table public.renters add column if not exists proof_addr_seen   text;
alter table public.renters add column if not exists address_match     boolean;
alter table public.renters add column if not exists proof_checked_at  timestamptz;

create index if not exists renters_proof_verdict_idx on public.renters(proof_verdict);

-- what the office needs to see at a glance
drop view if exists public.v_proof_checks;
create view public.v_proof_checks as
select r.id, r.name, r.email, r.created_at,
       r.proof_verdict, r.proof_reason, r.proof_doc_type, r.proof_doc_date,
       r.name_match, r.address_match,
       r.proof_name_seen, r.proof_addr_seen,
       concat_ws(', ', r.home_address, r.home_city, r.home_state, r.home_postal) as address_given,
       r.proof_name, r.proof_path, r.proof_checked_at, r.decision, r.needs_review, r.review_reason
  from public.renters r
 where r.proof_path is not null;

grant select on public.v_proof_checks to authenticated;
notify pgrst, 'reload schema';
