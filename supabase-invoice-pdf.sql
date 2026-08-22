-- Receipts on the renter's own dashboard.
--
-- We already stored hosted_invoice_url, the page a renter pays on. invoice_pdf is
-- the receipt itself - what they actually want after paying, and one of the few
-- things that made them open the Stripe portal at all.
--
-- Both views get the column appended at the very end of their select list, on
-- purpose: Postgres will not let an existing view column be renamed or reordered,
-- so a new one can only go last.

alter table public.renter_invoices add column if not exists invoice_pdf text;

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
    i.invoice_pdf
   FROM renter_invoices i
     JOIN v_active_customers a ON a.account_label = i.account_label AND a.customer_id = i.customer_id;

create view public.v_my_invoices as
select v.id, v.renter_id, v.account_label, v.customer_id, v.number, v.description,
       v.amount_due, v.amount_paid, v.is_late_fee, v.due_date, v.issued_at, v.paid_at,
       v.hosted_invoice_url, v.pay_status, v.invoice_pdf
  from public.v_renter_invoices v
  join public.renters r on r.id = v.renter_id
 where r.auth_uid = auth.uid();

grant select on public.v_renter_invoices to authenticated;
grant select on public.v_my_invoices to authenticated;
notify pgrst, 'reload schema';
