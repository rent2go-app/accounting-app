-- ============================================================
-- Rent 2 Go — owners merge prep
-- Paste into the SQL editor and Run. Safe to re-run (idempotent).
--
-- WHY
-- The new owners/vehicles tables cannot yet hold two things the live
-- billing depends on, so repointing owners.html at them would silently
-- lose money data:
--
--   1. car.days — a PER-MONTH map, e.g. {"2026-07": 18, "2026-08": 31},
--      read by carDays(car, ym) to prorate a car's billable days.
--      vehicles.days is an int; it cannot represent this.
--
--   2. owner.maint — the maintenance records billed to owners via Stripe
--      (owner-invoice). There is no maint column on owners at all.
--
-- WHAT THIS DOES
--   - adds vehicles.days_by_month (jsonb) and owners.maint (jsonb)
--   - backfills both from the owners_program blob
--   - fills any other owner field the original copy left blank
--
-- SAFETY
--   - purely additive: no table created or dropped, no column removed
--   - the existing vehicles.days int column is left completely alone
--   - backfill only writes the NEW columns, or fills NULLs on old ones;
--     it never overwrites a value that is already set
--   - owners_program is read only and stays intact as the fallback
-- ============================================================

-- ------------------------------------------------------------
-- 1. The two missing shapes
-- ------------------------------------------------------------
alter table vehicles add column if not exists days_by_month jsonb not null default '{}'::jsonb;
alter table owners   add column if not exists maint         jsonb not null default '[]'::jsonb;

-- ------------------------------------------------------------
-- 2. Backfill per-month billable days from the blob
-- ------------------------------------------------------------
update vehicles v
set days_by_month = src.days
from (
  select c->>'id' as car_id, c->'days' as days
  from owners_program op,
       jsonb_array_elements(op.owners) o,
       jsonb_array_elements(coalesce(o->'cars', '[]'::jsonb)) c
  where c->'days' is not null
    and jsonb_typeof(c->'days') = 'object'
) src
where v.id = src.car_id
  and v.days_by_month = '{}'::jsonb;   -- only if we haven't already filled it

-- ------------------------------------------------------------
-- 3. Backfill owner maintenance records from the blob
-- ------------------------------------------------------------
update owners ow
set maint = src.maint
from (
  select o->>'id' as owner_id, o->'maint' as maint
  from owners_program op,
       jsonb_array_elements(op.owners) o
  where o->'maint' is not null
    and jsonb_typeof(o->'maint') = 'array'
) src
where ow.id = src.owner_id
  and ow.maint = '[]'::jsonb;          -- only if empty

-- ------------------------------------------------------------
-- 4. Fill any owner field the original copy left blank.
--    coalesce() means an existing value always wins — this only
--    plugs gaps, it never overwrites.
-- ------------------------------------------------------------
update owners ow
set
  name          = coalesce(nullif(ow.name,''),          src.name),
  owner_name    = coalesce(nullif(ow.owner_name,''),    src.owner_name),
  business_name = coalesce(nullif(ow.business_name,''), src.biz_name),
  email         = coalesce(nullif(ow.email,''),         src.email),
  phone         = coalesce(nullif(ow.phone,''),         src.phone),
  addr          = coalesce(nullif(ow.addr,''),          src.addr),
  country       = coalesce(nullif(ow.country,''),       src.country),
  cadence       = coalesce(nullif(ow.cadence,''),       src.cadence),
  pay_day       = coalesce(ow.pay_day,                  src.pay_day),
  weekday       = coalesce(nullif(ow.weekday,''),       src.weekday),
  tag           = coalesce(nullif(ow.tag,''),           src.tag),
  stripe_label  = coalesce(nullif(ow.stripe_label,''),  src.stripe_label),
  stripe_biz_id = coalesce(nullif(ow.stripe_biz_id,''), src.stripe_biz_id)
from (
  select
    o->>'id'          as owner_id,
    o->>'name'        as name,
    o->>'ownerName'   as owner_name,
    o->>'bizName'     as biz_name,
    o->>'email'       as email,
    o->>'phone'       as phone,
    o->>'addr'        as addr,
    o->>'country'     as country,
    o->>'cadence'     as cadence,
    nullif(o->>'day','')::int as pay_day,
    o->>'weekday'     as weekday,
    o->>'tag'         as tag,
    o->>'stripeLabel' as stripe_label,
    o->>'stripeBizId' as stripe_biz_id
  from owners_program op, jsonb_array_elements(op.owners) o
) src
where ow.id = src.owner_id;

-- ------------------------------------------------------------
-- 5. Fill vehicle gaps the same way
-- ------------------------------------------------------------
update vehicles v
set
  name  = coalesce(nullif(v.name,''),  src.name),
  plate = coalesce(nullif(v.plate,''), src.plate),
  vin   = coalesce(nullif(v.vin,''),   src.vin),
  rate  = coalesce(v.rate,             src.rate)
from (
  select
    c->>'id'    as car_id,
    c->>'name'  as name,
    c->>'plate' as plate,
    c->>'vin'   as vin,
    nullif(c->>'rate','')::numeric as rate
  from owners_program op,
       jsonb_array_elements(op.owners) o,
       jsonb_array_elements(coalesce(o->'cars', '[]'::jsonb)) c
) src
where v.id = src.car_id;

-- ============================================================
-- VERIFY — all three should look right before we repoint the app
-- ============================================================

-- a) every owner has their maintenance records
select ow.id, ow.name,
       jsonb_array_length(ow.maint) as maint_items,
       (select jsonb_array_length(coalesce(o->'maint','[]'::jsonb))
        from owners_program op, jsonb_array_elements(op.owners) o
        where o->>'id' = ow.id) as maint_in_blob
from owners ow order by ow.name;

-- b) cars carrying per-month day maps
select count(*) filter (where days_by_month <> '{}'::jsonb) as cars_with_day_maps,
       count(*)                                             as cars_total
from vehicles;

-- c) nothing important still blank
select id, name, email, cadence, pay_day, stripe_label
from owners
where coalesce(name,'') = '' or coalesce(email,'') = '' or coalesce(cadence,'') = ''
order by name;
