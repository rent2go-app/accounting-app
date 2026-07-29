-- ============================================================
-- Rent 2 Go — catalogue fields
-- Paste into the SQL editor and Run. Safe to re-run.
--
-- TWO PROBLEMS THIS FIXES
--
-- 1. `vehicles.rate` is the OWNER'S MONTHLY PLATFORM FEE (the 500/350/250
--    tier), not a renter's daily price. Exposing it publicly would advertise
--    a car at "$250/day". A separate daily_rate column is added for the
--    renter-facing price, and the catalogue lists only cars that have one —
--    so nothing is ever advertised at $0.
--
-- 2. Car names carry the year and colour ("KIA OPTIMA - 2016 - WHITE") but
--    the year/color columns are empty. Parsed out below.
--
-- SAFETY: additive columns + one view. `rate` is never modified.
-- ============================================================

alter table vehicles
  add column if not exists daily_rate numeric;   -- what a RENTER pays per day

comment on column vehicles.rate is
  'Owner platform tier fee (monthly, 500/350/250). NOT the renter price.';
comment on column vehicles.daily_rate is
  'Renter-facing daily rental price. Required before a car appears in the public catalogue.';

-- ------------------------------------------------------------
-- Parse year and colour out of the name, e.g.
--   "KIA OPTIMA - 2016 - WHITE"      → 2016 / White
--   "HYUNDAI ELANTRA - 2016 -BLUE"   → 2016 / Blue   (missing space tolerated)
-- Only fills blanks; an existing value always wins.
-- ------------------------------------------------------------
update vehicles set
  year = coalesce(year, nullif(substring(name from '(?:19|20)[0-9]{2}'), '')::int)
where name is not null;

update vehicles set
  color = coalesce(nullif(color,''),
            initcap(nullif(trim(split_part(name, '-', 3)), '')))
where name is not null;

update vehicles set
  make = coalesce(nullif(make,''),
           initcap(nullif(split_part(trim(split_part(name,'-',1)), ' ', 1), '')))
where name is not null;

update vehicles set
  model = coalesce(nullif(model,''),
            initcap(nullif(trim(substr(trim(split_part(name,'-',1)),
                    length(split_part(trim(split_part(name,'-',1)),' ',1)) + 1)), '')))
where name is not null;

-- ------------------------------------------------------------
-- The catalogue view. Now keyed on daily_rate, so a car only goes public
-- once someone has priced it.
-- security_invoker stays OFF on purpose — the view runs with definer rights
-- so it can read past the admin-only RLS and expose only what is below.
-- ------------------------------------------------------------
create or replace view v_public_vehicles as
select
  v.id, v.name, v.make, v.model, v.year, v.type, v.color, v.fuel,
  v.seats, v.doors, v.transmission,
  v.daily_rate as rate,          -- renter price, never the owner tier fee
  v.images,
  v.available                    -- so the card can badge "Rented · Not Available"
from vehicles v
where v.status = 'live'
  and v.daily_rate is not null
  and v.daily_rate > 0;

grant select on v_public_vehicles to anon, authenticated;

-- ------------------------------------------------------------
-- What still needs a human: pricing and photos.
-- Example (adjust the numbers, then uncomment):
-- update vehicles set daily_rate = 65 where status='live' and daily_rate is null;
-- ------------------------------------------------------------

select
  (select count(*) from vehicles)                                   as cars,
  (select count(*) from vehicles where year is not null)            as with_year,
  (select count(*) from vehicles where coalesce(color,'') <> '')    as with_colour,
  (select count(*) from vehicles where daily_rate is not null)      as priced,
  (select count(*) from vehicles where images <> '[]'::jsonb)       as with_photos,
  (select count(*) from v_public_vehicles)                          as live_in_catalogue;
