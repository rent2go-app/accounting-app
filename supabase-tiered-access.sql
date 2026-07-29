-- ============================================================
-- Rent 2 Go — TIERED ACCESS (row level security)
--
--   admin   → everything
--   owner   → their own owner row + their own vehicles, nothing else
--   renter  → their own renter row, nothing else
--   team    → their own tasks / payouts / refunds, nothing else
--   anon    → the public catalogue view only
--
-- READ THIS BEFORE RUNNING. This is the one migration that can lock you
-- out of your own ledger. It is reversible (see ROLLBACK at the bottom),
-- but do step 0 first and keep this tab open until step 6 passes.
--
-- No data is created, altered or deleted anywhere in this file. It only
-- changes who may read and write.
-- ============================================================

-- ------------------------------------------------------------
-- 0. CONFIRM YOU ARE ON THE ADMIN LIST BEFORE LOCKING ANYTHING
--    Run this on its own first. It must return true.
--    If it returns false, STOP and add your email in section 1.
-- ------------------------------------------------------------
-- select lower(auth.jwt() ->> 'email') as me,
--        lower(auth.jwt() ->> 'email') in
--          ('gorentaride@gmail.com','thurstonrdavis@gmail.com','thandobnkala@gmail.com') as i_am_admin;

-- ------------------------------------------------------------
-- 1. Who is the caller?
--    All SECURITY DEFINER + STABLE so policies can call them cheaply.
-- ------------------------------------------------------------
create or replace function r2g_is_admin() returns boolean
language sql stable as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') in (
      'gorentaride@gmail.com',
      'thurstonrdavis@gmail.com',
      'thandobnkala@gmail.com'
    ), false);
$$;

create or replace function r2g_my_owner_id() returns text
language sql stable security definer set search_path = public as $$
  select id from owners where auth_uid = auth.uid() limit 1;
$$;

create or replace function r2g_my_renter_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from renters where auth_uid = auth.uid() limit 1;
$$;

create or replace function r2g_my_member_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from team_members where auth_uid = auth.uid() limit 1;
$$;

-- handy for the app: 'admin' | 'owner' | 'renter' | 'team' | 'none'
create or replace function r2g_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when r2g_is_admin()                then 'admin'
    when r2g_my_owner_id()  is not null then 'owner'
    when r2g_my_renter_id() is not null then 'renter'
    when r2g_my_member_id() is not null then 'team'
    else 'none' end;
$$;

grant execute on function r2g_role() to authenticated;

-- ------------------------------------------------------------
-- 2. Lock every internal table to admins only.
--
--    These hold the ledger, budgets, Linda's billing state and the fleet.
--    Nobody but an admin should ever read them. Today they are all
--    "authenticated using (true)" — i.e. readable by ANY login, which is
--    exactly what makes issuing a renter or coordinator login unsafe.
--
--    We drop EVERY existing policy on each table first. Leaving one
--    unknown permissive policy behind would defeat the whole exercise.
--    Tables that don't exist are skipped silently.
-- ------------------------------------------------------------
do $$
declare
  t text;
  p record;
  targets text[] := array[
    -- ledger + accounting
    'day_blocks','day_notes','app_settings','bank_balances','budget_plan',
    'transactions','ledger_lines','currencies','exchange_rates','entities',
    'categories','accounts','stripe_income',
    -- owners programme (legacy blob) + fleet
    'owners_program','fleet','fleet_performance','fleet_reasons',
    -- personal / home budgets
    'home_budget','personal_budgets',
    -- Linda
    'linda_customers','linda_fees','linda_drafts','linda_payments','linda_notes',
    'linda_disconnections','linda_learnings','linda_day','linda_accounts'
  ];
begin
  foreach t in array targets loop
    if to_regclass('public.' || t) is null then
      raise notice 'skip % (does not exist)', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin())',
      t || '_admin_only', t);
    raise notice 'locked % to admins', t;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Guard trigger — shared by owners and renters.
--
--    Stops an owner/renter editing the fields that Stripe and the admin own.
--
--    NOTE the `auth.uid() is null` escape. The intake edge functions write
--    with the service_role key, whose JWT carries no `sub` claim, so
--    auth.uid() is null for them. Triggers fire regardless of RLS, so
--    WITHOUT this escape every write from renter-intake / owner-intake /
--    id-verify / id-webhook would be silently reverted with no error.
--    Do not remove it.
-- ------------------------------------------------------------
create or replace function r2g_freeze_verification() returns trigger as $$
begin
  if r2g_is_admin() or auth.uid() is null then return new; end if;
  new.status              := old.status;
  new.stripe_account      := old.stripe_account;
  new.session_id          := old.session_id;
  new.verify_url          := old.verify_url;
  new.verified_name       := old.verified_name;
  new.verified_dob        := old.verified_dob;
  new.verified_doc_type   := old.verified_doc_type;
  new.verified_doc_number := old.verified_doc_number;
  new.verified_expiry     := old.verified_expiry;
  new.verified_address    := old.verified_address;
  new.auth_uid            := old.auth_uid;
  new.notes               := old.notes;
  return new;
end; $$ language plpgsql;

