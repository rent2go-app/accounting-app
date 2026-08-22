-- ============================================================
-- Three kinds of person sit in `renters`, and they need different handling:
--
--   ACTIVE      someone is billing them right now
--   ARCHIVED    they have rented before; nothing live
--   APPLICANT   they have never had a subscription — a website sign-up going
--               through ID verification, not a customer yet
--
-- Decided from whether Stripe has ever billed them, not from a flag anyone has
-- to remember to set.
-- ============================================================
drop view if exists v_admin_renters;
create view v_admin_renters as
with any_sub as (
  select lower(customer_email) as email,
         bool_or(status in ('active','past_due','unpaid','trialing')) as live,
         count(*) as subs,
         max(account_label) filter (where status in ('active','past_due','unpaid','trialing')) as live_fleet,
         max(account_label) as last_fleet
    from renter_subscriptions
   where customer_email is not null
   group by lower(customer_email)
),
bal as (
  select renter_id, sum(balance) as balance, sum(open_count) as open_count,
         sum(past_due_count) as past_due_count, sum(late_fees) as late_fees
    from v_renter_balance group by renter_id
)
select
  r.id, r.name, r.email, r.phone,
  r.status   as id_status,          -- Stripe Identity: new / verified / requires_input
  r.decision,                        -- our own approve / reject
  r.verify_url,
  r.signup_source,
  (r.auth_uid is not null) as has_login,
  coalesce(a.live,false)   as is_active,
  case
    when coalesce(a.live,false)     then 'ACTIVE'
    when coalesce(a.subs,0) > 0     then 'ARCHIVED'
    else 'APPLICANT'
  end as bucket,
  coalesce(a.live_fleet, a.last_fleet, v.account_label, r.account_label) as fleet,
  o.name as owner_name,
  v.id as vehicle_id, v.name as vehicle, v.plate,
  f.portal_url,
  coalesce(b.balance,0)        as balance,
  coalesce(b.open_count,0)     as open_invoices,
  coalesce(b.past_due_count,0) as past_due_invoices,
  coalesce(b.late_fees,0)      as late_fees,
  r.created_at
from renters r
left join any_sub a on a.email = lower(r.email)
left join vehicles v on v.id = r.current_vehicle_id
left join owners   o on o.id = v.owner_id
left join fleet_accounts f on f.label = coalesce(a.live_fleet, a.last_fleet, v.account_label, r.account_label)
left join bal b on b.renter_id = r.id;

select bucket, count(*) as people,
       count(*) filter (where has_login)            as with_login,
       count(*) filter (where id_status='verified') as id_verified,
       count(*) filter (where decision='approved')  as approved
  from v_admin_renters group by bucket order by bucket;
