-- ============================================================
-- The signed-in renter's current car.
--
-- The dashboard was reading `bookings`, which only ever holds rentals that
-- started through website checkout. Nearly every real rental starts as a Stripe
-- subscription instead, so those renters saw an empty dashboard with no car on
-- it. This exposes the car they are actually in, whichever way it began.
-- ============================================================
create or replace view v_my_rental as
select
  r.id                as renter_id,
  v.id                as vehicle_id,
  v.name              as vehicle,
  v.make, v.model, v.year, v.color, v.type, v.plate,
  v.images,
  v.daily_rate,
  v.account_label,
  f.portal_url,
  s.id                as subscription_id,
  s.status            as subscription_status,
  s.started_at,
  s.current_period_end,
  s.daily_amount
from renters r
join vehicles v on v.id = r.current_vehicle_id
left join fleet_accounts f on f.label = v.account_label
left join lateral (
  select s2.*
    from stripe_product_map m
    join renter_subscriptions s2
      on s2.account_label = m.account_label and s2.product_id = m.product_id
   where m.vehicle_id = v.id
     and m.confidence in ('auto','confirmed')
     and s2.status in ('active','past_due','unpaid','trialing')
   order by s2.updated_at desc
   limit 1
) s on true
where r.auth_uid = auth.uid();

revoke all on v_my_rental from anon, authenticated;
grant select on v_my_rental to authenticated;
select count(*) as rows_visible_to_service_role from v_my_rental;
