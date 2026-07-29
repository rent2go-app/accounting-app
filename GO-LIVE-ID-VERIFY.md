# Stripe Identity — go-live runbook

Everything here is a dashboard step I can't do from the code side. Do them in
order. Each is independent and reversible.

**End state:** a renter or owner signs up in the prototype → `renter-intake` /
`owner-intake` creates their row and a real Stripe Identity session → they
verify → the webhook writes the result back and emails both of you, with no
admin polling.

---

## 1. Run the additive migration

Supabase → SQL Editor → New query → paste `supabase-renters-alter.sql` → Run.

Additive only: seven `add column if not exists` plus the `renter-docs` bucket.
No table creation, no policy changes, no triggers, nothing that can touch
existing rows.

It adds `proof_path`, `proof_name`, `signature`, `agreed_at`, `questionnaire`,
`signup_source` and `updated_at` to `renters`.

> **Check this while you're in there.** `id-verify`, `id-webhook` and
> `renter-intake` all send `updated_at` in their PATCH bodies, and none of them
> inspect the response. If that column didn't already exist, PostgREST was
> rejecting the entire PATCH and those writes were failing silently — renters
> would go through Stripe and never show a result. Running this migration
> closes that off either way. Worth confirming afterwards:
> ```sql
> select id, email, status, session_id, updated_at
> from renters order by created_at desc limit 5;
> ```
> If `session_id` is populated but `status` is stuck on `new`, that was the bug.

---

## 2. Deploy the edge functions

| Function | Action | `verify_jwt` |
|---|---|---|
| `id-verify` | **redeploy** — modified | `true` |
| `id-webhook` | **new** | **`false`** |

`id-webhook` must go out with JWT verification **off**. Stripe doesn't send a
Supabase JWT; the request is authenticated by its `Stripe-Signature` header,
which the function checks itself (HMAC-SHA256, plus a 5-minute replay window).
Deploy it with JWT on and every Stripe delivery returns 401.

`id-verify` changed in two ways: it accepts a signed-in user acting on their own
row, and it passes `return_url` through to Stripe so people land back on your
site instead of a dead-end Stripe page.

---

## 3. Create the Stripe webhook

Stripe → **RENT 2 GO - 1.0** → Developers → Webhooks → Add endpoint.

- **URL:** `https://fsapfxhyjbgxjydahdlx.supabase.co/functions/v1/id-webhook`
- **Events:**
  - `identity.verification_session.verified`
  - `identity.verification_session.requires_input`
  - `identity.verification_session.processing`
  - `identity.verification_session.canceled`

Stripe then shows a signing secret starting `whsec_…`. Copy it.

---

## 4. Add the secrets

Supabase → Edge Functions → Secrets.

| Secret | Value | Status |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 3 | **new — the webhook rejects everything without it** |
| `RESEND_API_KEY` | your Resend key | already set |
| `RESEND_FROM` | `Rent 2 Go <noreply@rentaride2go.com>` | already set — confirm the address |
| `ADMIN_NOTIFY` | `gorentaride@gmail.com` | optional; where verification alerts go |
| `RENTER_INTAKE_TOKEN` | the `rintake_…` token | already set |
| `LINDA_ACCOUNTS` | — | already set; Identity uses the `RENT 2 GO - 1.0` entry |

---

## 5. Enable Stripe Identity

Stripe → Settings → Identity. If it's never been used on this account you'll
accept the Identity terms once.

**Billing is roughly $1.50 per verification attempt**, and a retry is a second
charge. `renter-intake` already protects you here — it dedupes by email and
reuses an existing live session rather than starting a new billable one.

---

## 6. Test end to end

1. Trigger a signup from the prototype (or POST to `renter-intake` directly with
   the intake token).
2. You get back a hosted Stripe URL. Open it and complete a check.
3. Within seconds:
   - the row in `renters.html` shows document type, expiry and address
   - the renter gets "Your ID is verified"
   - you get "ID verified — <name> (renter)"

If nothing lands, check Stripe → Webhooks → your endpoint → recent deliveries.
A 401 means `verify_jwt` is on or `STRIPE_WEBHOOK_SECRET` is missing or wrong.

`renters.html` still has its manual status check, so a broken webhook degrades
to polling rather than blocking anyone.

---

## Where things stand

**Owners share this flow.** `id-verify` and `id-webhook` both mirror results
onto `owners` — writing `verify_status` (not `status`) and flipping
`id_verified` — so `owner-intake` signups verify through the same pipeline.

**Still open:**

- **Renters have no login.** `renter-intake` is anonymous by design, so a renter
  can't sign in, check their own status, or retry a failed check without
  contacting you. This reverses the earlier "renters get a full account"
  decision — it's a deliberate consequence of the intake-endpoint architecture,
  not an oversight. Worth revisiting once the prototype dashboards are real.
- **Proof of address has columns but no upload path.** `proof_path` /
  `proof_name` and the `renter-docs` bucket exist, but nothing writes to them
  yet — anonymous renters can't upload under current storage policies. Either
  extend `renter-intake` to accept the file, or add a policy once renters have
  logins.
- **The intake token is extractable.** It ships in a public web page, so anyone
  can read it and call `renter-intake` directly, at ~$1.50 of Stripe billing per
  call. The email dedupe blunts this but doesn't stop it. If you start seeing
  junk renters, the fix is rate limiting per IP in the function, or rotating the
  token.
- **Admin approval is manual.** The verification email tells renters "within one
  business day". Nothing enforces that.
