-- Renter sign-in by password.
--
-- The first round of invites went out as magic links and several never landed:
-- the link is ~150 characters of query string and fragment, and SMS and WhatsApp
-- truncate it at the & or the # when they auto-link it. A password has nothing in
-- it for a phone to mangle, does not expire in an hour, and is not spent by the
-- first mail scanner that follows the link.
--
-- renter-access now sets a temporary password on the account and stamps
-- must_set_password on it. The app will not show a renter their dashboard until
-- they have replaced it. This adds the one column the admin needs to tell the two
-- states apart, so nobody has to guess whether an account is still on the
-- password we texted.
--
--   password_set = true   they have chosen their own
--   password_set = false  still on the temporary one we sent
--   password_set = null   no login yet, or created before this change

create or replace view public.v_admin_renters as
 WITH any_sub AS (
         SELECT lower(renter_subscriptions.customer_email) AS email,
            bool_or(renter_subscriptions.status = ANY (ARRAY['active'::text, 'past_due'::text, 'unpaid'::text, 'trialing'::text])) AS live,
            count(*) AS subs,
            max(renter_subscriptions.account_label) FILTER (WHERE renter_subscriptions.status = ANY (ARRAY['active'::text, 'past_due'::text, 'unpaid'::text, 'trialing'::text])) AS live_fleet,
            max(renter_subscriptions.account_label) AS last_fleet
           FROM renter_subscriptions
          WHERE renter_subscriptions.customer_email IS NOT NULL
          GROUP BY (lower(renter_subscriptions.customer_email))
        ), bal AS (
         SELECT v_renter_balance.renter_id,
            sum(v_renter_balance.balance) AS balance,
            sum(v_renter_balance.open_count) AS open_count,
            sum(v_renter_balance.past_due_count) AS past_due_count,
            sum(v_renter_balance.late_fees) AS late_fees
           FROM v_renter_balance
          GROUP BY v_renter_balance.renter_id
        )
 SELECT r.id,
    r.name,
    r.email,
    r.phone,
    r.status AS id_status,
    r.decision,
    r.verify_url,
    r.signup_source,
    r.auth_uid IS NOT NULL AS has_login,
    u.last_sign_in_at,
    u.last_sign_in_at IS NOT NULL AS has_signed_in,
    u.created_at AS account_created_at,
    COALESCE(v.id, ''::text) ~~ 'c_testing%'::text OR lower(r.email) = 'ntandodavis@gmail.com'::text AS is_test,
    COALESCE(a.live, false) AS is_active,
        CASE
            WHEN COALESCE(a.live, false) THEN 'ACTIVE'::text
            WHEN COALESCE(a.subs, 0::bigint) > 0 THEN 'ARCHIVED'::text
            ELSE 'APPLICANT'::text
        END AS bucket,
    COALESCE(a.live_fleet, a.last_fleet, v.account_label, r.account_label) AS fleet,
    o.name AS owner_name,
    v.id AS vehicle_id,
    v.name AS vehicle,
    v.plate,
    f.portal_url,
    COALESCE(b.balance, 0::numeric) AS balance,
    COALESCE(b.open_count, 0::numeric) AS open_invoices,
    COALESCE(b.past_due_count, 0::numeric) AS past_due_invoices,
    COALESCE(b.late_fees, 0::numeric) AS late_fees,
    r.created_at,
    (u.raw_user_meta_data ->> 'must_set_password') = 'false' AS password_set
   FROM renters r
     LEFT JOIN auth.users u ON u.id = r.auth_uid
     LEFT JOIN any_sub a ON a.email = lower(r.email)
     LEFT JOIN vehicles v ON v.id = r.current_vehicle_id
     LEFT JOIN owners o ON o.id = v.owner_id
     LEFT JOIN fleet_accounts f ON f.label = COALESCE(a.live_fleet, a.last_fleet, v.account_label, r.account_label)
     LEFT JOIN bal b ON b.renter_id = r.id;

grant select on public.v_admin_renters to authenticated;
notify pgrst, 'reload schema';
