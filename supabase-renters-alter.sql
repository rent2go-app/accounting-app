-- ============================================================
-- Rent 2 Go — renters: additive columns only
-- Paste into: Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- ADDITIVE ONLY. No create table, no drop, no policy changes, no triggers.
-- Nothing here can remove or overwrite existing data.
--
-- Why: the signup wizard collects three things the shared `renters` schema
-- has nowhere to put — proof of address, the signed rental agreement, and
-- the six acknowledgements. The renter-facing copy states that proof of
-- address is "mandatory for insurance purposes", so it has to be storable.
-- Per HARD RULE 3 in MERGE-PROMPT.md this is a request to extend the shared
-- schema rather than something the prototype should work around.
-- ============================================================

alter table renters
  -- proof of address (file lives in the renter-docs bucket; this is its key)
  add column if not exists proof_path    text,
  add column if not exists proof_name    text,
  -- signed rental agreement
  add column if not exists signature     text,
  add column if not exists agreed_at     timestamptz,
  -- the six pre-signup acknowledgements, as {"0":true,...}
  add column if not exists questionnaire jsonb default '{}'::jsonb,
  -- how the row was created: 'admin' | 'prototype' | 'self'
  add column if not exists signup_source text default 'admin';

-- ------------------------------------------------------------
-- updated_at — deliberately NULLABLE with no default.
--
-- Adding it NOT NULL DEFAULT now() would stamp every existing row with the
-- moment this runs, making old records read as "just updated". Nullable
-- costs nothing here because every writer already sets it explicitly:
-- id-verify, id-webhook and renter-intake all send updated_at in their PATCH.
--
-- NOTE — worth checking: those functions PATCH `updated_at` today. If the
-- column does not already exist, PostgREST rejects the whole PATCH, and none
-- of those functions inspect the response — so the write would be failing
-- silently. Running this removes that failure mode either way.
-- ------------------------------------------------------------
alter table renters
  add column if not exists updated_at timestamptz;

-- ------------------------------------------------------------
-- Storage for proof-of-address files. Private bucket, signed URLs only.
-- Bucket creation is additive; no policies are replaced here. If you later
-- want renters to upload their own proof, add a policy then — deliberately
-- not doing it now, because renters are anonymous in the intake flow.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('renter-docs', 'renter-docs', false)
on conflict (id) do nothing;

-- Verify:
--   select column_name from information_schema.columns
--   where table_name = 'renters' order by ordinal_position;
