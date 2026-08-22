-- ============================================================
-- Plates must never appear on the public site. A renter only learns the plate
-- once they have paid, in the pickup instructions.
--
-- We recently began writing the plate into vehicles.name so that identical
-- models could be told apart internally ("Kia Optima - 2016 - Burgundy · KHF5841").
-- v_public_vehicles selected that column straight through, which published the
-- plate of every live car to anyone with the anon key.
--
-- The public view now builds its own display name from make, model, year and
-- colour and never touches vehicles.name. Internally the name keeps its plate.
-- ============================================================
create or replace view v_public_vehicles as
select
  v.id,
  -- built from the parts, so a plate can never ride along in the label
  nullif(trim(both ' -' from concat_ws(' ',
    v.make,
    v.model,
    case when v.year is not null then '- ' || v.year::text end,
    case when v.color is not null then '- ' || v.color end
  )), '') as name,
  v.make, v.model, v.year, v.type, v.color, v.fuel, v.seats, v.doors, v.transmission,
  v.daily_rate as rate,
  v.images,
  v.available
from vehicles v
where v.status = 'live' and v.daily_rate is not null and v.daily_rate > 0;

-- prove it: nothing plate-shaped may survive in the public view
select count(*) as public_cars,
       count(*) filter (where name ~ '[A-Z]{2,3}[- ]?[0-9]{3,4}') as leaking_a_plate
  from v_public_vehicles;
