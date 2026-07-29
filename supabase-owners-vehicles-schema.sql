-- Shared owners + vehicles tables — the single source of truth for owner/fleet data across BOTH
-- the customer prototype (front-end, where owners sign up) and this admin app (owners.html, GPS, billing).
-- Phase A: create tables + copy existing owners_program data in. The owners_program JSON blob is left
-- INTACT so current billing/statements keep working until Phase B repoints them and retires the blob.
-- RLS: admins (authenticated) get full access; owner-intake writes with the service_role key (bypasses RLS).

create table if not exists owners (
  id            text primary key default ('o_' || substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  auth_uid      uuid unique references auth.users(id) on delete set null,

  -- identity
  name          text default '',          -- display / legal / business display name (was owners_program.name)
  owner_name    text,                     -- contact person (was ownerName)
  first         text,
  last          text,
  email         text,
  phone         text,

  -- business
  account_type  text default 'individual' check (account_type in ('individual','business')),
  business_name text,                     -- bizName / businessName
  ein           text,

  -- driver identity (from prototype signup)
  dob           date,
  license       text,
  lic_state     text,
  contact_pref  text,

  -- address
  addr          text,
  country       text,

  -- payout / billing account mapping (from this app)
  payout        text,
  bank_name     text,
  bank_last4    text,
  stripe_label  text,                     -- stripeLabel — which Stripe account owns their billing
  stripe_biz_id text,                     -- stripeBizId
  cadence       text,                     -- billing cadence (weekly/monthly…)
  pay_day       int,                      -- day-of-month (was owners_program.day)
  weekday       text,
  tag           text,

  stripe_account text,                    -- which Stripe account ran their Identity check
  -- Stripe Identity (owners verify too; results synced by id-verify)
  session_id    text,
  verify_url    text,
  verify_status text,                     -- new|requires_input|processing|verified|canceled
  verified_name text, verified_dob date, verified_doc_type text,
  verified_doc_number text, verified_expiry date, verified_address text, last_error text,

  -- lifecycle
  status        text not null default 'pending' check (status in ('pending','approved','active','rejected')),
  id_verified   boolean not null default false,
  signature     text,
  agreed_at     text,

  -- onboarding extras (kept as-is from the wizard)
  docs          jsonb default '{}'::jsonb,
  services      jsonb default '{}'::jsonb,
  gps           jsonb default '{}'::jsonb,

  source        text default 'admin',     -- prototype | admin | migrated
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists vehicles (
  id            text primary key default ('c_' || substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  owner_id      text references owners(id) on delete set null,

  name          text,                     -- display name (was cars[].name, e.g. "2016 Elantra")
  make          text,
  model         text,
  year          int,
  type          text,                     -- Sedan/SUV/…
  vin           text,
  plate         text,

  -- billing
  rate          numeric,                  -- period rate charged to renter / platform basis
  days          int,                      -- billing days

  -- lifecycle
  status        text not null default 'pending' check (status in ('pending','live','maintenance','retired')),
  available     boolean not null default false,

  -- GPS link (reuse the SareKon linkage used elsewhere)
  sarekon_device_id    text,
  sarekon_device_label text,

  -- onboarding extras
  images        jsonb default '[]'::jsonb,
  docs          jsonb default '{}'::jsonb,
  eligibility   jsonb default '{}'::jsonb,
  gps           jsonb default '{}'::jsonb,

  source        text default 'admin',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_vehicles_owner on vehicles(owner_id);
create index if not exists idx_owners_email   on owners(lower(email));
create index if not exists idx_owners_session on owners(session_id);

alter table owners   enable row level security;
alter table vehicles enable row level security;

-- Admins (any authenticated admin session) manage everything; service_role (owner-intake) bypasses RLS.
drop policy if exists owners_admin_all on owners;
create policy owners_admin_all on owners for all to authenticated using (true) with check (true);
drop policy if exists vehicles_admin_all on vehicles;
create policy vehicles_admin_all on vehicles for all to authenticated using (true) with check (true);
