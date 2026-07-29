-- ============================================================
-- READ-ONLY diagnostic. Nothing here writes, alters or deletes.
-- Run each block, paste the results back, and I'll size the owner merge.
--
-- The question this answers: when the 11 owners / 35 vehicles were copied
-- out of owners_program into the new owners/vehicles tables, were the
-- ORIGINAL IDs preserved?
--
-- Why it decides everything: every historical maintenance expense in
-- day_blocks carries a carId taken from owners_program cars[].id. The owner
-- billing pipeline ("Import ledger maint" → match to owner+car → bill via
-- Stripe) depends on those IDs matching. If the copy minted fresh c_… IDs,
-- repointing owners.html at `vehicles` silently breaks every past tag and
-- every future auto-match — with no error, just nothing matching.
-- ============================================================

-- 1. How many rows are actually in each store?
select 'owners table'      as store, count(*)::text as n from owners
union all
select 'vehicles table',        count(*)::text from vehicles
union all
select 'owners_program owners', jsonb_array_length(owners)::text
  from owners_program where id = 1;

-- 2. What do the IDs look like on each side?
select 'vehicles' as src, id, name, plate, status, available, owner_id
from vehicles order by created_at limit 10;

select 'owners_program' as src,
       o->>'id'   as owner_id,
       o->>'name' as owner_name,
       c->>'id'   as car_id,
       c->>'name' as car_name,
       c->>'plate' as plate
from owners_program op,
     jsonb_array_elements(op.owners) o,
     jsonb_array_elements(coalesce(o->'cars','[]'::jsonb)) c
where op.id = 1
limit 10;

-- 3. THE KEY QUESTION — do the two sets of car IDs overlap at all?
with prog as (
  select c->>'id' as car_id
  from owners_program op,
       jsonb_array_elements(op.owners) o,
       jsonb_array_elements(coalesce(o->'cars','[]'::jsonb)) c
  where op.id = 1
)
select
  (select count(*) from prog)                                        as program_cars,
  (select count(*) from vehicles)                                    as vehicles_rows,
  (select count(*) from vehicles v where v.id in (select car_id from prog)) as ids_in_common;
-- ids_in_common = vehicles_rows  → IDs preserved. Merge is a repoint. Low risk.
-- ids_in_common = 0              → fresh IDs. Needs a mapping table first. Higher risk.

-- 4. How much ledger history is actually tagged to a car?
--    (expense line shape: [desc, amount, category, paid, "", carId])
select
  count(*)                                              as tagged_expense_lines,
  count(distinct e->>5)                                 as distinct_car_ids,
  min(day)                                              as earliest,
  max(day)                                              as latest
from day_blocks db,
     jsonb_array_elements(coalesce(db.expenses,'[]'::jsonb)) e
where jsonb_array_length(e) > 5
  and coalesce(e->>5,'') <> '';

-- 5. Of those tagged carIds, how many resolve in each store?
with tagged as (
  select distinct e->>5 as car_id
  from day_blocks db,
       jsonb_array_elements(coalesce(db.expenses,'[]'::jsonb)) e
  where jsonb_array_length(e) > 5 and coalesce(e->>5,'') <> ''
),
prog as (
  select c->>'id' as car_id
  from owners_program op,
       jsonb_array_elements(op.owners) o,
       jsonb_array_elements(coalesce(o->'cars','[]'::jsonb)) c
  where op.id = 1
)
select
  (select count(*) from tagged)                                              as tagged_ids,
  (select count(*) from tagged t where t.car_id in (select car_id from prog)) as resolve_in_owners_program,
  (select count(*) from tagged t where t.car_id in (select id from vehicles)) as resolve_in_vehicles;

-- 6. Sanity: is anything already writing to the new tables?
select source, count(*) from owners   group by source;
select source, count(*) from vehicles group by source;
