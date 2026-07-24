-- ============================================================================
-- AfriversalAI Internal Accounting — Database Schema
-- Cash-flow ledger: one tagged stream, multi-entity, multi-currency (USD/ZAR/AED)
-- Source of truth for the accounting app. Apply in the Supabase SQL editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Reference: currencies + exchange rates
-- ---------------------------------------------------------------------------
create table if not exists currencies (
  code        text primary key,          -- 'USD', 'ZAR', 'AED'
  symbol      text not null,             -- '$', 'R', 'د.إ'
  name        text not null,
  is_base     boolean not null default false, -- exactly one true (operating currency)
  sort_order  int not null default 0
);

insert into currencies (code, symbol, name, is_base, sort_order) values
  ('USD', '$',   'US Dollar',       true,  1),
  ('ZAR', 'R',   'South African Rand', false, 2),
  ('AED', 'د.إ', 'UAE Dirham',      false, 3)
on conflict (code) do nothing;

-- Stored conversion rates, dated so history stays accurate as rates move.
-- rate = how many `to_code` per 1 `from_code`  (e.g. USD->ZAR ≈ 16.3, USD->AED ≈ 3.6725)
create table if not exists exchange_rates (
  id          bigserial primary key,
  from_code   text not null references currencies(code),
  to_code     text not null references currencies(code),
  rate        numeric(18,6) not null check (rate > 0),
  as_of       date not null default current_date,
  created_at  timestamptz not null default now(),
  unique (from_code, to_code, as_of)
);

-- ---------------------------------------------------------------------------
-- Entities: the three "books" we tag against (kept as one ledger)
-- ---------------------------------------------------------------------------
create table if not exists entities (
  id          bigserial primary key,
  code        text unique not null,      -- 'personal', 'r2g', 'mmf'
  name        text not null,             -- 'Personal / Home', 'GoRentaRide', 'Makhosi Michaela Foundation'
  color       text,                      -- hex for UI chips
  sort_order  int not null default 0
);

insert into entities (code, name, color, sort_order) values
  ('personal', 'Personal / Home',              '#2563eb', 1),
  ('r2g',      'GoRentaRide (R2G)',            '#059669', 2),
  ('mmf',      'Makhosi Michaela Foundation',  '#d97706', 3)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Accounts: cash pots that carry a running balance
-- ---------------------------------------------------------------------------
create table if not exists accounts (
  id            bigserial primary key,
  name          text not null,            -- 'Current Bank', 'Savings', 'Cash'
  currency_code text not null references currencies(code) default 'USD',
  opening_balance numeric(14,2) not null default 0,
  opening_date  date not null default current_date,
  is_active     boolean not null default true,
  sort_order    int not null default 0
);

-- ---------------------------------------------------------------------------
-- Categories: hierarchical, typed
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id          bigserial primary key,
  name        text not null,
  kind        text not null check (kind in ('income','expense','transfer','savings')),
  -- Top-level bucket for the daily-entry mental model:
  -- Income / Business / Maintenance / Home / Other
  bucket      text not null default 'Other'
                check (bucket in ('Income','Business','Maintenance','Home','Other')),
  entity_id   bigint references entities(id),  -- optional default entity
  sort_order  int not null default 0,
  unique (name)
);

-- Seed categories around the daily workflow: Stripe income in, then expenses
-- separated into Business / Home / Repairs & Maintenance / Other.
insert into categories (name, kind, bucket, sort_order) values
  ('Stripe Income',            'income',   'Income',       1),
  ('Owner Car Income',         'income',   'Income',       2),
  ('Other Income',             'income',   'Income',       3),
  ('Staff Pay',                'expense',  'Business',     10),
  ('Owner Payouts (GRAR)',     'expense',  'Business',     11),
  ('Subscriptions & Software', 'expense',  'Business',     12),
  ('Fuel & Transport',         'expense',  'Business',     13),
  ('Other Business Expense',   'expense',  'Business',     14),
  ('Vehicle Maintenance',      'expense',  'Maintenance',  20),
  ('Household',                'expense',  'Home',         30),
  ('SA Transfers',             'transfer', 'Home',         31),
  ('MMF / Foundation',         'expense',  'Home',         32),
  ('Trustee Payments',         'expense',  'Other',        40),
  ('Savings Goals',            'savings',  'Other',        41),
  ('Uncategorized',            'expense',  'Other',        99)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Payment series: numbered recurring payments (Trustee 5/8, Langa Computer 3/8)
