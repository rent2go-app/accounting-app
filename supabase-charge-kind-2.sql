-- Sharpen the classifier after seeing what actually landed in "other".
--
-- Three things were misfiled:
--   "Past Due" / "Past Due Fees" are late fees by another name
--   "Toll Charges" deserve their own label - they are passed through, not ours
--   a bare car name ("KIA OPTIMA 2016 - BLACK") is a rental billed without the
--   "N x" prefix, and the invoice carrying a subscription_id proves it
--
-- The subscription test is the reliable one: an invoice raised by a subscription
-- is a rental unless its wording says otherwise, whatever the description looks
-- like. Wording is checked first so a late fee charged against a subscription is
-- still a late fee.

create or replace function public.r2g_charge_kind(descr text, amount numeric, sub text)
returns text language sql immutable as $$
  select case
    when coalesce(descr,'') ~* '(late\s*(fee|pymt|payment)|past\s*due|^\s*late\b)' then 'late_fee'
    when coalesce(descr,'') ~* 'deposit'                                           then 'deposit'
    when coalesce(descr,'') ~* 'toll'                                              then 'toll'
    when coalesce(descr,'') ~* '^[0-9]+\s*(x|×)\s'                                 then 'rental'
    when sub is not null                                                           then 'rental'
    when amount = 10.00                                                            then 'late_fee'
    else 'other'
  end
$$;

update public.renter_invoices
   set charge_kind = public.r2g_charge_kind(description, amount_due, subscription_id)
 where charge_kind is distinct from public.r2g_charge_kind(description, amount_due, subscription_id);

update public.renter_invoices set is_late_fee = (charge_kind = 'late_fee')
 where is_late_fee is distinct from (charge_kind = 'late_fee');
