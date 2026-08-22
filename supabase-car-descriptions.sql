-- A short, honest line about each model so the catalogue detail page reads as
-- something written about that car rather than generic filler.
-- Appended to the end of the view: CREATE OR REPLACE cannot reorder columns.
alter table vehicles add column if not exists description text;

create or replace view v_public_vehicles as
select
  v.id,
  nullif(trim(both ' -' from concat_ws(' ',
    v.make, v.model,
    case when v.year is not null then '- ' || v.year::text end,
    case when v.color is not null then '- ' || v.color end)), '') as name,
  v.make, v.model, v.year, v.type, v.color, v.fuel, v.seats, v.doors, v.transmission,
  v.daily_rate as rate,
  v.images,
  v.available,
  v.description
from vehicles v
where v.status = 'live' and v.daily_rate is not null and v.daily_rate > 0;
select 'ok' as done;
