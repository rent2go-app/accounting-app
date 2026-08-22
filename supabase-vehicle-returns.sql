-- The return form, kept inside the system.
--
-- Returns went out to a Typeform. That put the record of how a car came back -
-- mileage, fuel, damage, photos - in a different system from the record of how it
-- went out, so nobody could put the two side by side, and the renter could not
-- see what they had submitted.
--
-- Deliberately its own table rather than a column on bookings. Renters on a daily
-- Stripe subscription have no bookings row at all - Kimberly does not - so a
-- return hung off bookings would be impossible for exactly the renters who have
-- been in a car longest.

create table if not exists public.vehicle_returns (
  id             uuid primary key default gen_random_uuid(),
  renter_id      uuid not null references public.renters(id) on delete cascade,
  vehicle_id     text references public.vehicles(id),
  booking_id     text,                       -- when there is one; null for subscriptions
  returned_at    timestamptz not null default now(),
  mileage        text,
  fuel_level     text,
  left_where     text,
  keys_left      text,
  damage_notes   text,
  condition_notes text,
  tolls_tickets  text,
  belongings_out boolean default false,
  photos         jsonb default '[]'::jsonb,  -- [{label, path}] in the rental-photos bucket
  submitted_by   text default 'renter',
  created_at     timestamptz not null default now()
);

create index if not exists vehicle_returns_renter_idx  on public.vehicle_returns(renter_id);
create index if not exists vehicle_returns_vehicle_idx on public.vehicle_returns(vehicle_id);

alter table public.vehicle_returns enable row level security;

drop policy if exists vehicle_returns_own_read   on public.vehicle_returns;
drop policy if exists vehicle_returns_own_insert on public.vehicle_returns;
drop policy if exists vehicle_returns_admin_all  on public.vehicle_returns;

-- a renter sees and files their own, and nobody else's
create policy vehicle_returns_own_read on public.vehicle_returns
  for select to authenticated
  using (renter_id = public.r2g_my_renter_id());

create policy vehicle_returns_own_insert on public.vehicle_returns
  for insert to authenticated
  with check (renter_id = public.r2g_my_renter_id());

-- no renter update policy on purpose: a return record is what was true when the
-- car came back, and it must not be editable after the fact

create policy vehicle_returns_admin_all on public.vehicle_returns
  for all to authenticated
  using (public.r2g_is_admin()) with check (public.r2g_is_admin());

-- what the renter reads back on their own dashboard
drop view if exists public.v_my_returns;
create view public.v_my_returns as
select vr.*
  from public.vehicle_returns vr
  join public.renters r on r.id = vr.renter_id
 where r.auth_uid = auth.uid();

grant select on public.v_my_returns to authenticated;
grant select, insert on public.vehicle_returns to authenticated;

-- and what the office reads
drop view if exists public.v_admin_returns;
create view public.v_admin_returns as
select vr.id, vr.returned_at, r.name as renter, r.email, v.name as vehicle, v.plate,
       vr.mileage, vr.fuel_level, vr.damage_notes, vr.condition_notes, vr.tolls_tickets,
       vr.left_where, vr.keys_left, vr.belongings_out,
       jsonb_array_length(coalesce(vr.photos,'[]'::jsonb)) as photo_count,
       vr.photos, vr.renter_id, vr.vehicle_id, vr.booking_id
  from public.vehicle_returns vr
  join public.renters r on r.id = vr.renter_id
  left join public.vehicles v on v.id = vr.vehicle_id;

grant select on public.v_admin_returns to authenticated;
notify pgrst, 'reload schema';
