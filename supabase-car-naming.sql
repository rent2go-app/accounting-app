-- One naming protocol everywhere: MAKE MODEL - YEAR - COLOUR, in capitals.
-- The public view builds it from the columns, so it can never pick up the plate
-- that the internal name carries for telling identical cars apart.
create or replace view v_public_vehicles as
select
  v.id,
  upper(nullif(trim(both ' -' from concat_ws(' ',
    v.make, v.model,
    case when v.year  is not null then '- ' || v.year::text end,
    case when v.color is not null then '- ' || v.color end)), '')) as name,
  v.make, v.model, v.year, v.type, v.color, v.fuel, v.seats, v.doors, v.transmission,
  v.daily_rate as rate,
  v.images,
  v.available,
  v.description
from vehicles v
where v.status = 'live' and v.daily_rate is not null and v.daily_rate > 0;
select name from v_public_vehicles order by name limit 6;