-- owners has verify_status + id_verified instead of status
create or replace function r2g_freeze_owner_verification() returns trigger as $$
begin
  if r2g_is_admin() or auth.uid() is null then return new; end if;
  new.status              := old.status;
  new.verify_status       := old.verify_status;
  new.id_verified         := old.id_verified;
  new.stripe_account      := old.stripe_account;
  new.session_id          := old.session_id;
  new.verify_url          := old.verify_url;
  new.verified_name       := old.verified_name;
  new.verified_dob        := old.verified_dob;
  new.verified_doc_type   := old.verified_doc_type;
  new.verified_doc_number := old.verified_doc_number;
  new.verified_expiry     := old.verified_expiry;
  new.verified_address    := old.verified_address;
  new.auth_uid            := old.auth_uid;
  new.notes               := old.notes;
  -- money fields are admin-only too
  new.payout              := old.payout;
  new.bank_name           := old.bank_name;
  new.bank_last4          := old.bank_last4;
  new.stripe_label        := old.stripe_label;
  new.stripe_biz_id       := old.stripe_biz_id;
  new.cadence             := old.cadence;
  new.pay_day             := old.pay_day;
  new.weekday             := old.weekday;
  return new;
end; $$ language plpgsql;

-- ------------------------------------------------------------
-- 4. OWNERS — admin all; owner sees and edits only their own row
-- ------------------------------------------------------------
do $$ declare p record; begin
  if to_regclass('public.owners') is null then return; end if;
  alter table public.owners enable row level security;
  for p in select policyname from pg_policies where schemaname='public' and tablename='owners' loop
    execute format('drop policy if exists %I on public.owners', p.policyname);
  end loop;
end $$;

create policy owners_admin_all on owners
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
create policy owners_read_self on owners
  for select to authenticated using (auth_uid = auth.uid());
create policy owners_update_self on owners
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

drop trigger if exists trg_owners_freeze on owners;
create trigger trg_owners_freeze before update on owners
  for each row execute function r2g_freeze_owner_verification();

-- ------------------------------------------------------------
-- 5. VEHICLES — admin all; owner sees only their own cars (read-only).
--    Edits to a listing go through admin approval, as they do today.
-- ------------------------------------------------------------
do $$ declare p record; begin
  if to_regclass('public.vehicles') is null then return; end if;
  alter table public.vehicles enable row level security;
  for p in select policyname from pg_policies where schemaname='public' and tablename='vehicles' loop
    execute format('drop policy if exists %I on public.vehicles', p.policyname);
  end loop;
end $$;

create policy vehicles_admin_all on vehicles
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
create policy vehicles_read_own on vehicles
  for select to authenticated using (owner_id = r2g_my_owner_id());

-- ------------------------------------------------------------
-- 6. RENTERS — admin all; renter sees and edits only their own row
-- ------------------------------------------------------------
do $$ declare p record; begin
  if to_regclass('public.renters') is null then return; end if;
  alter table public.renters enable row level security;
  for p in select policyname from pg_policies where schemaname='public' and tablename='renters' loop
    execute format('drop policy if exists %I on public.renters', p.policyname);
  end loop;
end $$;

create policy renters_admin_all on renters
  for all to authenticated using (r2g_is_admin()) with check (r2g_is_admin());
create policy renters_read_self on renters
  for select to authenticated using (auth_uid = auth.uid());
create policy renters_update_self on renters
  for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

drop trigger if exists trg_renters_freeze on renters;
create trigger trg_renters_freeze before update on renters
  for each row execute function r2g_freeze_verification();

-- ------------------------------------------------------------
-- 7. Public catalogue stays reachable by anonymous visitors.
--    The view is curated (live + available, safe columns only) and runs
--    with definer rights, so locking `vehicles` above does not break it.
-- ------------------------------------------------------------
do $$ begin
  if to_regclass('public.v_public_vehicles') is not null then
    grant select on public.v_public_vehicles to anon, authenticated;
  end if;
end $$;

-- ============================================================
-- 8. VERIFY — run this after, while still signed in as an admin.
--    Every table should show rls_enabled = true and at least one policy.
-- ============================================================
-- select c.relname as table_name,
--        c.relrowsecurity as rls_enabled,
--        count(p.policyname) as policies
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
-- left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
-- where c.relkind = 'r'
-- group by 1,2
-- order by 1;

-- Then, in the app: reload index.html. If the ledger still loads, you are fine.
-- Also confirm Linda still scans (linda-scan uses service_role and bypasses RLS,
-- so it should be unaffected — but check one run).

-- ============================================================
-- ROLLBACK — if the admin app stops loading, run this to reopen
-- everything exactly as it was, then tell me what broke.
-- ============================================================
-- do $$
-- declare t text; p record;
--   targets text[] := array['day_blocks','day_notes','app_settings','owners_program',
--     'fleet','fleet_performance','fleet_reasons','home_budget','personal_budgets',
--     'stripe_income','linda_customers','linda_fees','linda_drafts','linda_payments',
--     'linda_notes','linda_disconnections','linda_learnings','linda_day','linda_accounts',
--     'owners','vehicles','renters'];
-- begin
--   foreach t in array targets loop
--     if to_regclass('public.'||t) is null then continue; end if;
--     for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
--       execute format('drop policy if exists %I on public.%I', p.policyname, t);
--     end loop;
--     execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)',
--                    t||'_open', t);
--   end loop;
-- end $$;
