// bank-connect — starts a Stripe Financial Connections session so the admin can securely link the
// Rent 2 Go business bank account (via Stripe's bank-login modal). Returns a client_secret the browser
// hands to Stripe.js. We never see bank credentials. Runs on the RENT 2 GO - 1.0 account's key.
// verify_jwt=true (admin/service_role).
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const LABEL = "RENT 2 GO - 1.0";
const HOLDER_EMAIL = "bank-reconciliation@rent2go.internal";   // stable key to reuse one account-holder customer
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
async function sGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "bank-connect" } }); return await r.json(); }
async function sPOST(url: string, key: string, form: URLSearchParams) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bank-connect" }, body: form }); return await r.json(); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const key = keyFor(LABEL);
    if (!key) return json({ error: "no Stripe key for " + LABEL });
    // Find or create one stable account-holder customer to attach the connection to.
    let cust = (await sGET(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(HOLDER_EMAIL)}&limit=1`, key)).data?.[0];
    if (!cust) cust = await sPOST("https://api.stripe.com/v1/customers", key, new URLSearchParams({ email: HOLDER_EMAIL, name: "Rent 2 Go — Bank Reconciliation", "metadata[r2g_bank_holder]": "1" }));
    if (cust.error) return json({ error: cust.error.message || "customer create failed" });
    const form = new URLSearchParams();
    form.set("account_holder[type]", "customer");
    form.set("account_holder[customer]", cust.id);
    form.append("permissions[]", "balances");
    form.append("permissions[]", "transactions");
    form.append("prefetch[]", "balances");
    form.append("prefetch[]", "transactions");
    const sess = await sPOST("https://api.stripe.com/v1/financial_connections/sessions", key, form);
    if (sess.error) return json({ error: sess.error.message || JSON.stringify(sess.error), code: sess.error.code });
    return json({ ok: true, client_secret: sess.client_secret, session_id: sess.id, customer: cust.id });
  } catch (e) { return json({ error: String(e) }, 500); }
});
