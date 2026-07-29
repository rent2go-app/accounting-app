// renter-intake — PUBLIC signup endpoint the customer prototype calls when a renter completes sign-up.
// Creates (or reuses) a `renters` row and starts a REAL Stripe Identity session, then returns the hosted
// verify URL so the prototype can redirect the renter to it (replaces the prototype's simulated Stripe step).
// Auth: verify_jwt=false — guarded by a shared RENTER_INTAKE_TOKEN (renters are anonymous at signup).
// Identity runs in the main account "RENT 2 GO - 1.0" (key from LINDA_ACCOUNTS). renters.html then lists/approves them.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
const INTAKE_TOKEN = Deno.env.get("RENTER_INTAKE_TOKEN") || "";
const DEFAULT_ACCT = "RENT 2 GO - 1.0";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-intake-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const enc = encodeURIComponent;
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json().catch(() => []) : []; }
async function sbPost(path: string, body: unknown, prefer: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); return r.ok ? await r.json().catch(() => null) : null; }
async function sbPatch(path: string, body: unknown) { await fetch(`${SB}/rest/v1/${path}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
async function stripeForm(url: string, form: URLSearchParams, key: string) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form }); return await r.json(); }

async function createSession(renter: any, renter_id: string, key: string) {
  const f = new URLSearchParams();
  f.set("type", "document");
  f.set("options[document][require_matching_selfie]", "true");
  f.set("options[document][require_live_capture]", "true");
  f.append("options[document][allowed_types][]", "driving_license");
  f.append("options[document][allowed_types][]", "id_card");
  f.append("options[document][allowed_types][]", "passport");
  if (renter.email) f.set("metadata[renter_email]", String(renter.email));
  if (renter.name) f.set("metadata[renter_name]", String(renter.name));
  f.set("metadata[renter_id]", String(renter_id));
  f.set("metadata[source]", "prototype");
  return await stripeForm("https://api.stripe.com/v1/identity/verification_sessions", f, key);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const tok = req.headers.get("x-intake-token") || body.token || "";
    if (!INTAKE_TOKEN || tok !== INTAKE_TOKEN) return json({ error: "unauthorized" }, 401);

    const name = String(body.name || [body.first, body.last].filter(Boolean).join(" ") || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    if (!email && !name) return json({ error: "name or email required" });

    const label = body.account_label || DEFAULT_ACCT;
    const key = keyFor(label);
    if (!key) return json({ error: "no Stripe key for " + label });

    // Dedupe by email so re-submits don't spawn duplicate renters.
    let existing: any = null;
    if (email) { const rows = await sbGet(`renters?email=eq.${enc(email)}&order=created_at.desc&limit=1`); existing = rows && rows[0]; }

    // Already verified — nothing to do, just report back.
    if (existing && existing.status === "verified") return json({ ok: true, renter_id: existing.id, status: "verified", already_verified: true });
    // Existing pending row with a live session — reuse its link.
    if (existing && existing.session_id && existing.verify_url && existing.status !== "canceled") {
      return json({ ok: true, renter_id: existing.id, url: existing.verify_url, status: existing.status, reused: true });
    }

    // Insert (or reuse the row id) then start a real Identity session.
    let renter_id = existing?.id;
    if (!renter_id) {
      const row = await sbPost("renters", [{ name, email, phone, status: "new", notes: "Website signup" }], "return=representation");
      renter_id = row && row[0] ? row[0].id : null;
      if (!renter_id) return json({ error: "could not create renter" }, 500);
    } else {
      await sbPatch(`renters?id=eq.${enc(renter_id)}`, { name, phone });
    }

    const s = await createSession({ name, email }, renter_id, key);
    if (s.error) return json({ error: s.error.message || JSON.stringify(s.error), renter_id });
    await sbPatch(`renters?id=eq.${enc(renter_id)}`, { stripe_account: label, session_id: s.id, verify_url: s.url, status: s.status, updated_at: new Date().toISOString() });
    return json({ ok: true, renter_id, url: s.url, session_id: s.id, client_secret: s.client_secret, status: s.status });
  } catch (e) { return json({ error: String(e) }, 500); }
});
