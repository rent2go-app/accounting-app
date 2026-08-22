-- Mileage checks, asked for rather than always on.
--
-- The renter dashboard carried a permanent "Quick mileage check" card that
-- reappeared every fortnight whether anyone needed a reading or not. A prompt
-- that is always there is furniture: it stops being read, and when a reading is
-- genuinely needed it carries no more weight than it did the week before.
--
-- So the office asks, from the car. The renter is emailed and texted, the prompt
-- appears on their dashboard while the request is open, and it goes away when
-- they answer.

create table if not exists public.mileage_requests (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   text not null references public.vehicles(id) on delete cascade,
  renter_id    uuid references public.renters(id) on delete set null,
  requested_at timestamptz not null default now(),
  requested_by text,
  sent_email   boolean default false,
  sent_sms     boolean default false,
  note         text,
  responded_at timestamptz,
  mileage      integer,
  cancelled_at timestamptz
);

create index if not exists mileage_requests_open_idx
  on public.mileage_requests(vehicle_id) where responded_at is null and cancelled_at is null;
create index if not exists mileage_requests_renter_idx on public.mileage_requests(renter_id);

alter table public.mileage_requests enable row level security;
drop policy if exists mileage_own_read   on public.mileage_requests;
drop policy if exists mileage_own_answer on public.mileage_requests;
drop policy if exists mileage_admin_all  on public.mileage_requests;

-- a renter sees the request made of them, and may answer it
create policy mileage_own_read on public.mileage_requests
  for select to authenticated using (renter_id = public.r2g_my_renter_id());
create policy mileage_own_answer on public.mileage_requests
  for update to authenticated
  using (renter_id = public.r2g_my_renter_id())
  with check (renter_id = public.r2g_my_renter_id());
create policy mileage_admin_all on public.mileage_requests
  for all to authenticated using (public.r2g_is_admin()) with check (public.r2g_is_admin());

grant select, update on public.mileage_requests to authenticated;

-- what the renter's dashboard reads: only what is still open for them
drop view if exists public.v_my_mileage_request;
create view public.v_my_mileage_request as
select m.id, m.vehicle_id, m.requested_at, m.note, v.name as vehicle
  from public.mileage_requests m
  join public.renters r on r.id = m.renter_id
  left join public.vehicles v on v.id = m.vehicle_id
 where r.auth_uid = auth.uid()
   and m.responded_at is null and m.cancelled_at is null;

grant select on public.v_my_mileage_request to authenticated;

-- and what the office sees per car
drop view if exists public.v_mileage_requests;
create view public.v_mileage_requests as
select m.*, v.name as vehicle, v.plate, r.name as renter, r.email, r.phone
  from public.mileage_requests m
  left join public.vehicles v on v.id = m.vehicle_id
  left join public.renters  r on r.id = m.renter_id;

grant select on public.v_mileage_requests to authenticated;
notify pgrst, 'reload schema';
