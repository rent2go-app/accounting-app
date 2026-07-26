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
- A **one-time $10 late fee** applies to each **past-due RENTAL invoice** (rental = amount > $10).
- **Never** charge a fee on a late-fee invoice (no fee-on-fee). **Never** compound (one fee per invoice, once).
- Each $10 fee is **attached to the specific rental invoice** that triggered it, with a memo naming that invoice.
- **Never double-bill.** Before proposing a $10 fee for a past-due rental, check the customer's existing late-fee invoices (**open OR paid**). If a late fee already exists dated the rental's due date or the day after, **skip the fee and just notify**. (Customers may pay a late fee but not the rental — don't add another fee, only remind.)

**Reminders**
- Base reminders on **past-due amounts only** (past-due rentals + unpaid late fees). Exclude not-yet-due invoices.
- Include **direct "Click to pay" links** per invoice and the account's **customer-portal link**.
- If a recent payment is detected, **thank the customer**.
- Late-fee-only (rentals current): gentle "thank you — please clear your late fees to stay in good standing".

**Escalation ladder**
1. **Reminder** — any past-due rental or unpaid late fee.
2. **Disconnection** — **≥3 past-due RENTAL invoices**, OR **≥$70 unpaid late fees AND ≥2 past-due rental invoices**. Includes the line: *"If you intend to continue the rental with us today, please cure the balance by 1:00 PM to avoid vehicle recovery."*
3. **Recovery** — **12 hours** after an uncured disconnection: recovery notice + notify the administrator.
- **$70 late fees but 0–1 past-due rentals → NOT a disconnection** — it's a *strong* reminder that piling up late fees can cause a future service interruption.

**Workflow**
- Everything is **dry-run**: drafts are prepared for admin approval. Nothing is charged or emailed without approval.
- **Skipped** notices move to a Skipped section and **auto re-table in 3 days**.
- Notices are **editable** (subject + body) before sending.
- Run cadence: **01:00 and 13:00 ET** (13:00 handles the 12-hour recovery check).

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

<!-- Append new mistakes above this line, newest date first. Format:
### YYYY-MM-DD
- **What went wrong.** → Fix: what was changed.
-->
