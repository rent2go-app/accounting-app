# 🧠 Linda — Learning Loop

Linda is the automated billing agent for Rent 2 Go. This file is her **memory**: the
canonical rules she follows, and a dated log of every mistake made + how it was fixed.

> **Process (the loop):**
> 1. **Before changing Linda's logic**, read this file top to bottom.
> 2. **After any mistake or correction**, append it to the Mistakes Log below with the date, what went wrong, and the fix.
> 3. Keep the Canonical Rules section as the single source of truth — update it whenever a rule changes.
> 4. The same entries are stored in the `linda_learnings` table and shown on Linda's dashboard.

---

## Canonical Rules (source of truth)

**Scope**
- Only scan **active / running subscriptions** (`active`, `past_due`, `unpaid`, `trialing`). Ignore `canceled` — you cannot disconnect a returned car.
- Timezone is **America/New_York (Charlotte, NC)** for ALL date logic, greetings, emails and texts — never the admin's local time.

**Past due (the trigger for everything)**
- An invoice is **past due** when it matches Stripe's own red **"Past due"** label = its **due date has passed** (`due_date < now`). Fallback if no due date: open and generated more than **24 hours** ago.
- **Never** notify or penalize an invoice that is **not yet due** (e.g. due later today / tonight at 11:59).

**Late fees ($10)**
- A **late fee is any invoice with `amount_due` == $10** (rentals are ~$70+). Do **not** rely on the description — Stripe labels vary ("late fee", "Past Due", etc.); the **$10 amount** is the reliable signal.
- **One $10 fee PER CUSTOMER, for the LATEST past-due rental only** (latest by **due date**). Do **not** bill one-per-rental and do **not** back-bill older past-due days ("we only bill one for the latest one").
- **A rental's late fee is raised the DAY AFTER it goes past due**, so an existing fee for a rental lands on **due_date + 1** (not the due date). When de-duping, check for an existing late fee created on **due+1 / due+2** — NOT the due date. (Comparing to the due date wrongly treats yesterday's rental's fee as covering today's rental, skipping a fee that's genuinely owed.)
- **Never** charge a fee on a late-fee invoice (no fee-on-fee). One fee per rental, once.
- **Fees are `send_invoice`** (customer is **emailed** an invoice to pay) — **NEVER `charge_automatically`**. R2G does not pull customer cards; customers pay the emailed invoice.
- **Late fees are due the SAME day** they're raised (`days_until_due = 0`). An unpaid late fee is **past due the next day** — treat a late fee as past due once it was **created before today** (don't let a stray future due date make it read as "current").
- Each $10 fee is **attached to the specific rental invoice** that triggered it, with a clean memo (vehicle + invoice + date; strip the raw "N × … (at $/day)" formatting).

**Reminders**
- Base reminders on **past-due amounts only** (past-due rentals + unpaid late fees). Exclude not-yet-due invoices.
- Include **direct "Click to pay" links** per invoice and the account's **customer-portal link**.
- If a recent payment is detected, **thank the customer**.
- Late-fee-only (rentals current): gentle "thank you — please clear your late fees to stay in good standing".

**Escalation ladder**
1. **Reminder** — any past-due rental or unpaid late fee.
2. **Disconnection** (admin rule, 2026-07-28) — **3+ OPEN rental invoices with 2+ already past due** (i.e. 2 past-due rentals + a current/new open rental), **OR** **≥$70 unpaid late fees AND ≥2 past-due rental invoices**. Includes the line: *"If you intend to continue the rental with us today, please cure the balance by 1:00 PM to avoid vehicle recovery."*
3. **Recovery** — **12 hours** after an uncured disconnection: recovery notice + notify the administrator.
- **2 past-due rentals with NO 3rd open rental and <$70 fees → NOT a disconnection** — soft "cure by 1 PM, or reach out to arrange payments or discuss a plan of action."
- **$70 late fees but 0–1 past-due rentals → NOT a disconnection** — it's a *strong* reminder that piling up late fees can cause a future service interruption.
- Requiring **2+ past due** inside the 3-open rule avoids disconnecting a brand-new renter whose open rentals are all still current.

