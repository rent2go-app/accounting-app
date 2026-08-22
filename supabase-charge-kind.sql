-- Label what each charge actually is.
--
-- is_late_fee was 'amount_due = $10.00'. That worked for the standard late fee
-- and missed everything else: a $554 accumulated late-fee invoice read as an
-- ordinary daily rental, and deposits between $150 and $352.65 were unlabelled.
-- The words on the invoice are what say what it is, so classify on those and
-- keep the amount only as a fallback.
--
-- charge_kind: rental | late_fee | deposit | other

alter table public.renter_invoices add column if not exists charge_kind text;

update public.renter_invoices
   set charge_kind = case
         when coalesce(description,'') ~* '(late\s*(fee|pymt|payment)|^late)' then 'late_fee'
         when coalesce(description,'') ~* 'deposit'                            then 'deposit'
         when coalesce(description,'') ~* '^[0-9]+ (x|\u00d7) '                    then 'rental'
         when amount_due = 10.00                                               then 'late_fee'
         else 'other'
       end
 where charge_kind is distinct from case
         when coalesce(description,'') ~* '(late\s*(fee|pymt|payment)|^late)' then 'late_fee'
         when coalesce(description,'') ~* 'deposit'                            then 'deposit'
         when coalesce(description,'') ~* '^[0-9]+ (x|\u00d7) '                    then 'rental'
         when amount_due = 10.00                                               then 'late_fee'
         else 'other'
       end;

-- keep is_late_fee honest too, since the dashboard and the admin both read it
update public.renter_invoices set is_late_fee = (charge_kind = 'late_fee')
 where is_late_fee is distinct from (charge_kind = 'late_fee');

drop view if exists public.v_my_invoices;

create or replace view public.v_renter_invoices as
 SELECT i.id,
    i.renter_id,
    i.account_label,
    i.customer_id,
    i.number,
    i.description,
    i.amount_due,
    i.amount_paid,
    i.is_late_fee,
    i.due_date,
    i.issued_at,
    i.paid_at,
    i.hosted_invoice_url,
        CASE
            WHEN i.status = 'paid'::text THEN 'paid'::text
            WHEN i.status = 'open'::text AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE THEN 'past_due'::text
            WHEN i.status = 'open'::text THEN 'open'::text
            ELSE i.status
        END AS pay_status,
    i.invoice_pdf,
    i.charge_kind
   FROM renter_invoices i
     JOIN v_active_customers a ON a.account_label = i.account_label AND a.customer_id = i.customer_id;

create view public.v_my_invoices as
select v.id, v.renter_id, v.account_label, v.customer_id, v.number, v.description,
       v.amount_due, v.amount_paid, v.is_late_fee, v.due_date, v.issued_at, v.paid_at,
       v.hosted_invoice_url, v.pay_status, v.invoice_pdf, v.charge_kind
  from public.v_renter_invoices v
  join public.renters r on r.id = v.renter_id
 where r.auth_uid = auth.uid();

grant select on public.v_renter_invoices to authenticated;
grant select on public.v_my_invoices to authenticated;
notify pgrst, 'reload schema';
