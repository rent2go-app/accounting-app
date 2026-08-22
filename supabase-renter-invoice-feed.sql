-- ============================================================
-- What a renter sees on their dashboard: their own Stripe invoices, listed the
-- way Stripe lists them — open, and open-and-past-due — each with the hosted
-- invoice URL so it is paid through Stripe rather than anything we rebuild.
--
-- Scoped to renters who are ACTUALLY RENTING. An invoice belonging to someone
-- whose subscription has ended is history, not a bill to chase, and mixing the
-- two made the outstanding figure read four times its real size.
-- ============================================================

-- who is currently renting: a customer with a live subscription on any fleet
create or replace view v_active_customers as
select distinct s.account_label, s.customer_id, s.customer_email, s.customer_name
  from renter_subscriptions s
 where s.status in ('active','past_due','unpaid','trialing')
   and s.customer_id is not null;

-- every invoice for those customers, with Stripe's own status vocabulary
create or replace view v_renter_invoices as
select
  i.id,
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
  case
    when i.status = 'paid' then 'paid'
    when i.status = 'open' and i.due_date is not null and i.due_date < current_date then 'past_due'
    when i.status = 'open' then 'open'
    else i.status
  end as pay_status
from renter_invoices i
join v_active_customers a
  on a.account_label = i.account_label and a.customer_id = i.customer_id;

-- the signed-in renter's own bills, newest first
create or replace view v_my_invoices as
select v.*
  from v_renter_invoices v
  join renters r on r.id = v.renter_id
 where r.auth_uid = auth.uid();

-- what each active renter owes right now
create or replace view v_renter_balance as
select
  renter_id,
  account_label,
  customer_id,
  count(*) filter (where pay_status in ('open','past_due'))            as open_count,
  count(*) filter (where pay_status = 'past_due')                      as past_due_count,
  count(*) filter (where pay_status in ('open','past_due') and is_late_fee) as late_fees,
  coalesce(sum(amount_due) filter (where pay_status in ('open','past_due')), 0) as balance
from v_renter_invoices
group by renter_id, account_label, customer_id;

select
  (select count(*) from v_active_customers)                                as active_customers,
  (select count(*) from v_renter_invoices where pay_status = 'open')       as open_invoices,
  (select count(*) from v_renter_invoices where pay_status = 'past_due')   as past_due_invoices,
  (select round(sum(balance),2) from v_renter_balance)                     as total_outstanding;