-- ---------------------------------------------------------------------------
create table if not exists payment_series (
  id            bigserial primary key,
  name          text not null,           -- 'Trustee Payment — Feb', 'Langa Computer'
  entity_id     bigint references entities(id),
  total_count   int,                     -- e.g. 8
  target_total  numeric(14,2),           -- e.g. 5000.00
  is_open       boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Transactions: the core ledger line
-- ---------------------------------------------------------------------------
create table if not exists transactions (
  id             bigserial primary key,
  tx_date        date not null,
  description    text not null,
  payee          text,                    -- 'Terrence', 'Ndaba', 'John', 'Reddam'
  direction      text not null check (direction in ('in','out','transfer')),

  -- Native amount as entered
  amount         numeric(14,2) not null check (amount >= 0),
  currency_code  text not null references currencies(code) default 'USD',

  -- Converted equivalent in base currency (for balances & reporting)
  base_amount    numeric(14,2),           -- filled via rate at entry time
  base_code      text references currencies(code) default 'USD',
  fx_rate        numeric(18,6),           -- rate used (native -> base)

  account_id     bigint references accounts(id),
  category_id    bigint references categories(id),
  entity_id      bigint references entities(id),
  series_id      bigint references payment_series(id),
  series_index   int,                     -- the "5" in 5/8

  status         text not null default 'actual'
                   check (status in ('expected','actual','paid')),
  notes          text,
  source_ref     text,                    -- e.g. 'sheet:JAN:02' for imported rows

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tx_date_idx     on transactions (tx_date);
create index if not exists tx_entity_idx   on transactions (entity_id);
create index if not exists tx_category_idx on transactions (category_id);
create index if not exists tx_account_idx  on transactions (account_id);

-- ---------------------------------------------------------------------------
-- Budgets: monthly budget-vs-actual (the SA-[MONTH] sheets)
-- ---------------------------------------------------------------------------
create table if not exists budgets (
  id            bigserial primary key,
  period_month  date not null,            -- first day of month
  category_id   bigint references categories(id),
  entity_id     bigint references entities(id),
  budget_amount numeric(14,2) not null default 0,
  currency_code text not null references currencies(code) default 'USD',
  unique (period_month, category_id, entity_id)
);

-- ---------------------------------------------------------------------------
-- Bank snapshots: the ACTUAL bank balance entered per day, for daily
-- reconciliation against the computed running total.
-- ---------------------------------------------------------------------------
create table if not exists bank_balances (
  id            bigserial primary key,
  as_of         date not null,
  balance       numeric(14,2) not null,
  currency_code text not null references currencies(code) default 'USD',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (as_of, currency_code)
);

-- ---------------------------------------------------------------------------
-- Budget plan: simple monthly expected income / expenses for the projection
-- ("possible future" view running on projected inputs). Detailed per-category
-- budgets live in `budgets`; this drives the forward running-balance forecast.
-- ---------------------------------------------------------------------------
create table if not exists budget_plan (
  id               bigserial primary key,
  period_month     date not null unique,     -- first day of month
  expected_income  numeric(14,2) not null default 0,
  expected_expense numeric(14,2) not null default 0,
  currency_code    text not null references currencies(code) default 'USD',
  note             text,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security — lock to authenticated users (internal tool)
-- ---------------------------------------------------------------------------
alter table currencies      enable row level security;
alter table exchange_rates  enable row level security;
alter table entities        enable row level security;
alter table accounts        enable row level security;
alter table categories      enable row level security;
alter table payment_series  enable row level security;
alter table transactions    enable row level security;
alter table budgets         enable row level security;
alter table bank_balances   enable row level security;
alter table budget_plan     enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'currencies','exchange_rates','entities','accounts',
    'categories','payment_series','transactions','budgets','bank_balances','budget_plan'
  ]
  loop
    execute format(
      'create policy %I_auth_all on %I for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helper view: transactions with running balance in base currency
-- ---------------------------------------------------------------------------
create or replace view v_ledger as
select
  t.*,
  e.name  as entity_name,
  c.name  as category_name,
  a.name  as account_name,
  sum(case when t.direction = 'in'  then coalesce(t.base_amount,0)
           when t.direction = 'out' then -coalesce(t.base_amount,0)
           else 0 end)
    over (partition by t.account_id order by t.tx_date, t.id
          rows between unbounded preceding and current row) as running_base_balance
from transactions t
left join entities   e on e.id = t.entity_id
left join categories c on c.id = t.category_id
left join accounts   a on a.id = t.account_id;

-- ---------------------------------------------------------------------------
-- Daily snapshot: per-day money in / out and the closing bank balance
-- carried forward day to day (in base currency). This is the core output.
-- ---------------------------------------------------------------------------
create or replace view v_daily_balance as
with opening as (
  select coalesce(sum(opening_balance), 0) as amt from accounts
),
per_day as (
  select
    tx_date,
    sum(case when direction = 'in'  then coalesce(base_amount,0) else 0 end) as money_in,
    sum(case when direction = 'out' then coalesce(base_amount,0) else 0 end) as money_out
  from transactions
  group by tx_date
)
computed as (
  select
    d.tx_date,
    d.money_in,
    d.money_out,
    (d.money_in - d.money_out) as net,
    (select amt from opening)
      + sum(d.money_in - d.money_out) over (order by d.tx_date
          rows between unbounded preceding and current row) as closing_balance
  from per_day d
)
select
  c.tx_date,
  c.money_in,
  c.money_out,
  c.net,
  c.closing_balance,                       -- computed running total
  b.balance      as actual_balance,        -- entered bank balance (USD snapshot)
  (b.balance - c.closing_balance) as variance  -- actual minus computed; 0 = reconciled
from computed c
left join bank_balances b
  on b.as_of = c.tx_date and b.currency_code = 'USD'
order by c.tx_date;
