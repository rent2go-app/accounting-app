# Rent 2 Go — Integrations & Infrastructure

Reference for the automation/integration layer. **No secrets live in this repo** — all keys are in
Supabase Edge Function secrets. Hosting: GitHub Pages (`rent2go-app/accounting-app`, branch `main`,
auto-deploys on push). Supabase project ref `fsapfxhyjbgxjydahdlx`.

## Pages
- `index.html` — the daily ledger (income/expenses in `day_blocks`). Expense line = `[desc, amount, category, paid, "", carId]`. The car dropdown is sourced from `owners_program` cars, so `carId` maps to owner-module cars. "🔧 Maint. tags" assigns untagged lines to a car.
- `owners.html` — Owners Programme. Owner cards (`owners_program.owners` jsonb). Each owner has `cars[]` and `maint[]`. Maintenance can be billed to the owner as a **payable Stripe invoice**; "🔧 Import ledger maint" auto-matches ledger maintenance to owner+car by `carId` (bill-only via `fromLedger` flag so the push never double-books).
- `linda.html` — Linda, the billing agent (rentals/late fees/disconnections). See `LINDA-LEARNING.md`.
- `gps.html` — **GPS Tracker Control** (admin only). Fleet map: left car menu + one big map; Locate / Track / Disable / Enable per car.

## Edge functions (Supabase, Deno)
- `linda-scan` — daily Stripe sweep across all rental fleets → notices/fees/payments. Cron 6×/day.
- `linda-raise-fee` — creates/sends $10 late-fee Stripe invoices.
- `send-doc` — emails HTML docs via Resend (`billing@rentaride2go.com`, domain rentaride2go.com verified).
- `linda-command` — **GPS/SareKon** vehicle control. Actions: `devices`, `track` (location + ignition on/off + driving/stopped-since + events), `send` (kind: `disable`=1253 with `data_type_23110=0` "Anywhere/earliest"; `enable`=1252; `locate`=6000), `status`.
- `owner-invoice` — creates a **payable Stripe invoice** for an owner's selected maintenance items (default account **RENT 2 GO LLC 2.0**). Actions: `preview`, `status`, `create` (finds/creates owner as Stripe customer → line items → finalize + email hosted invoice with Pay link).

## Secrets (Supabase, NOT in repo)
- `LINDA_ACCOUNTS` — per-fleet Stripe keys `[{label,key,portal}]` (11 rental fleets).
- `LINDA_GPS` — per-fleet SareKon logins `[{match,api,username,password}]`. Two accounts: `default` (all fleets except JJT) and `RENT 2 Go - JJTusa` (JJT's own SareKon account). API host `https://api.sarekon.com/v1`. **Recommend swapping passwords for Access Keys and rotating.**

## SareKon (GPS) notes
- Auth: `GET /session/create.json?username&password` (or `key`) → `sid` (can expire → re-auth).
- Devices: `GET /dvd/enumerate.json?sid` → `dvds[]` (device_id + description). Not all active.
- Track: `location/list.json` (position, VIN, last event) + `message/list.json` (ignition on/off timeline; supports `triggered_on_start_local`/`triggered_on_end_local` for date history).
- Disable takes effect **next time ignition is OFF** (can't kill a running engine). Owner/renter→device link stored as `sarekon_device_id` on `linda_customers`.

## Owner maintenance → invoice flow
1. Tag the car on each maintenance expense in the ledger (or log on the owner card directly).
2. Owners page → 🔧 Import ledger maint → auto-matched by carId → Import.
3. On the owner card: tick items → 🧾 Bill selected (Stripe) → owner emailed a Pay link (into RENT 2 GO LLC 2.0).
4. ↻ Sync paid → paid items flip to ✅ and are excluded from the month-end platform-fee invoice.
