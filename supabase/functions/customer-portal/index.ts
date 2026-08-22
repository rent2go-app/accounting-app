// customer-portal — open a renter's own Stripe billing page.
//
// "Update payment card" used to open a portal link shared by everyone in a fleet.
// That is the wrong door: it is not their account, and a shared link is one
// misconfiguration away from showing one renter another's billing.
//
// The customer that matters is the one in the OWNER's account, not the one in the
// collection account. The card is paid in the collection account once, at
// checkout; every daily invoice afterwards is raised by the owner's account, and
// that is the billing the renter wants to see and manage.
//
// Auth: verify_jwt = true. A signed-in renter gets their own portal and nobody
// else's - the customer id is looked up from their row, never taken from the
// request.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = (() => {
  const b = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
  let e: any[] = [];
  try { e = JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA") || "[]"); } catch (_) { /* */ }
  return [...b, ...e];
})();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const enc = encodeURIComponent;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => []) : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let uid = "";
  try {
    const p = JSON.parse(atob(tok.split(".")[1]));
    if (p.role === "service_role") uid = String((await req.json().catch(() => ({}))).auth_uid || "");
    else uid = String(p.sub || "");
  } catch (_) { /* */ }
  if (!uid) return json({ error: "please sign in first" }, 401);

  try {
    const renter = (await sbGet(`renters?auth_uid=eq.${enc(uid)}&select=id,email,name&limit=1`))[0];
    if (!renter) return json({ error: "no renter profile for this login" }, 403);

    /* Their live subscription names both the account that bills them and their
       customer id inside it. Fall back to the most recent one so somebody
       between rentals can still reach their own invoice history. */
    const subs = await sbGet(
      `renter_subscriptions?renter_id=eq.${enc(renter.id)}&select=account_label,customer_id,status,updated_at` +
      `&order=updated_at.desc&limit=20`);
    const live = subs.find((s: any) => ["active", "past_due", "unpaid", "trialing"].includes(s.status));
    const use = live || subs[0];
    if (!use?.customer_id) return json({ error: "no billing account yet", reason: "no_customer" }, 404);

    const acct = ACCTS.find((a: any) => a.label === use.account_label);
    if (!acct?.key) return json({ error: `no Stripe key for ${use.account_label}` }, 500);

    const f = new URLSearchParams();
    f.set("customer", use.customer_id);
    f.set("return_url", String((await req.clone().json().catch(() => ({}))).return_url ||
                               Deno.env.get("SITE_URL") || "https://demo.rentaride2go.com/") + "#billing");
    const r = await (await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${acct.key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: f.toString(),
    })).json();

    if (r.error) {
      // A fleet with no portal configuration yet is a setting, not a fault -
      // say which account needs it rather than showing the renter a dead button.
      return json({ error: r.error.message, reason: "portal_not_configured",
                    account: use.account_label }, 400);
    }
    return json({ ok: true, url: r.url, account: use.account_label });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
