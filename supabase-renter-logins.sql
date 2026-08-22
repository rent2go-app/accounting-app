-- ============================================================
-- Who has actually used the login we sent them.
--
-- auth.users holds last_sign_in_at. It is not reachable from the browser, so we
-- surface just the two columns the office needs through the admin view, which is
-- already admin-only.
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
  r.status as id_status, r.decision, r.verify_url, r.signup_source,
  (r.auth_uid is not null) as has_login,
  u.last_sign_in_at,
  (u.last_sign_in_at is not null) as has_signed_in,
  u.created_at as account_created_at,
  -- a test account should sit at the top of the list, not lost among 34 real ones
  (coalesce(v.id,'') like 'c_testing%' or lower(r.email) = 'ntandodavis@gmail.com') as is_test,
  coalesce(a.live,false) as is_active,
  case
    when coalesce(a.live,false) then 'ACTIVE'
    when coalesce(a.subs,0) > 0 then 'ARCHIVED'
    else 'APPLICANT'
  end as bucket,
  coalesce(a.live_fleet, a.last_fleet, v.account_label, r.account_label) as fleet,
  o.name as owner_name,
  v.id as vehicle_id, v.name as vehicle, v.plate,
  f.portal_url,
  coalesce(b.balance,0) as balance,
  coalesce(b.open_count,0) as open_invoices,
  coalesce(b.past_due_count,0) as past_due_invoices,
  coalesce(b.late_fees,0) as late_fees,
  r.created_at
from renters r
left join auth.users u on u.id = r.auth_uid
left join any_sub a on a.email = lower(r.email)
left join vehicles v on v.id = r.current_vehicle_id
left join owners o on o.id = v.owner_id
left join fleet_accounts f on f.label = coalesce(a.live_fleet, a.last_fleet, v.account_label, r.account_label)
left join bal b on b.renter_id = r.id;

select bucket,
       count(*) as people,
       count(*) filter (where has_login)     as with_login,
       count(*) filter (where has_signed_in) as have_signed_in
  from v_admin_renters group by bucket order by bucket;
