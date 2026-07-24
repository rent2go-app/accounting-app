# rent2Go-business-accounting-app

Internal accounting & cash-flow app for **Rent 2 Go (GoRentaRide / R2G)**.
Standalone project — its own git repo and its own dedicated Supabase database,
separate from AfriversalAI.

A daily cash-flow ledger in one tagged stream: **R2G** (the business),
**MMF** (foundation), and **Personal/Home** — matching how the money actually
flows in the Rent 2 Go books today. Multi-currency: USD base now, ZAR for SA
transfers, AED for the Dubai move, with live equivalents.

Stack: static HTML + client-side JS + Supabase (anon key + RLS). No build step.

## Status
- [x] Phase 1 — Database schema (`schema.sql`) + this setup guide
- [ ] Phase 1 — Dedicated Supabase project created & schema applied  ← **your move**
- [x] Phase 2 — Core ledger (`ledger.html`): add/edit entries, buckets, FX equivalents
- [x] Phase 3 — Dashboard (`index.html`): running total, daily snapshot (newest first),
      reconciliation, Today/Week/Month/Year positions, month-on-month
- [x] Phase 4 — Budget & projection (`budget.html`): expected income/expense → forward
      running-balance forecast
- [x] Phase 5 — Import (`import.html`): load .xlsx/.csv → daily totals or full transactions
- [ ] Phase 6 — Recurring & numbered series (Trustee 5/8, subscriptions)
- [ ] Data — Import 2026 history using the Import page + your source sheet

## How the daily workflow maps
- **Ledger** — log the day's **Stripe income** (money in) and expenses out,
  each tagged to a bucket: **Income / Business / Maintenance / Home / Other**,
  a book (R2G / MMF / Personal), and a currency (USD / ZAR / AED, auto-equivalents).
- **Dashboard** — the **computed running total** (carried forward day to day),
  an area to **enter today's actual bank balance**, and a **daily snapshot** table
  that reconciles computed vs actual and flags the **variance** (✓ when matched).

## Files
- `schema.sql` — full data model (apply in Supabase SQL editor)
- `index.html` — dashboard + reconciliation   ·   `ledger.html` — daily entry
- `login.html` — email auth
- `assets/` — `config.js` (your keys, git-ignored), `db.js`, `fx.js`, `common.js`, `style.css`

## Setup (do this once)

1. **Create a NEW, dedicated Supabase project** — this is Rent 2 Go's own
   database, not shared with AfriversalAI or anything else.
   https://supabase.com/dashboard → New project.
2. **Apply the schema** — SQL Editor → paste all of `schema.sql` → run.
3. **Get API details** — Settings → API → copy Project URL + `anon public` key.
4. **Fill in config** — paste both into `assets/config.js` (created in Phase 2;
   git-ignored so keys never get committed).
5. **Enable Auth** — Authentication → Providers → Email; add yourself as a user.
   RLS locks every table to authenticated users only.

Tell me when the project exists and I'll wire the app to it.

## Importing 2026 history

The PDF is an image render — some figures are garbled and daily balances are
ambiguous across columns. For accurate numbers I need the **source spreadsheet**:

- **Best:** the Google Sheet link (view access) or the `.xlsx` file.
- **Or:** each monthly tab exported to CSV.

I'll write a parser for your exact layout, run one month for you to check, then
bulk-load the rest of 2026. Each imported row carries a `source_ref`
(e.g. `sheet:JAN:02`) so it's traceable and safe to re-run without duplicates.
