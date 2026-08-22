# The buying journey, end to end

Every step below runs on its own. The only thing that stops for a person is a
proof of address the checker could not read.

Written down because the money rules live in four different places — the form,
the database, two Stripe accounts — and when they disagree, the renter is the one
who finds out.

---

## 1. Sign up

**Identity.** Stripe Identity checks the licence and a selfie. It runs in
`RENT 2 GO - 1.0`; that is where every ID check happens, whatever car they end up in.

**Proof of address.** The document is read the moment it is chosen and compared
with the name and address typed into the form. Three outcomes:

| verdict | what happens |
|---|---|
| `accept` | it is a proof of address and both name and address line up |
| `review` | it is a proof of address but something does not fit, is unreadable, or is over six months old — they continue, a person checks |
| `reject` | it is not a proof of address, or it belongs to someone else at another address — they cannot continue |

The middle case is deliberate. People hold bills in a spouse's name, use a maiden
name, or leave the flat number off the form. Auto-rejecting those turns away
paying customers.

**Approval.** A database trigger clears them the moment `status = verified` and
`proof_verdict = accept`. There is no manual review step: it existed only because
nothing was reading the document, and a person repeating the same two checks added
a day of waiting and no safety.

---

## 2. The deposit

$150 base. Surcharges **do not stack** — the larger one is charged and the smaller
shown as zero, so the breakdown a renter reads adds up.

- **+$150** if their home ZIP is outside 100 miles of Charlotte
- **+$200** if they are 21–24

Locality is decided by **ZIP**, against the 540 codes in `service_zips` — every
one within 100 miles of uptown Charlotte by great-circle distance (NC 349, SC 181,
VA 6, TN 4). Town names are only a fallback for an address with no ZIP: "Concord"
is a town in NC, and also in California, New Hampshire and Massachusetts.

The form quotes it live from the same list; the database recomputes it from
Stripe's **verified** address once the ID check clears, so the final bill rests on
proof rather than what someone typed.

`R2G-TEST-NODEP` waives the whole deposit, surcharges included.

---

## 3. Pay for the first days

Collected in the **checkout account** via Stripe Checkout.

- **7% off the rental** at 7 days or more. Never off the deposit — that is the
  renter's own money being held and returned, so discounting it would mean holding
  less security for the same car.
- The **Stripe customer carries their verified address**, so every invoice and
  subscription prints it. Checkout is not allowed to overwrite it with whatever
  billing address the card carries.

---

## 4. Payment confirms

`checkout-webhook`, in this order:

1. booking → `confirmed`
2. car → off the catalogue
3. pickup details emailed
4. **daily subscription created in the owner's account**

Step 4 runs last and can never undo the rest. If it fails the rental is still paid
for and still valid, and the log says why so it can be created by hand.

---

## 5. Daily billing

Created in the account named on the **vehicle** (`vehicles.account_label`) — a
JJTusa car bills in JJTusa, not wherever the money was collected.

**It starts the day after the days already paid for.**

```
start date + days paid = first daily invoice
```

A 3-day booking from Sat 22 Aug covers the 22nd, 23rd and 24th. The first daily
invoice is **Tue 25 Aug**. Nobody is charged twice for a day they have paid for.

Two details that are fixed on purpose: the invoice is raised at **9am Charlotte
time** and is **due the same day**, matching the pay-by-11:59 PM rule.

### Why it is billed rather than charged

The card lives in the collection account and Stripe payment methods do not move
between accounts. That does not matter here: this fleet bills by invoice — 2,279 of
2,293 existing invoices carry a due date and a hosted pay link. So the subscription
is `collection_method=send_invoice` and the renter pays each day exactly as they
already do.

### Why a subscription schedule

Stripe offers three ways to delay a first charge and only one is right here.

A **trial** is wrong twice over: those days were not free, they were paid for in
the collection account, so the owner's account would show a "free trial" on a
rental paid in full — and a `trialing` subscription appears under neither Active
nor Scheduled in the dashboard, which makes it effectively invisible.

A **billing_cycle_anchor** is refused outright: on a daily price Stripe will not
accept an anchor later than the next natural billing date, which is tomorrow.

So a **subscription schedule**, which is what Stripe built for "start this on a
future date". It shows under Scheduled, claims nothing is free, and on the start
date releases into an ordinary subscription. This is also what the fleet has
always used — there are 50 of them in the 1.0 account already.

---

## 6. Staying level with Stripe

**Webhooks on all 14 accounts.** Invoices and payments land in seconds. One
endpoint serves every account; each signs with its own secret, so the secret that
verifies a request is what identifies the account — nothing in the body is trusted.

**The portal asks rather than waits.** An unverified renter has their identity
check re-read from Stripe on loading the dashboard and again before checkout. A
webhook that does not arrive used to strand somebody on "pending verification"
while Stripe had already cleared them — and silently blocked the sale, because
checkout refuses anyone unverified.

Subscription events only update the **status** of a row we already hold. Moving a
car between renters needs to see every live subscription across all fourteen
accounts at once; judging it from a single event is how a car gets released while
someone is still paying for it. That stays with the full sync.

---

## Where the rules actually live

| Rule | Enforced in |
|---|---|
| deposit, surcharges, promo | `r2g_deposit_for()` — the form only quotes it |
| 100-mile radius | `service_zips` (540 rows) |
| auto-approval | `trg_r2g_auto_approve` on `renters` |
| 7% long-stay discount | `create-checkout` |
| first billing date | `stripe-mirror` → `create_daily_subscription` |
| which account bills | `vehicles.account_label` |
| what a charge is | `r2g_charge_kind()` and its TypeScript twin — change one, change both |
