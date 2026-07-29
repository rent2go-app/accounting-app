-- ============================================================
-- Rent 2 Go — Team / Rental-Coordinator tasks & payouts
-- Paste into: Supabase → SQL Editor → New query → Run
-- Safe to re-run (idempotent).
--
-- SCOPE: creates only new `team_*` objects. Touches NOTHING that
-- Linda (linda_*), the ledger (day_blocks), owners_program or fleet use.
-- ============================================================

-- ---- Who counts as an admin ---------------------------------
-- Mirrors the ADMINS array in the pages and ADMIN_EMAILS in the
-- admin-users edge function. Add an email here AND in both of those.
create or replace function r2g_is_admin() returns boolean
language sql stable as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') in (
      'gorentaride@gmail.com',
      'thurstonrdavis@gmail.com',
      'thandobnkala@gmail.com'
    ), false);
$$;

-- ---- Team members (coordinators, vendors, managers) ---------
-- auth_uid links a member to a Supabase login. Leave NULL until you
-- actually issue that person a login (see the RLS warning at the end).
create table if not exists team_members (
  id          uuid primary key default gen_random_uuid(),
  auth_uid    uuid unique references auth.users(id) on delete set null,
  name        text not null default '',
  role        text not null default 'RC' check (role in ('SA','MM','RC','V')),
  email       text,
  phone       text,
  whatsapp    text,
  pay_method  text default 'CashApp',
  hours       text,
  other_work  text,
  avatar_url  text,
  approved    boolean not null default true,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists team_members_role_idx on team_members(role);

-- ---- Task price list ----------------------------------------
create table if not exists team_task_catalog (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  price      numeric(10,2) not null default 0,
  per_mile   numeric(10,2) not null default 0,
  kind       text not null default 'standard' check (kind in ('standard','distance','wait')),
  manual     boolean not null default false,   -- price typed in per job
  sort_order int not null default 0,
  active     boolean not null default true
);

-- ---- Assigned tasks -----------------------------------------
-- evidence: [{path,form,name}]  — path is a key in the team-evidence bucket
-- costs:    [{kind,amount,when,note}]
-- stops:    ["start addr","stop","end addr"]
-- date_log: [{from,to,by,when}]
create table if not exists team_tasks (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references team_members(id) on delete cascade,
  day          date not null default (now() at time zone 'America/New_York')::date,
  title        text not null default '',
  detail       text default '',
  status       text not null default 'scheduled' check (status in ('scheduled','started','done')),
  kind         text not null default 'standard' check (kind in ('standard','distance','wait')),
  payout       numeric(10,2) not null default 0,
  per_mile     numeric(10,2) not null default 0,
  miles        numeric(10,1) not null default 0,
  stops        jsonb not null default '[]'::jsonb,
  car_id       text,          -- matches owners_program cars + ledger expense carId
  car_name     text,
  time_mode    text not null default 'flexible' check (time_mode in ('flexible','fixed')),
  fixed_time   text,
  due_by       text,
  started_at   timestamptz,
  finished_at  timestamptz,
  elapsed_sec  int not null default 0,
  notes        text default '',
  evidence     jsonb not null default '[]'::jsonb,
  costs        jsonb not null default '[]'::jsonb,
  date_log     jsonb not null default '[]'::jsonb,
  paid         boolean not null default false,
  payout_id    uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists team_tasks_member_day_idx on team_tasks(member_id, day);
create index if not exists team_tasks_day_idx        on team_tasks(day);
create index if not exists team_tasks_unpaid_idx     on team_tasks(member_id) where status='done' and paid=false;

-- ---- Payouts (one per member per day) -----------------------
-- proof_path is REQUIRED by the UI: no payout is recorded without a screenshot.
-- ledger_posted stays false until the amount is pushed into day_blocks.
create table if not exists team_payouts (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references team_members(id) on delete cascade,
  day           date not null,
  amount        numeric(10,2) not null default 0,
  method        text not null default 'CashApp',
  ref           text,
  proof_path    text,
  task_count    int not null default 0,
  paid_by       text,
  ledger_posted boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index if not exists team_payouts_member_day_uq on team_payouts(member_id, day);

-- ---- Expense reimbursement requests -------------------------
create table if not exists team_refunds (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references team_members(id) on delete cascade,
  kind         text not null default 'Other',
  amount       numeric(10,2) not null default 0,
  detail       text default '',
  receipt_path text,
  status       text not null default 'Pending' check (status in ('Pending','Approved','Declined','Paid')),
  created_at   timestamptz not null default now()
);
create index if not exists team_refunds_member_idx on team_refunds(member_id);

-- ---- keep updated_at fresh ----------------------------------
create or replace function team_touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists trg_touch_team_members on team_members;
create trigger trg_touch_team_members before update on team_members
  for each row execute function team_touch_updated_at();

drop trigger if exists trg_touch_team_tasks on team_tasks;
create trigger trg_touch_team_tasks before update on team_tasks
  for each row execute function team_touch_updated_at();

-- ---- Seed the price list (only if empty) --------------------
insert into team_task_catalog (name, price, per_mile, kind, manual, sort_order)
select * from (values
  ('Travel @ $1/mile',              0::numeric, 1::numeric, 'distance',  false,  1),
  ('Standard cleaning',            10,          0,          'standard',  false,  2),
  ('Extra cleaning',               15,          0,          'standard',  false,  3),
  ('Ozone machine',                10,          0,          'standard',  false,  4),
  ('Interior shampoo',             20,          0,          'standard',  false,  5),
  ('Mail pick up / sort',          15,          0,          'standard',  false,  6),
  ('Key cutting',                  15,          0,          'standard',  false,  7),
  ('Vehicle refueling',             5,          0,          'standard',  false,  8),
  ('Vehicle recovery',             20,          0,          'distance',  false,  9),
  ('Headlight / taillight install',15,          0,          'standard',  false, 10),
  ('Vehicle state inspection',     15,          0,          'standard',  false, 11),
  ('Vehicle roadside set up',      10,          0,          'standard',  false, 12),
  ('Return vehicle inspection',    10,          0,          'standard',  false, 13),
  ('Registration print',           10,          0,          'standard',  false, 14),
  ('New intake inspection',        15,          0,          'standard',  false, 15),
  ('Checklist inspection',         10,          0,          'standard',  false, 16),
  ('DMV vehicle registration',     20,          0,          'standard',  false, 17),
  ('Miscellaneous Task',            0,          0,          'standard',  true,  18),
  ('Errands',                       0,          0,          'distance',  true,  19)
) as v(name, price, per_mile, kind, manual, sort_order)
where not exists (select 1 from team_task_catalog);

-- ============================================================
-- Row Level Security
--   Admins  -> full access to everything.
--   Members -> their OWN rows only, matched via team_members.auth_uid.
-- ============================================================
alter table team_members      enable row level security;
alter table team_task_catalog enable row level security;
alter table team_tasks        enable row level security;
alter table team_payouts      enable row level security;
alter table team_refunds      enable row level security;

-- helper: the caller's member row id (null if they aren't a team member)
create or replace function r2g_my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from team_members where auth_uid = auth.uid() limit 1;
$$;

-- team_members
drop policy if exists "team_members admin all" on team_members;
create policy "team_members admin all" on team_members
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
drop policy if exists "team_members read self" on team_members;
create policy "team_members read self" on team_members
  for select to authenticated using (auth_uid = auth.uid());

-- price list: everyone signed in can read it; only admins edit
drop policy if exists "catalog read" on team_task_catalog;
create policy "catalog read" on team_task_catalog
  for select to authenticated using (true);
drop policy if exists "catalog admin write" on team_task_catalog;
create policy "catalog admin write" on team_task_catalog
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());

-- tasks: admin all; member may read + update their own
-- (members must NOT be able to change their own payout — enforced by trigger below)
drop policy if exists "tasks admin all" on team_tasks;
create policy "tasks admin all" on team_tasks
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
drop policy if exists "tasks member read" on team_tasks;
create policy "tasks member read" on team_tasks
  for select to authenticated using (member_id = r2g_my_member_id());
drop policy if exists "tasks member update" on team_tasks;
create policy "tasks member update" on team_tasks
  for update to authenticated
  using (member_id = r2g_my_member_id())
  with check (member_id = r2g_my_member_id());

-- a member can work a task but never re-price it or mark it paid
create or replace function team_tasks_guard() returns trigger as $$
begin
  if r2g_is_admin() then return new; end if;
  new.payout    := old.payout;
  new.per_mile  := old.per_mile;
  new.miles     := old.miles;
  new.paid      := old.paid;
  new.payout_id := old.payout_id;
  new.member_id := old.member_id;
  new.day       := old.day;
  return new;
end; $$ language plpgsql;
drop trigger if exists trg_team_tasks_guard on team_tasks;
create trigger trg_team_tasks_guard before update on team_tasks
  for each row execute function team_tasks_guard();

-- payouts: admin writes, member reads their own
drop policy if exists "payouts admin all" on team_payouts;
create policy "payouts admin all" on team_payouts
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
drop policy if exists "payouts member read" on team_payouts;
create policy "payouts member read" on team_payouts
  for select to authenticated using (member_id = r2g_my_member_id());

-- refunds: admin all; member reads own + raises own
drop policy if exists "refunds admin all" on team_refunds;
create policy "refunds admin all" on team_refunds
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
drop policy if exists "refunds member read" on team_refunds;
create policy "refunds member read" on team_refunds
  for select to authenticated using (member_id = r2g_my_member_id());
drop policy if exists "refunds member insert" on team_refunds;
create policy "refunds member insert" on team_refunds
  for insert to authenticated with check (member_id = r2g_my_member_id());

-- ============================================================
-- Storage: evidence photos + payout proof screenshots
-- Path convention:  <member_id>/<task_id>/<file>
--                   <member_id>/payouts/<payout_id>.<ext>
-- Private bucket — files are served via signed URLs only.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('team-evidence', 'team-evidence', false)
on conflict (id) do nothing;

drop policy if exists "team evidence read" on storage.objects;
create policy "team evidence read" on storage.objects
  for select to authenticated using (
    bucket_id = 'team-evidence' and (
      r2g_is_admin()
      or (storage.foldername(name))[1] = r2g_my_member_id()::text
    ));

drop policy if exists "team evidence insert" on storage.objects;
create policy "team evidence insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'team-evidence' and (
      r2g_is_admin()
      or (storage.foldername(name))[1] = r2g_my_member_id()::text
    ));

drop policy if exists "team evidence delete" on storage.objects;
create policy "team evidence delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'team-evidence' and (
      r2g_is_admin()
      or (storage.foldername(name))[1] = r2g_my_member_id()::text
    ));

-- ============================================================
-- BEFORE YOU ISSUE A COORDINATOR A LOGIN — READ THIS
-- The team_* tables above are correctly scoped. But day_blocks,
-- owners_program, linda_* and fleet are still RLS "authenticated all",
-- so ANY signed-in user can read the whole business ledger.
-- Tighten those to r2g_is_admin() first, or coordinators will be able
-- to query your finances directly. Until then, run this page admin-only.
-- ============================================================
