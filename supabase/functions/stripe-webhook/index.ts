// stripe-webhook — keep our records level with Stripe as it happens.
//
// Until now renter_invoices was a snapshot: it only moved when somebody ran a
// sync. A renter could pay in the portal and still see the invoice as unpaid on
// their dashboard, and the next day's invoice would not appear at all, because
// nothing told us either had happened. That is exactly what a webhook is for.
//
// One endpoint serves all the Stripe accounts. Each account signs with its own
// secret, so the secret that verifies a request is also what tells us which
// account it came from - we do not have to trust anything in the body to know.
//
// Deliberately narrow: invoices are written straight through, but a subscription
// event only records its status. Moving cars between renters needs to see every
// live subscription across all fourteen accounts at once - judging it from a
// single event is how a car ends up released while someone is still paying for
// it. That stays with the full sync, which has the whole picture.
//
// Auth: verify_jwt = false. Stripe does not send a Supabase JWT; the signature
// is the authentication, and an unsigned request is rejected below.
// Secrets: STRIPE_WEBHOOK_SECRETS = {"<account label>":"whsec_...", ...}
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

let SECRETS: Record<string, string> = {};
try { SECRETS = JSON.parse(Deno.env.get("STRIPE_WEBHOOK_SECRETS") || "{}"); } catch (_) { /* */ }

const money = (c: number | null | undefined) => (c || 0) / 100;
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);


/* What a charge actually is, taken from the words on it. The old test was
   "amount is $10.00", which caught the standard late fee and nothing else - a
   $554 accumulated late-fee invoice read as an ordinary daily rental, tolls and
   penalties were unlabelled, and rentals billed by hand rather than through a
   subscription showed as "other".

   This mirrors public.r2g_charge_kind exactly. If you change one, change both -
   a row written by the webhook must be classified the same as one written by a
   sync. Order matters: fee wording is tested before the subscription and
   model-year rules, so a penalty that names the car is still a penalty. */
function chargeKind(desc: string, amountDue: number, sub: string | null): string {
  const d = String(desc || "");
  if (/late\s*(fee|pym|payment)|past\s*due|^\s*late\b/i.test(d)) return "late_fee";
  if (/deposit/i.test(d)) return "deposit";
  if (/toll/i.test(d)) return "toll";
  if (/fine|penalt|smok|mileage|replacement|out of state|travel fee|cleaning|damage/i.test(d)) return "fee";
  if (/^[0-9]+\s*(x|\u00d7)\s/i.test(d)) return "rental";
  if (sub) return "rental";
  if (/(19|20)[0-9]{2}/.test(d)) return "rental";
  if (amountDue === 10) return "late_fee";
  return "other";
}

async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => []) : [];
}
async function sbUpsert(table: string, rows: unknown[], onConflict: string) {
  if (!rows.length) return;
  await fetch(`${SB}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json",
               Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}
async function note(kind: string, detail: string, extra: Record<string, unknown> = {}) {
  await fetch(`${SB}/rest/v1/stripe_sync_log`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json",
               Prefer: "return=minimal" },
    body: JSON.stringify([{ kind, detail: detail.slice(0, 400), ...extra }]),
  }).catch(() => {});
}

/* Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256. We check the raw text
   exactly as it arrived - reparsing the JSON first would change the bytes and
   every signature would fail. */
async function verify(raw: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"], sig = parts["v1"];
  if (!t || !sig) return false;
  // Stripe's own tolerance is five minutes; anything older is a replay.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const mine = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (mine.length !== sig.length) return false;
  let diff = 0;                                   // constant time: never leak how close a guess was
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function renterFor(email: string | null): Promise<string | null> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const rows = await sbGet(`renters?select=id&email=ilike.${encodeURIComponent(e)}&limit=1`);
  return rows[0]?.id || null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("stripe-webhook", { status: 405 });
  const raw = await req.text();
  const header = req.headers.get("stripe-signature") || "";
  if (!header) return new Response("no signature", { status: 400 });

  // Whichever secret verifies is the account it came from.
  let label: string | null = null;
  for (const [name, secret] of Object.entries(SECRETS)) {
    if (await verify(raw, header, secret)) { label = name; break; }
  }
  if (!label) return new Response("bad signature", { status: 400 });

  let evt: any;
  try { evt = JSON.parse(raw); } catch (_) { return new Response("bad json", { status: 400 }); }
  const type = String(evt.type || ""), obj = evt.data?.object || {};

  try {
    if (type.startsWith("invoice.")) {
      // A draft invoice has no number and no amount a renter could act on; it is
      // noise on their dashboard until Stripe finalises it.
      if (obj.status === "draft") return new Response("ok (draft ignored)");
      const renter_id = await renterFor(obj.customer_email);
      await sbUpsert("renter_invoices", [{
        id: obj.id, account_label: label, customer_id: obj.customer || null,
        subscription_id: obj.subscription || null, renter_id,
        number: obj.number || null,
        description: (obj.lines?.data || [])[0]?.description || obj.description || null,
        amount_due: money(obj.amount_due), amount_paid: money(obj.amount_paid),
        status: obj.status,
        charge_kind: chargeKind((obj.lines?.data || [])[0]?.description || obj.description || "", money(obj.amount_due), obj.subscription || null),
        is_late_fee: chargeKind((obj.lines?.data || [])[0]?.description || obj.description || "", money(obj.amount_due), obj.subscription || null) === "late_fee",
        due_date: obj.due_date ? new Date(obj.due_date * 1000).toISOString().slice(0, 10) : null,
        issued_at: iso(obj.created), paid_at: iso(obj.status_transitions?.paid_at),
        hosted_invoice_url: obj.hosted_invoice_url || null,
        invoice_pdf: obj.invoice_pdf || null,
        updated_at: new Date().toISOString(),
      }], "id");
      if (type === "invoice.paid" || type === "invoice.payment_failed")
        await note(type === "invoice.paid" ? "payment" : "payment_failed",
          `${obj.number || obj.id} ${money(obj.amount_due).toFixed(2)} ${obj.customer_email || ""}`,
          { account_label: label, renter_id });
      return new Response("ok");
    }

    if (type.startsWith("customer.subscription.")) {
      // Status only, and only on a row we already have. What this event cannot
      // see is the other thirteen accounts, and a car must not be released on a
      // view that narrow. A subscription we have never seen is left for the full
      // sync, which resolves the product to a vehicle before writing anything.
      await fetch(`${SB}/rest/v1/renter_subscriptions?id=eq.${encodeURIComponent(obj.id)}`, {
        method: "PATCH",
        headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json",
                   Prefer: "return=minimal" },
        body: JSON.stringify({
          status: obj.status,
          // as above: Stripe now reports this per item, not per subscription
          current_period_end: iso(obj.current_period_end ?? (obj.items?.data || [])[0]?.current_period_end),
          canceled_at: iso(obj.canceled_at),
          updated_at: new Date().toISOString(),
        }),
      });
      await note("subscription", `${type} ${obj.id} -> ${obj.status}`,
        { account_label: label, subscription_id: obj.id });
      return new Response("ok");
    }
  } catch (e) {
    // 500 tells Stripe to retry, which is what we want for a transient failure.
    await note("error", `${type}: ${String(e).slice(0, 200)}`, { account_label: label });
    return new Response("error", { status: 500 });
  }
  return new Response("ok (ignored)");
});
