-- ============================================================
-- Every live car carries the Stripe account that bills it, so a renter's daily
-- invoices and their customer portal always resolve to the right place.
--
--   vehicle -> billing account -> fleet_accounts.portal_url
--
-- Previously the portal came from renters.account_label, which is a property of
-- the person rather than the car they are actually in. If a renter swaps to a
-- car on a different fleet, the person-based link sends them to the wrong
-- portal. The car is the reliable anchor.
-- ============================================================

alter table vehicles add column if not exists account_label text;

-- backfill from the product map — the product that holds the car is the account
-- that bills it
update vehicles v
   set account_label = m.account_label
  from stripe_product_map m
 where m.vehicle_id = v.id
   and m.confidence in ('auto','confirmed')
   and v.account_label is distinct from m.account_label;

-- one place to ask "who bills this car, and where does its renter pay?"
create or replace view v_vehicle_billing as
select v.id            as vehicle_id,
       v.name          as vehicle,
       v.plate,
       v.status,
       v.available,
       v.owner_id,
       o.name          as owner_name,
       v.account_label,
       f.portal_url,
       v.daily_rate
  from vehicles v
  left join owners         o on o.id    = v.owner_id
  left join fleet_accounts f on f.label = v.account_label;

-- A renter's portal now follows the car they are in, and only falls back to the
-- account recorded against the person when no car is linked.
create or replace view v_my_portal as
select r.id            as renter_id,
       r.auth_uid,
       coalesce(vf.label, rf.label)          as account_label,
       coalesce(vf.portal_url, rf.portal_url) as portal_url
  from renters r
  left join vehicles       v  on v.id    = r.current_vehicle_id
  left join fleet_accounts vf on vf.label = v.account_label
  left join fleet_accounts rf on rf.label = r.account_label;

select
  (select count(*) from vehicles where status='live')                              as live_cars,
  (select count(*) from vehicles where status='live' and account_label is not null) as live_with_billing_account,
  (select count(*) from v_vehicle_billing where status='live' and portal_url is not null) as live_with_a_portal;
