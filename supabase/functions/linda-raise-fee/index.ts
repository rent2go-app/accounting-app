// linda-raise-fee — creates the $10 late fee as a DRAFT invoice in the customer's Stripe account.
// Draft = NOT sent to the customer and fully deletable. Admin finalizes/sends in Stripe.
// Auth: verify_jwt=true — service_role (cron) or an admin email (button). Reads LINDA_ACCOUNTS secret.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbPatch(path: string, body: unknown) { await fetch(`${SB}/rest/v1/${path}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
async function stripeForm(url: string, form: URLSearchParams, key: string) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  return await r.json();
}

async function raiseOne(feeIn: any) {
  // authoritative row from DB — guards against double-raising from a stale dashboard
  const rows = await sbGet(`linda_fees?invoice_id=eq.${encodeURIComponent(feeIn.invoice_id)}&select=invoice_id,account_label,customer_id,memo,status,stripe_invoice_id`);
  const fee = rows[0] || feeIn;
  if (fee.status === "raised" && fee.stripe_invoice_id) return { invoice_id: fee.invoice_id, already: true, stripe_invoice_id: fee.stripe_invoice_id };
  const key = keyFor(fee.account_label);
  if (!key) return { invoice_id: fee.invoice_id, error: "no key for " + fee.account_label };
  if (!fee.customer_id) return { invoice_id: fee.invoice_id, error: "no customer_id" };
  // 1) create an empty DRAFT invoice (exclude other pending items so only our $10 lands on it)
  // collection_method=send_invoice → customer is EMAILED an invoice to pay; we never auto-pull their card.
  // days_until_due=0 → due the SAME day it's finalized (a late fee is payable immediately, not in a week).
  const inv = await stripeForm("https://api.stripe.com/v1/invoices", new URLSearchParams({
    customer: fee.customer_id, auto_advance: "false", collection_method: "send_invoice", days_until_due: "0",
    pending_invoice_items_behavior: "exclude", description: "Late fee", "metadata[linda_late_fee]": "true",
  }), key);
  if (inv.error) return { invoice_id: fee.invoice_id, error: inv.error.message || JSON.stringify(inv.error) };
  // 2) add the $10 line to THIS draft
  const item = await stripeForm("https://api.stripe.com/v1/invoiceitems", new URLSearchParams({
    customer: fee.customer_id, invoice: inv.id, amount: "1000", currency: "usd",
    description: (fee.memo || "Late fee — Rent 2 Go LLC").slice(0, 250),
  }), key);
  if (item.error) return { invoice_id: fee.invoice_id, error: item.error.message || JSON.stringify(item.error), stripe_invoice_id: inv.id };
  // 3) mark the proposed fee as raised, storing the Stripe draft id
  await sbPatch(`linda_fees?invoice_id=eq.${encodeURIComponent(fee.invoice_id)}`, { status: "raised", raised_at: new Date().toISOString(), stripe_invoice_id: inv.id });
  return { invoice_id: fee.invoice_id, ok: true, stripe_invoice_id: inv.id, status: inv.status };
}

// finalize a raised draft -> issue + email the customer to pay (never auto-charge) -> mark done
async function finalizeOne(invoice_id: string) {
  const rows = await sbGet(`linda_fees?invoice_id=eq.${encodeURIComponent(invoice_id)}&select=invoice_id,account_label,stripe_invoice_id,status`);
  const fee = rows[0];
  if (!fee || !fee.stripe_invoice_id) return { invoice_id, error: "no draft to finalize" };
  if (fee.status === "done") return { invoice_id, already: true };
  const fkey = keyFor(fee.account_label);
  if (!fkey) return { invoice_id, error: "no key for " + fee.account_label };
  const fin = await stripeForm(`https://api.stripe.com/v1/invoices/${fee.stripe_invoice_id}/finalize`, new URLSearchParams({ auto_advance: "true" }), fkey);
  if (fin.error) return { invoice_id, error: fin.error.message || JSON.stringify(fin.error) };
  await stripeForm(`https://api.stripe.com/v1/invoices/${fee.stripe_invoice_id}/send`, new URLSearchParams({}), fkey);
  await sbPatch(`linda_fees?invoice_id=eq.${encodeURIComponent(invoice_id)}`, { status: "done" });
  return { invoice_id, ok: true, hosted: fin.hosted_invoice_url };
}

// create + finalize + email in ONE step (no separate draft stage). Works from a proposed fee,
// and also finishes any leftover raised draft (raiseOne short-circuits, then we finalize).
async function createOne(feeIn: any) {
  const r = await raiseOne(feeIn);
  if (r.error) return r;
  const f = await finalizeOne(feeIn.invoice_id);
  if (f.error) return { invoice_id: feeIn.invoice_id, error: f.error, stripe_invoice_id: r.stripe_invoice_id };
  return { invoice_id: feeIn.invoice_id, ok: true, created: true, emailed: true, hosted: f.hosted };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = auth === SR;
  if (!ok) { try { const p = JSON.parse(atob(auth.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const body = await req.json().catch(() => ({}));
    // CREATE (+finalize +email) a single fee directly — no draft stage. {create:true,invoice_id,account_label,customer_id,memo}
    if (body.create && body.invoice_id) {
      const r = await createOne(body);
      if (r.error) return new Response(JSON.stringify({ error: r.error }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, created: true, emailed: true, done: true, hosted: r.hosted }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // CREATE ALL proposed fees in an account directly (create + finalize + email each).
    if (body.create_all) {
      const props = await sbGet(`linda_fees?status=eq.proposed${body.account_label ? `&account_label=eq.${encodeURIComponent(body.account_label)}` : ""}&select=invoice_id,account_label,customer_id,memo`);
      const results = [];
      for (const f of props) results.push(await createOne(f));  // sequential — gentle on Stripe
      return new Response(JSON.stringify({ ok: true, created: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error).length, results }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // BULK SEND — finalize + email EVERY raised draft in an account (mirror of {all:true} bulk-raise).
    if (body.send_all) {
      const raised = await sbGet(`linda_fees?status=eq.raised${body.account_label ? `&account_label=eq.${encodeURIComponent(body.account_label)}` : ""}&select=invoice_id`);
      const results = [];
      for (const f of raised) results.push(await finalizeOne(f.invoice_id));  // sequential — gentle on Stripe
      return new Response(JSON.stringify({ ok: true, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error).length, results }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // FINALIZE / SEND a single raised draft (draft -> issued -> emailed -> done)
    if (body.finalize && body.invoice_id) {
      const r = await finalizeOne(body.invoice_id);
      if (r.error) return new Response(JSON.stringify({ error: r.error }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, finalized: true, emailed: true, done: true, hosted: r.hosted }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    let fees: any[] = [];
    if (body.all) fees = await sbGet(`linda_fees?status=eq.proposed${body.account_label ? `&account_label=eq.${encodeURIComponent(body.account_label)}` : ""}&select=invoice_id,account_label,customer_id,memo`);
    else if (body.invoice_id) fees = [body];
    else return new Response(JSON.stringify({ error: "pass {invoice_id,account_label,customer_id,memo} or {all:true}" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    const results = [];
    for (const f of fees) results.push(await raiseOne(f));  // sequential — gentle on Stripe
    return new Response(JSON.stringify({ ok: true, raised: results.filter((r) => r.ok).length, failed: results.filter((r) => r.error).length, results }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
});
