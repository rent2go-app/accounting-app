-- Remove the TESTING 2 car from the system.
--
-- Its Stripe subscription was cancelled first, deliberately: deleting our records
-- while the subscription was still live would have left it billing $1 a day with
-- nothing in the app pointing at it, which is worse than leaving it alone.
--
-- TESTING 1 (c_testing1) is left in place - there is still testing to do.
--
-- The test invoice and subscription rows go too. They are not history worth
-- keeping and they were counting toward the paid-to-date figures renters see.

begin;

-- the test renter keeps their account, but is no longer in this car
update public.renters set current_vehicle_id = null where current_vehicle_id = 'c_testing2';

-- nothing may map a Stripe product to a car that no longer exists
delete from public.stripe_product_map where vehicle_id = 'c_testing2';

delete from public.renter_invoices
 where customer_id = 'cus_V7KZtbWVxrTvJW'
    or subscription_id in (select id from public.renter_subscriptions where vehicle_id = 'c_testing2');

delete from public.renter_subscriptions where vehicle_id = 'c_testing2';
delete from public.bookings              where vehicle_id = 'c_testing2';
update public.stripe_sync_log set vehicle_id = null where vehicle_id = 'c_testing2';

delete from public.vehicles where id = 'c_testing2';

commit;
