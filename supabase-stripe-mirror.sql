-- ============================================================
-- Rent 2 Go — Stripe as the source of truth
--
-- Stripe already holds the truth about who is renting: an active subscription
-- means a live rental, a cancelled one means it has ended. The website has been
-- guessing at that. These tables mirror it, so the site follows Stripe instead
-- of drifting from it.
--
-- The car is identified by the subscription's PRODUCT NAME ("NISSAN SENTRA 2019
-- - BLACK"). Matching that text on every sync is not safe — colours disagree
-- between systems and two subscriptions can land on one car. So we resolve each
-- product to a vehicle ONCE, store it, and use the stored answer thereafter.
-- ============================================================

-- ---- 1. product -> car, decided once ----
create table if not exists stripe_product_map (
  account_label text not null,
  product_id    text not null,
  product_name  text,
  vehicle_id    text references vehicles(id) on delete set null,
  -- auto      = matched unambiguously by name, year and colour
  -- confirmed = a human picked it in Linda
  -- unmatched = needs a human; the sync will not move a car on this product
  confidence    text not null default 'unmatched'
                check (confidence in ('auto','confirmed','unmatched','no_such_car')),
  note          text,
  confirmed_by  text,
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (account_label, product_id)
);
-- one live car per product, so two subscriptions can never claim the same vehicle
create unique index if not exists stripe_product_map_vehicle_uq
  on stripe_product_map (vehicle_id) where vehicle_id is not null;

-- ---- 2. subscriptions, mirrored ----
create table if not exists renter_subscriptions (
  id                 text primary key,          -- Stripe subscription id
  account_label      text not null,
  customer_id        text,
  customer_email     text,
  customer_name      text,
  status             text,                      -- active | past_due | canceled | ...
  product_id         text,
  product_name       text,
  daily_amount       numeric(10,2),
  current_period_end timestamptz,
  started_at         timestamptz,
  canceled_at        timestamptz,
  renter_id          uuid references renters(id) on delete set null,
  vehicle_id         text references vehicles(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists renter_subscriptions_renter_idx on renter_subscriptions (renter_id);
create index if not exists renter_subscriptions_live_idx on renter_subscriptions (status)
  where status in ('active','past_due','unpaid','trialing');

-- ---- 3. invoices, mirrored (this is what a renter sees on their dashboard) ----
create table if not exists renter_invoices (
  id                 text primary key,          -- Stripe invoice id
  account_label      text not null,
  customer_id        text,
  subscription_id    text,
  renter_id          uuid references renters(id) on delete set null,
  number             text,
  description        text,
  amount_due         numeric(10,2),
  amount_paid        numeric(10,2),
  status             text,                      -- draft | open | paid | void | uncollectible
  is_late_fee        boolean not null default false,
  due_date           date,
  issued_at          timestamptz,
  paid_at            timestamptz,
  hosted_invoice_url text,
  updated_at         timestamptz not null default now()
);
create index if not exists renter_invoices_renter_idx on renter_invoices (renter_id, issued_at desc);
create index if not exists renter_invoices_open_idx on renter_invoices (status) where status = 'open';

-- ---- 4. an audit trail: nothing moves a car without a row here ----
create table if not exists stripe_sync_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  kind            text not null,   -- linked | unlinked | new_subscription | ended | needs_review | error
  detail          text,
  account_label   text,
  subscription_id text,
  renter_id       uuid,
  vehicle_id      text
);
create index if not exists stripe_sync_log_at_idx on stripe_sync_log (at desc);

-- ---- 5. who may see what ----
alter table stripe_product_map    enable row level security;
alter table renter_subscriptions  enable row level security;
alter table renter_invoices       enable row level security;
alter table stripe_sync_log       enable row level security;

drop policy if exists spm_admin on stripe_product_map;
create policy spm_admin on stripe_product_map for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());

drop policy if exists rs_admin on renter_subscriptions;
create policy rs_admin on renter_subscriptions for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());
drop policy if exists rs_own on renter_subscriptions;
create policy rs_own on renter_subscriptions for select to authenticated
  using (renter_id is not null and renter_id = r2g_my_renter_id());

drop policy if exists ri_admin on renter_invoices;
create policy ri_admin on renter_invoices for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());
-- a renter sees their own invoices and nobody else's
drop policy if exists ri_own on renter_invoices;
create policy ri_own on renter_invoices for select to authenticated
  using (renter_id is not null and renter_id = r2g_my_renter_id());

drop policy if exists ssl_admin on stripe_sync_log;
create policy ssl_admin on stripe_sync_log for all to authenticated
  using (r2g_is_admin()) with check (r2g_is_admin());

select 'stripe_product_map' t, count(*) rows from stripe_product_map
union all select 'renter_subscriptions', count(*) from renter_subscriptions
union all select 'renter_invoices', count(*) from renter_invoices
union all select 'stripe_sync_log', count(*) from stripe_sync_log;
