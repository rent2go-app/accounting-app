-- Final shape of the classifier.
--
-- charge_kind: rental | late_fee | deposit | toll | fee | other
--
-- "fee" is for the one-off charges that are neither rent nor a late payment:
-- out-of-state travel, smoking fine, mileage, a replaced wheel cover. They were
-- sitting in "other", which tells a renter nothing about why they were charged.
--
-- Order matters. Fee wording is tested before the subscription and model-year
-- rules, so a penalty that names the car is still a penalty.

create or replace function public.r2g_charge_kind(descr text, amount numeric, sub text)
returns text language sql immutable as $$
  select case
    when coalesce(descr,'') ~* '(late\s*(fee|pym|payment)|past\s*due|^\s*late\b)'  then 'late_fee'
    when coalesce(descr,'') ~* 'deposit'                                           then 'deposit'
    when coalesce(descr,'') ~* 'toll'                                              then 'toll'
    when coalesce(descr,'') ~* '(fine|penalt|smok|mileage|replacement|out of state|travel fee|cleaning|damage)'
                                                                                   then 'fee'
    when coalesce(descr,'') ~* '^[0-9]+\s*(x|×)\s'                                 then 'rental'
    when sub is not null                                                           then 'rental'
    when coalesce(descr,'') ~ '(19|20)[0-9]{2}'                                    then 'rental'
    when amount = 10.00                                                            then 'late_fee'
    else 'other'
  end
$$;

update public.renter_invoices
   set charge_kind = public.r2g_charge_kind(description, amount_due, subscription_id)
 where charge_kind is distinct from public.r2g_charge_kind(description, amount_due, subscription_id);

update public.renter_invoices set is_late_fee = (charge_kind = 'late_fee')
 where is_late_fee is distinct from (charge_kind = 'late_fee');
