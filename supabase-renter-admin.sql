-- ============================================================
-- Renters, organised the way the office actually works:
--   ACTIVE   — someone is billing them right now
--   ARCHIVED — a past customer; nothing live
-- grouped by the owner fleet their car belongs to.
-- ============================================================
alter table renters add column if not exists archived_at timestamptz;

create or replace view v_admin_renters as
with live as (
  select distinct lower(customer_email) as email, account_label, customer_id, customer_name
    from renter_subscriptions
   where status in ('active','past_due','unpaid','trialing') and customer_email is not null
),
bal as (
  select renter_id, sum(balance) as balance, sum(open_count) as open_count,
         sum(past_due_count) as past_due_count, sum(late_fees) as late_fees
    from v_renter_balance group by renter_id
)
select
  r.id,
  r.name,
  r.email,
  r.phone,
  r.status              as id_status,
  r.decision,
  (r.auth_uid is not null)                       as has_login,
  (l.email is not null)                          as is_active,
  case when l.email is not null then 'ACTIVE' else 'ARCHIVED' end as bucket,
  coalesce(l.account_label, v.account_label, r.account_label)     as fleet,
  o.name                as owner_name,
  v.id                  as vehicle_id,
  v.name                as vehicle,
  v.plate,
  f.portal_url,
  coalesce(b.balance,0)        as balance,
  coalesce(b.open_count,0)     as open_invoices,
  coalesce(b.past_due_count,0) as past_due_invoices,
  coalesce(b.late_fees,0)      as late_fees,
  r.created_at
from renters r
left join live           l on l.email  = lower(r.email)
left join vehicles       v on v.id     = r.current_vehicle_id
left join owners         o on o.id     = v.owner_id
left join fleet_accounts f on f.label  = coalesce(l.account_label, v.account_label, r.account_label)
left join bal            b on b.renter_id = r.id;

select bucket, count(*) as renters, count(*) filter (where has_login) as with_login
  from v_admin_renters group by bucket order by bucket;
