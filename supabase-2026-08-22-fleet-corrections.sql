-- Three corrections from the yard, 22 August 2026.
--
-- 1. Kia Optima 2019 BLUE (MCK6948) is off the road for repairs until Monday.
--    There are two 2019 Optimas; the GRAY one (MBE-4287) is out with a renter and
--    is deliberately untouched. The BLUE one is the car Kimberly moved out of.
--
-- 2. Kimberly Ross is in the Nissan Sentra 2022 as of yesterday and is being
--    billed for it, but she had no renter record at all - so the subscription had
--    nobody to attach to and the car showed as free. Create her, link it.
--
-- 3. Her Stripe product was never mapped to a vehicle, which is why the sync
--    could not move the car by itself. Map it.

-- 1 ------------------------------------------------------------------
update public.vehicles
   set status = 'maintenance',
       notes  = trim(both E'\n' from coalesce(notes,'') || E'\n' ||
                '2026-08-22: off the road for repairs, expected back Monday 2026-08-24.')
 where id = 'c_hf13';

-- 2 ------------------------------------------------------------------
insert into public.renters (name, email, phone, status, decision, account_label,
                            current_vehicle_id, signup_source, notes)
select 'KIMBERLY FRANCINE ROSS', 'kimberlyross161@gmail.com', null,
       'verified', 'approved', 'RENT 2 GO LLC 2.0', 'c_hf4', 'admin',
       '2026-08-22: created from the active Stripe subscription. Confirmed renting the Nissan Sentra 2022.'
 where not exists (select 1 from public.renters where lower(email) = 'kimberlyross161@gmail.com');

update public.renter_subscriptions s
   set renter_id  = r.id,
       vehicle_id = 'c_hf4'
  from public.renters r
 where lower(r.email) = 'kimberlyross161@gmail.com'
   and lower(s.customer_email) = 'kimberlyross161@gmail.com';

-- her invoices belong to her too, now that she exists
update public.renter_invoices i
   set renter_id = r.id
  from public.renters r
 where lower(r.email) = 'kimberlyross161@gmail.com'
   and i.renter_id is null
   and exists (select 1 from public.renter_subscriptions s
                where s.id = i.subscription_id and s.renter_id = r.id);

-- 3 ------------------------------------------------------------------
-- The Sentra has moved billing accounts. A vehicle may only map to one Stripe
-- product - that constraint is what stops a car being billed twice - so the old
-- RENT 2 GO - 1.0 mapping has to be released before the LLC 2.0 one can take it.
-- The old product has no live subscriptions, so nothing is being cut off.
update public.stripe_product_map
   set vehicle_id = null, confidence = 'unmatched'
 where account_label = 'RENT 2 GO - 1.0'
   and product_id    = 'prod_Tb85DdBe3CDoKc';

update public.stripe_product_map
   set vehicle_id = 'c_hf4', confidence = 'confirmed'
 where account_label = 'RENT 2 GO LLC 2.0'
   and product_id    = 'prod_UpxNmammiuQVWM';

-- and the car itself is billed from the new account now
update public.vehicles set account_label = 'RENT 2 GO LLC 2.0' where id = 'c_hf4';
