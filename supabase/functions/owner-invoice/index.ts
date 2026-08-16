// owner-invoice — creates a PAYABLE Stripe invoice for an owner (maintenance reimbursement),
// billed in a chosen R2G Stripe account (default "RENT 2 GO LLC 2.0"). It finds/creates the owner
// as a Stripe customer, adds the selected maintenance items as line items, finalizes and emails a
// hosted invoice with a Pay button. Auth: verify_jwt=true — service_role or an admin email.
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const DEFAULT_ACCT = "RENT 2 GO LLC 2.0";

function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
async function stripeGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } }); return await r.json(); }
async function stripeForm(url: string, form: URLSearchParams, key: string) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form }); return await r.json(); }
function json(o: any, status = 200) { return new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const label = body.account_label || DEFAULT_ACCT;
    const items = (body.items || []).filter((i: any) => (+i.amount || 0) > 0);
    const total = Math.round(items.reduce((a: number, i: any) => a + (+i.amount || 0), 0) * 100) / 100;
    if (!items.length) return json({ error: "no items with a positive amount" });

    // PREVIEW — no Stripe writes
    if (body.action === "preview") return json({ ok: true, preview: true, account_label: label, count: items.length, total, items });

    // STATUS — check paid state of previously-created invoices (no writes)
    if (body.action === "status") {
      const skey = keyFor(label); if (!skey) return json({ error: "no Stripe key for account " + label });
      const out: any[] = [];
      for (const id of (body.invoice_ids || [])) {
        const iv = await stripeGET(`https://api.stripe.com/v1/invoices/${id}`, skey);
        out.push({ id, status: iv.status, paid: iv.status === "paid" || iv.paid === true, hosted_invoice_url: iv.hosted_invoice_url, amount_paid: (iv.amount_paid || 0) / 100 });
      }
      return json({ ok: true, invoices: out });
    }

    const key = keyFor(label);
    if (!key) return json({ error: "no Stripe key for account " + label });
    const email = String(body.owner?.email || "").trim();
    const name = String(body.owner?.name || "Owner").trim();
    if (!email) return json({ error: "owner has no email — add one on the owner card first" });

    // find or create the owner as a Stripe customer (by email)
    const found = await stripeGET(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, key);
    let customer = (found.data && found.data[0]) || null;
    if (!customer) {
      customer = await stripeForm("https://api.stripe.com/v1/customers", new URLSearchParams({ email, name, "metadata[r2g_owner]": "true" }), key);
      if (customer.error) return json({ error: "create customer: " + (customer.error.message || JSON.stringify(customer.error)) });
    }

    // create the invoice shell (emailed, pay-by-link — never auto-charge)
    const days = String(body.days_until_due != null ? body.days_until_due : 7);
    const inv = await stripeForm("https://api.stripe.com/v1/invoices", new URLSearchParams({
      customer: customer.id, collection_method: "send_invoice", days_until_due: days, auto_advance: "false",
      pending_invoice_items_behavior: "exclude", description: body.memo || "Fleet maintenance — Rent 2 Go",
      "metadata[r2g_owner_maint]": "true",
    }), key);
    if (inv.error) return json({ error: "create invoice: " + (inv.error.message || JSON.stringify(inv.error)) });

    // add each selected maintenance item as a line
    for (const it of items) {
      const li = await stripeForm("https://api.stripe.com/v1/invoiceitems", new URLSearchParams({
        customer: customer.id, invoice: inv.id, amount: String(Math.round((+it.amount || 0) * 100)), currency: "usd",
        description: String(it.desc || "Maintenance").slice(0, 250),
      }), key);
      if (li.error) return json({ error: "add line: " + (li.error.message || JSON.stringify(li.error)), invoice_id: inv.id });
    }

    // finalize + email the hosted invoice (with Pay button)
    const fin = await stripeForm(`https://api.stripe.com/v1/invoices/${inv.id}/finalize`, new URLSearchParams({ auto_advance: "true" }), key);
    if (fin.error) return json({ error: "finalize: " + (fin.error.message || JSON.stringify(fin.error)), invoice_id: inv.id });
    if (body.send !== false) await stripeForm(`https://api.stripe.com/v1/invoices/${inv.id}/send`, new URLSearchParams({}), key);

    return json({ ok: true, account_label: label, customer_id: customer.id, invoice_id: inv.id, number: fin.number, total, hosted_invoice_url: fin.hosted_invoice_url, status: fin.status, emailed: body.send !== false });
  } catch (e) { return json({ error: String(e) }, 500); }
});
