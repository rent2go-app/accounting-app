-- Last pass. What was left in "other" was 305 invoices worth $27,521 - all of
-- them car names on manual, non-subscription invoices: "KIA OPTIMA 2016 - BLACK",
-- "VW JETTA 2014. - BLUE". Those are rentals someone billed by hand instead of
-- through a subscription, and a renter reading their history should see them as
-- rentals, not as an unexplained "other".
--
-- A model year is the tell. Fee wording is still checked first, so a late fee
-- that happens to name the car stays a late fee.

create or replace function public.r2g_charge_kind(descr text, amount numeric, sub text)
returns text language sql immutable as $$
  select case
    when coalesce(descr,'') ~* '(late\s*(fee|pymt|payment)|past\s*due|^\s*late\b)' then 'late_fee'
    when coalesce(descr,'') ~* 'deposit'                                           then 'deposit'
    when coalesce(descr,'') ~* 'toll'                                              then 'toll'
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
