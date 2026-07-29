-- ============================================================
-- Rent 2 Go — public catalogue view for the prototype
-- Paste into: Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- This is the "public, curated view" promised in MERGE-PROMPT.md §Reads.
-- The prototype's catalogue reads THIS, never the raw `vehicles` table.
--
-- ADDITIVE ONLY: creates one view and one grant. No table is created,
-- altered or dropped. No existing policy is touched.
-- ============================================================

-- security_invoker = false (the default) is deliberate here: the view runs with
-- the definer's rights so it can read `vehicles` past its admin-only RLS, and
-- exposes ONLY the filtered rows and safe columns below. That is the whole point
-- of a curated view — do not "fix" this by turning security_invoker on, or the
-- catalogue will silently return zero rows to anonymous visitors.
create or replace view v_public_vehicles as
select
  v.id,
  v.name,
  v.make,
  v.model,
  v.year,
  v.type,
  v.rate,
  v.images
from vehicles v
where v.status = 'live'
  and v.available = true;

-- Deliberately NOT exposed, and why:
--   vin, plate            — identifying; the renter gets the plate in their
--                           pickup instructions after booking, not before
--   owner_id              — visitors have no business knowing who owns which car
--   docs, eligibility     — registration/insurance paperwork
--   gps, sarekon_device_*  — tracker identifiers
--   created_at/updated_at — internal

grant select on v_public_vehicles to anon, authenticated;

-- Verify (should return only live + available cars, safe columns only):
--   select * from v_public_vehicles order by rate;
--
-- Then in the prototype:
--   sb.from('v_public_vehicles').select('*').order('rate')
