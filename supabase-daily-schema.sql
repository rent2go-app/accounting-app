-- ============================================================
-- Rent 2 Go — Daily Sheet schema (matches the live daily-block app)
-- Paste this whole file into: Supabase → SQL Editor → New query → Run
-- Safe to re-run (idempotent). RLS locks every table to signed-in users.
-- ============================================================

-- ---- App settings: one row holding opening balance + FX ------
create table if not exists app_settings (
  id             int primary key default 1 check (id = 1),
  opening_balance numeric(14,2) not null default 0,
  fx_zar         numeric(12,4) not null default 18.3,
  fx_aed         numeric(12,4) not null default 3.6725,
  sa_currency    text not null default 'ZAR' check (sa_currency in ('ZAR','AED')),
  updated_at     timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- ---- Ledger lines: one row per entry on a day -----------------
-- kind: deposit  = a Stripe transfer (money in, no category needed)
--       income   = a named income line (John Payment, Telco, …)
--       expense  = a cost, classified by category + paid flag
--       adjustment = reconciliation to the sheet (kept out of income/expense reports)
create table if not exists ledger_lines (
  id          bigint generated always as identity primary key,
  day         date    not null,
  kind        text    not null check (kind in ('deposit','income','expense','adjustment')),
  description text    not null default '',
  amount      numeric(14,2) not null default 0,
  category    text,
  paid        boolean not null default false,
  color       text,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ledger_lines_day_idx      on ledger_lines(day);
create index if not exists ledger_lines_kind_idx     on ledger_lines(kind);
create index if not exists ledger_lines_category_idx on ledger_lines(category);

-- keep updated_at fresh
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
drop trigger if exists trg_touch_ledger on ledger_lines;
create trigger trg_touch_ledger before update on ledger_lines
  for each row execute function touch_updated_at();

-- ---- Reporting views -----------------------------------------
-- Real money in/out per day (adjustments excluded, like the app KPIs)
create or replace view v_daily as
select
  day,
  coalesce(sum(amount) filter (where kind in ('deposit','income')), 0) as income_real,
  coalesce(sum(amount) filter (where kind = 'expense'), 0)             as expense_out,
  coalesce(sum(amount) filter (where kind = 'adjustment'), 0)          as adjustment
from ledger_lines
group by day
order by day;

-- Expense totals by category (drives P&L / expense reports)
create or replace view v_expense_by_category as
select category,
       count(*) as lines,
       sum(amount) as total,
       sum(amount) filter (where paid)      as paid_total,
       sum(amount) filter (where not paid)  as unpaid_total
from ledger_lines
where kind = 'expense'
group by category
order by total desc;

-- ---- Row Level Security --------------------------------------
alter table app_settings  enable row level security;
alter table ledger_lines  enable row level security;

drop policy if exists "auth read/write settings" on app_settings;
create policy "auth read/write settings" on app_settings
  for all to authenticated using (true) with check (true);

drop policy if exists "auth read/write lines" on ledger_lines;
create policy "auth read/write lines" on ledger_lines
  for all to authenticated using (true) with check (true);

-- Done. Next: Authentication → Providers → Email (on), then add yourself as a user.
