-- ============================================================
-- Rent 2 Go — close the open RLS policies on owners and vehicles
--
-- THE PROBLEM (verified live, 2026-08-11):
--   owners.owners_admin_all   -> FOR ALL TO authenticated USING (true)
--   vehicles.vehicles_admin_all -> FOR ALL TO authenticated USING (true)
--
-- Despite the names, neither checked whether the caller is an admin. Any
-- signed-in user — a renter who registered a minute ago — could read, edit and
-- delete every vehicle and every owner. Proven in a rolled-back transaction:
-- a renter session repriced a car and deleted an owner row.
--
-- WHAT THIS CHANGES
--   admin      -> everything, as before (email allowlist via r2g_is_admin)
--   owner      -> their own owner row; read-only view of their own cars
--   renter     -> nothing on these two tables
--   anon       -> nothing directly; the catalogue keeps working because
--                 v_public_vehicles is SECURITY DEFINER and bypasses RLS
--   edge fns   -> unaffected; service_role bypasses RLS entirely
--
-- No data is created, altered or deleted. This only changes who may read
-- and write. Rollback is at the bottom.
-- ============================================================

-- ---- 0. refuse to run if it would lock everyone out ----
do $$
declare n int;
begin
  select count(*) into n from auth.users
   where lower(email) in ('gorentaride@gmail.com','thurstonrdavis@gmail.com','thandobnkala@gmail.com');
  if n = 0 then
    raise exception 'No admin account exists in auth.users — refusing to lock down, you would lose access';
  end if;
end $$;

-- ---- 1. who is the caller? ----
-- SECURITY DEFINER + STABLE so policies can call them cheaply and they can
-- read the base tables without recursing through the policies they support.
create or replace function r2g_my_owner_id() returns text
language sql stable security definer set search_path = public as $$
  select id from owners where auth_uid = auth.uid() limit 1;
$$;

create or replace function r2g_my_renter_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from renters where auth_uid = auth.uid() limit 1;
$$;

revoke all on function r2g_my_owner_id()  from public;
revoke all on function r2g_my_renter_id() from public;
grant execute on function r2g_my_owner_id()  to authenticated, service_role;
grant execute on function r2g_my_renter_id() to authenticated, service_role;

-- ---- 2. owners ----
drop policy if exists owners_admin_all   on owners;
drop policy if exists owners_admin       on owners;
drop policy if exists owners_read_own    on owners;
drop policy if exists owners_update_own  on owners;

create policy owners_admin on owners
  for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());

create policy owners_read_own on owners
  for select to authenticated
  using (auth_uid is not null and auth_uid = auth.uid());

-- an owner may correct their own contact details, nothing else and nobody else's
create policy owners_update_own on owners
  for update to authenticated
  using (auth_uid is not null and auth_uid = auth.uid())
  with check (auth_uid is not null and auth_uid = auth.uid());

-- ---- 3. vehicles ----
-- Owners get READ ONLY. The admin console is the only place a car is edited —
-- price, documents and availability drive real money and must not be editable
-- from a dashboard we do not control.
drop policy if exists vehicles_admin_all    on vehicles;
drop policy if exists vehicles_admin        on vehicles;
drop policy if exists vehicles_owner_read   on vehicles;

create policy vehicles_admin on vehicles
  for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());

create policy vehicles_owner_read on vehicles
  for select to authenticated
  using (owner_id is not null and owner_id = r2g_my_owner_id());

-- ---- 4. fleet_accounts ----
-- These rows carry each fleet's Stripe customer-portal URL. Renters reach their
-- own through v_my_portal (SECURITY DEFINER), so the table itself needs no
-- general read.
drop policy if exists fleet_accounts_read  on fleet_accounts;
drop policy if exists fleet_accounts_admin on fleet_accounts;

create policy fleet_accounts_admin on fleet_accounts
  for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());

-- ---- 5. what it looks like now ----
select tablename, policyname, cmd, coalesce(qual,'-') as using_expr
  from pg_policies
 where schemaname='public' and tablename in ('owners','vehicles','fleet_accounts')
 order by tablename, policyname;

-- ============================================================
-- ROLLBACK (only if something breaks and you need access back fast):
--
--   drop policy if exists owners_admin on owners;
--   drop policy if exists owners_read_own on owners;
--   drop policy if exists owners_update_own on owners;
--   create policy owners_admin_all on owners for all to authenticated using (true);
--
--   drop policy if exists vehicles_admin on vehicles;
--   drop policy if exists vehicles_owner_read on vehicles;
--   create policy vehicles_admin_all on vehicles for all to authenticated using (true);
--
--   drop policy if exists fleet_accounts_admin on fleet_accounts;
--   create policy fleet_accounts_read on fleet_accounts for select to authenticated using (true);
-- ============================================================
