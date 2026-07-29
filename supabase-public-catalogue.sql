-- ============================================================
-- Rent 2 Go — public catalogue for the prototype
-- Paste into the SQL editor and Run. Safe to re-run.
--
-- Two population paths feed this, both landing in the same `vehicles` table:
--   1. Owner onboards a car through their dashboard  → owner-intake (source='prototype')
--   2. Admin adds a car in the admin interface       → owners.html   (source='admin')
-- Plus the 35 real active rentals already migrated    (source='migrated')
--
-- SAFETY: adds nullable columns, creates one view, one grant. Section 3 is
-- the ONLY part that changes data — read it before running it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Fields the catalogue actually renders.
--    The prototype's car card shows "Sedan • White" and its detail page
--    lists colour, transmission, doors and seats. `vehicles` has none of
--    them. All nullable — nothing is assumed about existing rows.
-- ------------------------------------------------------------
alter table vehicles
  add column if not exists color        text,
  add column if not exists fuel         text,
  add column if not exists seats        int,
  add column if not exists doors        int,
  add column if not exists transmission text;

-- ------------------------------------------------------------
-- 2. WHERE ARE THE 35 REAL CARS? Run this first, on its own.
--
--    vehicles.status defaults to 'pending' and available to false. If the
--    migration took those defaults, every real active rental is currently
--    unlisted and the catalogue will come back empty.
-- ------------------------------------------------------------
select status, available, source, count(*) as cars
from vehicles
group by status, available, source
order by cars desc;

-- Also worth seeing before you list anything publicly:
select count(*) filter (where images = '[]'::jsonb or images is null) as cars_with_no_photos,
       count(*) filter (where coalesce(color,'') = '')                as cars_with_no_colour,
       count(*)                                                       as total
from vehicles;

-- ------------------------------------------------------------
-- 3. ★ THE ONLY DATA CHANGE IN THIS FILE ★
--
--    Publishing a car to a public website is a business decision, so this
--    is deliberately commented out. Read section 2's output first, then
--    uncomment the version you want and run it.
--
--    `status='live'`  = listed in the catalogue
--    `available`      = not currently out with a renter
--                       (a live-but-unavailable car still shows, badged
--                        "Rented · Not Available" — that's intended)
-- ------------------------------------------------------------

-- 3a. Publish the 35 migrated cars (the real active rentals):
-- update vehicles set status = 'live'
--  where source = 'migrated' and status = 'pending';

-- 3b. Mark the ones currently out with a renter as unavailable.
--     Adjust the plate list to match reality, or skip and set them in the app.
-- update vehicles set available = false where plate in ('ABC1234','XYZ5678');

-- 3c. Everything else live is bookable:
-- update vehicles set available = true
--  where status = 'live' and available is distinct from false;

-- ------------------------------------------------------------
-- 4. The curated public view.
--
--    security_invoker stays OFF (the default) on purpose: the view runs
--    with definer rights so it can read `vehicles` past its admin-only RLS
--    and expose only the filtered rows and safe columns below. Do not
--    "fix" this by enabling security_invoker — the catalogue would return
--    zero rows to anonymous visitors.
-- ------------------------------------------------------------
create or replace view v_public_vehicles as
select
  v.id,
  v.name,
  v.make,
  v.model,
  v.year,
  v.type,
  v.color,
  v.fuel,
  v.seats,
  v.doors,
  v.transmission,
  v.rate,
  v.images,
  v.available          -- exposed so the card can badge "Rented · Not Available"
from vehicles v
where v.status = 'live';   -- listed; availability is a badge, not a filter

-- Deliberately NOT exposed, and why:
--   vin, plate             — identifying; the renter gets the plate in their
--                            pickup instructions after booking, not before
--   owner_id               — visitors have no business knowing who owns what
--   docs, eligibility      — registration and insurance paperwork
--   gps, sarekon_device_*  — tracker identifiers
--   days_by_month, rate    — internal billing (rate IS exposed: it's the price)

grant select on v_public_vehicles to anon, authenticated;

-- ------------------------------------------------------------
-- 5. Verify — this is exactly what the prototype will see
-- ------------------------------------------------------------
select id, name, type, color, year, rate, available,
       jsonb_array_length(coalesce(images,'[]'::jsonb)) as photos
from v_public_vehicles
order by rate;

-- In the prototype:
--   sb.from('v_public_vehicles').select('*').order('rate')
