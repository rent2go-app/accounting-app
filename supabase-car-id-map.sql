-- ============================================================
-- Rent 2 Go — car ID map (owners_program  →  vehicles)
-- Paste into the SQL editor and Run. Safe to re-run.
--
-- WHAT THIS IS FOR
-- Owners currently exist twice: the old `owners_program` jsonb blob (which
-- every admin page reads today) and the new `owners`/`vehicles` tables (which
-- owner-intake writes to). To retire the blob we need to know which old car
-- is which new car.
--
-- Every maintenance expense in day_blocks is tagged with an owners_program
-- car id. If we repoint the pages without a map and the ids don't match,
-- maintenance billing silently stops matching anything — no error, just
-- empty results. This table is the safety net.
--
-- SAFETY: creates ONE new table (car_id_map) and reads three others. It does
-- not alter or delete owners_program, owners, vehicles or day_blocks.
-- Matching is done on plate first (the natural key), then id.
-- ============================================================

create table if not exists car_id_map (
  old_id        text primary key,   -- owners_program cars[].id  (what the ledger is tagged with)
  new_id        text,               -- vehicles.id               (null if no match found)
  plate         text,
  car_name      text,
  owner_old_id  text,
  owner_name    text,
  matched_by    text,               -- 'id' | 'plate' | 'unmatched'
  ledger_lines  int not null default 0,   -- how many tagged expenses ride on this id
  created_at    timestamptz not null default now()
);

-- rebuild from scratch each run so it always reflects current data
delete from car_id_map;

with prog as (
  select
    o->>'id'    as owner_old_id,
    o->>'name'  as owner_name,
    c->>'id'    as old_id,
    c->>'name'  as car_name,
    c->>'plate' as plate,
    upper(regexp_replace(coalesce(c->>'plate',''), '[^A-Za-z0-9]', '', 'g')) as plate_key
  from owners_program op,
       jsonb_array_elements(op.owners) o,
       jsonb_array_elements(coalesce(o->'cars', '[]'::jsonb)) c
),
tags as (
  select e->>5 as old_id, count(*)::int as n
  from day_blocks db,
       jsonb_array_elements(coalesce(db.expenses, '[]'::jsonb)) e
  where jsonb_array_length(e) > 5
    and coalesce(e->>5, '') <> ''
  group by 1
)
insert into car_id_map (old_id, new_id, plate, car_name, owner_old_id, owner_name, matched_by, ledger_lines)
select
  p.old_id,
  coalesce(by_id.id, by_plate.id),
  p.plate,
  p.car_name,
  p.owner_old_id,
  p.owner_name,
  case
    when by_id.id    is not null then 'id'
    when by_plate.id is not null then 'plate'
    else 'unmatched'
  end,
  coalesce(t.n, 0)
from prog p
left join lateral (
  select v.id from vehicles v where v.id = p.old_id limit 1
) by_id on true
left join lateral (
  select v.id from vehicles v
  where p.plate_key <> ''
    and upper(regexp_replace(coalesce(v.plate,''), '[^A-Za-z0-9]', '', 'g')) = p.plate_key
  limit 1
) by_plate on true
left join tags t on t.old_id = p.old_id
on conflict (old_id) do nothing;

-- ============================================================
-- RESULTS — three selects. Read them top to bottom.
-- ============================================================

-- 1. The headline. This is the number that decides the merge.
select
  matched_by,
  count(*)            as cars,
  sum(ledger_lines)   as ledger_expenses_affected
from car_id_map
group by matched_by
order by matched_by;
--   all 'id'        → ids were preserved. Merge is a clean repoint.
--   mostly 'plate'  → ids changed but every car is identifiable. Map handles it.
--   any 'unmatched' → those cars exist in owners_program but NOT in vehicles.
--                     They must be created before we retire the blob, or their
--                     history and billing are orphaned. See select 3.

-- 2. Scale check — are both stores holding the same fleet?
select
  (select count(*) from car_id_map)                          as program_cars,
  (select count(*) from vehicles)                            as vehicles_rows,
  (select count(*) from owners)                              as owners_rows,
  (select count(*) from car_id_map where new_id is not null) as mapped,
  (select count(*) from car_id_map where new_id is null)     as unmapped;

-- 3. Anything that did NOT map — these are the ones to look at by hand.
select owner_name, car_name, plate, old_id, ledger_lines
from car_id_map
where new_id is null
order by ledger_lines desc, owner_name;

-- 4. Vehicles that exist in the new table but have no owners_program twin
--    (i.e. added via owner-intake since the copy — these are fine, just new).
select v.id, v.name, v.plate, v.status, v.source
from vehicles v
where v.id not in (select coalesce(new_id,'') from car_id_map)
order by v.created_at desc;