**Workflow**
- Admin-approved: drafts are prepared; nothing goes to a customer without the admin sending. Email is live (Resend, `billing@rentaride2go.com`); customers can be emailed via **📧 Send** or copied for WhatsApp/SMS.
- **Fee lifecycle:** proposed → **📝 Raise draft** (creates a `send_invoice` DRAFT in Stripe, deletable) → **📧 Send** (finalizes + emails + **auto-marks Done**). Manual **✓ Done** for fees raised outside the app. Idempotent — never create a second draft if already raised. Fees **stay in the ledger** through the whole flow, **grouped by fleet**.
- **Dismiss** spares a customer the fee for the day (returns next day if still past due). **Skipped** notices auto re-table in 3 days.
- **Daily reset at midnight ET:** each day starts fresh; sent/reviewed marks and the "day" aggregate are per-day. Today's sent/reviewed are preserved across intraday scans; only yesterday's clear.
- **Payment-plan customers** get a gentle plan-continuation notice, never a disconnection.
- Run cadence: **12:00 AM (fee list) · 1:30 AM (reminders incl. today's invoices + late fees) · 6 AM · 12 PM · 6 PM · 9 PM ET.**

---

## Mistakes Log

### 2026-07-26
- **Counted all past-due invoices (incl. $10 late fees) toward disconnection.** → Fix: distinguish **rental** invoices (>$10) from **late-fee** invoices; only rentals count toward the ≥3 disconnection threshold. (Essence was wrongly flagged for disconnection when her past-dues were all late fees.)
- **Used UTC for date comparisons.** A rental due the 25th evening ET showed as the 26th in UTC and was skipped (Joetta, Brandon). → Fix: compute all dates in **America/New_York**.
- **Excluded invoices whose due DATE equals today (date-only rule).** This missed invoices that came due at **midnight today** and were already hours overdue (Pervis's 25th rental, due 07-26 00:00). → Fix: use the **due-timestamp** / Stripe's "Past due" flag as the root, not a date-only comparison.
- **$70-late-fee disconnection rule used *open* rentals, not *past-due* rentals.** Pervis ($70 fees, rentals current) was wrongly put on disconnection. → Fix: require **≥2 past-due rental invoices** alongside the $70; otherwise it's a strong reminder.
- **Proposed $10 fees accumulated across scans (stale/incorrect fees persisted).** → Fix: clear `proposed` fees for the account at the start of every scan and re-derive fresh.
- **Skipped notice with a null `skipped_at` was suppressed forever** (Penny's disconnection disappeared). → Fix: null or >3-day-old skips **re-table**; only skips within the last 3 days are suppressed.
- **Large avatar image (1.4 MB) slowed the ledger.** → Fix: 700px `linda.png` + 43 KB `linda-sm.png` for small icons.
- **Proposed a new $10 fee for every past-due rental without checking whether a late fee already existed** — would double-bill, since these accounts already run a daily late-fee process (Jada had already been fee'd; some customers pay the late fee but not the rental). → Fix: collect existing late-fee created-dates (open + paid) per customer; skip proposing if a fee already exists on the rental's due date or the day after — notify only. (Cut proposed fees from 11 to 3 on the live data.)
- **Resend test-mode 403 on "Test to me"** — sent to the login email, but Resend only delivers to the account owner (`mail.rent2go@gmail.com`) until a domain is verified. → Fix: let the tester choose the recipient; documented that only that address works pre-verification.

### 2026-07-27
- **Late-fee de-dup compared to the rental's DUE date, but a fee is raised the DAY AFTER.** A Jul-26 past-due rental is fee'd on Jul 27; the fee *created* Jul 26 was for the **Jul 25** rental. Comparing to the due date treated that earlier fee as covering the Jul 26 rental and **skipped a fee that was genuinely owed** (Robyn, Taesha, Rodney — proposed fees wrongly dropped from ~14 to 2). → Fix: de-dup against a fee created on **due+1 / due+2**, never the due date.
- **Picked the "latest" past-due rental by CREATED date instead of DUE date.** A customer whose newest-*created* invoice was an older due-date got skipped. → Fix: choose the latest past-due rental by **due date**.
- **Mis-classified $10 "Past Due"-labelled invoices as rentals** (only matched description text "late fee"). Inflated past-due-rental counts → **false disconnections** (Trevion flagged when most past-dues were $10 fees). → Fix: **any invoice with `amount_due` == $10 is a late fee**, regardless of description; rentals are >$10.
- **Auto-charging late fees.** Draft $10 invoices were created `charge_automatically`. R2G never pulls customer cards — they email invoices to pay. → Fix: create/finalize as **`send_invoice`** (emailed, 7-day due); "Send" finalizes + emails, never charges.
- **Daily-reset DELETE wiped ALL non-skipped notices every scan** — the `or=(...)` PostgREST filter was URL-encoded whole (including `=`), so it was ignored and the delete matched everything; sent/reviewed marks kept "unravelling". → Fix: use separate simple deletes and URL-encode only the timestamp value; today's sent/reviewed are preserved, only prior-day rows clear.
- **Verbose late-fee memo leaked raw Stripe line** ("1 × NISSAN SENTRA (at $72.55/day)"). → Fix: clean memo (vehicle + invoice + date), strip the "N × … (at $/day)" formatting.
- **`toast()` undefined in the dashboard** — Raise/Send/Test succeeded server-side but threw a false "failed" afterward. → Fix: define `toast()`. Also **`todayET()` was undefined in owners.html**, and the Fleet-Financials code threw and **blanked every owner block** → Fix: define the helper; runtime-test, not just syntax-check.
- **Fleet Financials showed the same car twice when it changed hands mid-month**, with a false "21 days no payment" flag on the earlier renter. → Fix: **merge by car** (overlap renters into one block); compute the no-payment gap on the combined timeline.

### 2026-07-28
- **Raised $10 late fees had a 7-day due date, so they read as "current / not yet late"** instead of past due — notices were wrong. → Fix: (a) raise late fees with **`days_until_due = 0`** (due the SAME day, `send_invoice`, still emailed not auto-charged); (b) treat a **late fee as past due once it was created before today** (ignore a stray future due date) — late fees are due same-day, so an unpaid one from yesterday is late today.
- **Payment plans are not one-size-fits-all.** Some are the daily "2 rentals + 2 late fees per day" catch-up (verify yesterday's payments); others are custom, e.g. "clear $246 before 1 August" (Penny). → Fix: detect plan type from `plan_terms` ("per day" → daily 2+2 check; otherwise → reference the agreed terms, no daily check).
- **Don't threaten disconnection/vehicle recovery for everyone behind.** Newly behind (2 days) should read "please cure your balance by 1 PM today, or reach out to discuss a way forward." Reserve the FINAL-NOTICE disconnect + recovery language for the actual disconnection tier (≥3 past-due rentals).

<!-- Append new mistakes above this line, newest date first. Format:
### YYYY-MM-DD
- **What went wrong.** → Fix: what was changed.
-->
- **Invoice fetch capped at 100 (no pagination)** — customers with 200+ invoices (Essence had 244) had older open late fees missed (notice showed 5 of 6). → Fix: paginate all invoices via `has_more`/`starting_after`. Always paginate Stripe list calls.

### 2026-07-28 (later)
- **Payment-plan badge kept switching off.** The scan upsert preserved `on_plan` only by *omission* (relying on merge-duplicates not touching unlisted columns) — fragile; flags set by the admin were being lost. → Fix: the scan now reads every customer's existing `on_plan`/`plan_terms` for the account and **writes them back verbatim** on every upsert, so the flag can never be reset by a sweep.
- **Payment-plan customers must NEVER be disconnected**, no matter how many invoices are open — the plan branch runs before the disconnection branch, so they always get the plan-continuation notice. Linda must also **check daily-plan compliance**: for a "per day" plan she verifies yesterday's **2 rental payments + 2 late-fee payments**; if the customer didn't pay both, mark them `state=plan_behind` ("falling behind their plan") and send the firmer catch-up wording (still no disconnection).
- **Standalone invoices were invisible.** The scan only walked *active subscriptions*, so a customer with open invoices but no active subscription yet (e.g. Penny switched cars — her new-account subscription starts tomorrow but she already had standalone invoices) was never billed or notified. → Fix: scan a **union of** active-subscription customers **and** any customer with open invoices (from `invoices?status=open`), tagged `sub_status=no_subscription`.
- **Disconnection notices dangled "arrange a payment plan" as an escape** — customers read it as a way to avoid disconnection. → Fix: the disconnect + newly-behind notices now say **"reach out right away to arrange payments or discuss a plan of action"** (no promise of a plan that saves them). The plan-continuation notices for customers *already on a plan* are unchanged.
- **No bulk Send.** There was a bulk **Raise** (`{all:true}`) but fees still had to be sent one-by-one. → Fix: added **`{send_all:true, account_label}`** to `linda-raise-fee` (finalizes + emails every `raised` draft in the account) and a **"📧 Send all N raised in this fleet"** button beside the bulk-Raise button.
- **Duplicate Audit Sweep button** appeared at the top of each account (the per-fleet freshness banner repeated the header button). → Fix: the banner keeps the "records last pulled" text only; the single Audit Sweep button lives in the account header.
- **Broad open-invoice read pulled the whole backlog.** Reading `invoices?status=open` for standalone billing swept in old/canceled renters with lingering unpaid invoices — "active" jumped to 122 and outstanding grew every sweep. → Fix: scan **active subscriptions only**; the standalone exception is scoped to **one named customer in one account** (Penny in JJM, by id/email) and is temporary. **Rule: keep the workflow current — never sweep the historical backlog.**
- **Dashboard writes silently failed under RLS.** `linda_customers` and `linda_fees` had **RLS enabled but no INSERT/UPDATE/DELETE policy** — the dashboard's plan-toggle / dismiss / done writes returned no error but changed 0 rows, so nothing persisted (badge/dismiss "switching off"). → Fix: added INSERT/UPDATE/DELETE policies **for `authenticated` only** (anon stays read-blocked; admins log in). Always give a table the write policies its UI needs, not just SELECT.
- **"Sent" didn't stick across refreshes.** Draft row **ids are regenerated on every sweep** (delete + re-insert), so if a cron/audit ran while the page was open, a Send/Mark-sent click targeted a now-deleted id → 0 rows updated, silently. → Fix: `upd()` updates by id, **falls back to the stable (account_label, customer_id) key**, and **verifies with `.select()`** — if 0 rows it reloads and warns instead of pretending it saved.
- **Disconnection module** added: `linda_disconnections` table + dashboard checklist per flagged customer — **🔴 Active Disconnection / SIGNAL SENT**, customer reached out, action taken, **🟢 restored to service** — with timestamps; status badge mirrors onto the customer's notice card.
