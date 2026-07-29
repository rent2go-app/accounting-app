# Prompt for the prototype build (merge — do NOT overwrite the admin)

Copy everything below into the prototype's build session.

---

You are wiring the **Rent 2 Go customer prototype** (front-end) into an **existing, live admin back-office** that already has real data. Your job is to make the prototype **read from and write to the shared backend we already built** — NOT to recreate, reseed, or overwrite it. Treat the shared database as the single source of truth; the prototype is a client of it.

## Shared backend (already live — use as-is)
- **Supabase project:** `https://fsapfxhyjbgxjydahdlx.supabase.co`
- **Anon key (public client):** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzYXBmeGh5amJneGp5ZGFoZGx4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MTI5ODgsImV4cCI6MjEwMDQ4ODk4OH0.CHS63agKi6FAoUwmFpy_SkqCpH9UTRAzyQAUoNbEcUM`
- **Prototype intake token (public-client):** `rintake_513def25b66a4c5e0bcaa26bdf22b776a65e227f`

## HARD RULES — do not break these
1. **Do NOT create, drop, `alter`, truncate, or reseed** the tables `owners`, `vehicles`, or `renters`. They already exist with the exact schema below and hold **live data** (11 real owners, 35 real vehicles, plus renters). Migrating over them or `create table` (even `if not exists` with a different shape) is forbidden.
2. **Do NOT insert renters or owners directly on signup.** Anonymous visitors cannot (RLS) and must not. Signups go **only** through the two intake Edge Functions below, which create the row + a real Stripe Identity session server-side.
3. **Use the exact column names** in the schema below. Do not rename or add columns from the prototype side — if you need a new field, request it be added to the shared schema first.
4. **Retire the prototype's own admin.** Its internal admin screens (`fillAdmin`, `approveRenter`, `adRenterList`, etc.) and its `localStorage` "database" (`r2g_db`) are being replaced. The admin app is the only admin. Keep the prototype's customer-facing screens (home, catalogue, signup wizards, renter/owner dashboards).
5. **Stripe verification is real now** — remove the simulated Stripe screen. Send users to the hosted URL the intake endpoint returns.

## Signup → call these endpoints (this is how data reaches the admin)

### Renter signup
`POST {SUPABASE_URL}/functions/v1/renter-intake`
Headers: `Content-Type: application/json`, `apikey: {ANON}`, `Authorization: Bearer {ANON}`, `x-intake-token: {TOKEN}`
Body: `{ "first": "...", "last": "...", "email": "...", "phone": "..." }`
Returns: `{ ok, renter_id, url }` — redirect the renter to `url` (real Stripe Identity). Dedupes by email.

### Owner signup
`POST {SUPABASE_URL}/functions/v1/owner-intake`
Same headers. Body:
```json
{
  "first":"...", "last":"...", "email":"...", "phone":"...",
  "account_type":"individual|business", "business_name":"...", "ein":"...",
  "dob":"YYYY-MM-DD", "license":"...", "lic_state":"...", "contact_pref":"...",
  "payout":"...", "bank":{"bank":"...","last4":"1234"},
  "signature":"...", "agreed_at":"...",
  "vehicle": { "make":"...", "model":"...", "year":2021, "type":"Sedan",
               "vin":"...", "plate":"...", "rate":0, "images":[], "docs":{}, "eligibility":{} }
}
```
Returns: `{ ok, owner_id, vehicle_id, url }` — redirect the owner to `url`. Creates the owner + (optional) vehicle + Stripe Identity session. Dedupes by email.

**After a successful intake call:** the record is already in the admin. If you still keep a local prototype record for the dashboard, store the returned `renter_id` / `owner_id` on it so it maps to the same person — never a separate identity.

## Reads (catalogue, dashboards)
The `owners`/`vehicles`/`renters` tables are currently **admin-read-only (RLS)**. Do **not** assume the anon key can read them yet. A **public, curated view** for the catalogue (only `status='live'` + `available=true`, safe columns) is being added on the admin side — read the catalogue from that view once it exists, not from the raw tables. Until then, do not point the catalogue at these tables.

## Shared schema (authoritative — match exactly)

**owners:** `id, auth_uid, name, owner_name, first, last, email, phone, account_type('individual'|'business'), business_name, ein, dob, license, lic_state, contact_pref, addr, country, payout, bank_name, bank_last4, stripe_label, stripe_biz_id, cadence, pay_day, weekday, tag, stripe_account, session_id, verify_url, verify_status, verified_name, verified_dob, verified_doc_type, verified_doc_number, verified_expiry, verified_address, last_error, status('pending'|'approved'|'active'|'rejected'), id_verified, signature, agreed_at, docs, services, gps, source('prototype'|'admin'|'migrated'), notes, created_at, updated_at`

**vehicles:** `id, owner_id→owners.id, name, make, model, year, type, vin, plate, rate, days, status('pending'|'live'|'maintenance'|'retired'), available, sarekon_device_id, sarekon_device_label, images, docs, eligibility, gps, source, created_at, updated_at`

**renters:** `id, auth_uid, name, email, phone, status('new'|'requires_input'|'processing'|'verified'|'canceled'), stripe_account, session_id, verify_url, verified_name, verified_dob, verified_doc_type, verified_doc_number, verified_expiry, verified_address, last_error, decision('approved'|'rejected'), decision_at, notes, created_at`

## The flow you are completing
`Prototype signup → renter-intake / owner-intake → shared Supabase (owners/vehicles/renters) → admin app reviews & approves → real Stripe Identity`. Anything a renter or owner does must end up visible in the admin. Build on this — do not fork it.
