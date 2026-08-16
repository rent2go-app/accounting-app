// owner-intake — PUBLIC signup endpoint the customer prototype calls when an owner completes the sign-up wizard.
// Creates (or reuses) an `owners` row, optionally the `vehicles` row for the car they're listing, and starts a
// REAL Stripe Identity session, returning the hosted verify URL (replaces the prototype's simulated Stripe step).
// Auth: verify_jwt=false — guarded by the shared RENTER_INTAKE_TOKEN. owners.html then reviews/approves them.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
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

async function createSession(name: string, email: string, owner_id: string, key: string, return_url?: string) {
  const f = new URLSearchParams(, body.return_url ? String(body.return_url) : undefined);
  f.set("type", "document");
  f.set("options[document][require_matching_selfie]", "true");
  f.set("options[document][require_live_capture]", "true");
  f.append("options[document][allowed_types][]", "driving_license");
  f.append("options[document][allowed_types][]", "id_card");
  f.append("options[document][allowed_types][]", "passport");
  if (email) f.set("metadata[owner_email]", email);
  if (name) f.set("metadata[owner_name]", name);
  f.set("metadata[owner_id]", owner_id);
  // where Stripe returns the owner when they finish
  if (return_url) f.set("return_url", return_url);
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

    const first = String(body.first || "").trim();
    const last = String(body.last || "").trim();
    const name = String(body.name || body.business_name || [first, last].filter(Boolean).join(" ")).trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    if (!email && !name) return json({ error: "name or email required" });

    // Supabase Auth id, so an owner can sign in to their own dashboard.
    const authUid = body.auth_uid ? String(body.auth_uid) : null;
    const label = body.account_label || DEFAULT_ACCT;
    const key = keyFor(label);
    if (!key) return json({ error: "no Stripe key for " + label });

    // Dedupe by email.
    let existing: any = null;
    if (email) { const rows = await sbGet(`owners?email=eq.${enc(email)}&order=created_at.desc&limit=1`); existing = rows && rows[0]; }
    if (existing && existing.verify_status === "verified") return json({ ok: true, owner_id: existing.id, verify_status: "verified", already_verified: true });
    if (existing && existing.session_id && existing.verify_url && existing.verify_status !== "canceled") {
      return json({ ok: true, owner_id: existing.id, url: existing.verify_url, verify_status: existing.verify_status, reused: true });
    }

    const ownerFields: any = {
      name, owner_name: [first, last].filter(Boolean).join(" ") || null, first: first || null, last: last || null,
      email, phone, account_type: body.account_type || (body.business_name ? "business" : "individual"),
      business_name: body.business_name || null, ein: body.ein || null,
      dob: body.dob || null, license: body.license || null, lic_state: body.lic_state || null,
      contact_pref: body.contact_pref || null, payout: body.payout || null,
      bank_name: (body.bank && body.bank.bank) || null, bank_last4: (body.bank && body.bank.last4) || null,
      docs: body.docs || {}, services: body.services || {}, gps: body.gps || {},
      signature: body.signature || null, agreed_at: body.agreed_at || null,
    };

    let owner_id = existing?.id;
    if (!owner_id) {
      ownerFields.status = "pending"; ownerFields.source = "prototype";
      const row = await sbPost("owners", [authUid ? { ...ownerFields, auth_uid: authUid } : ownerFields], "return=representation");
      owner_id = row && row[0] ? row[0].id : null;
      if (!owner_id) return json({ error: "could not create owner" }, 500);
    } else {
      await sbPatch(`owners?id=eq.${enc(owner_id)}`, ownerFields);
    }

    // Optional vehicle the owner is listing.
    let vehicle_id = null;
    if (body.vehicle && (body.vehicle.make || body.vehicle.name || body.vehicle.vin)) {
      const v = body.vehicle;
      const vrow = await sbPost("vehicles", [{
        owner_id, name: v.name || [v.year, v.make, v.model].filter(Boolean).join(" ") || null,
        make: v.make || null, model: v.model || null, year: v.year || null, type: v.type || null,
        vin: v.vin || null, plate: v.plate || null, rate: v.rate || null,
        images: v.images || [], docs: v.docs || {}, eligibility: v.eligibility || {}, gps: v.gps || {},
        status: "pending", available: false, source: "prototype",
      }], "return=representation");
      vehicle_id = vrow && vrow[0] ? vrow[0].id : null;
    }

    const s = await createSession(name, email, owner_id, key);
    if (s.error) return json({ error: s.error.message || JSON.stringify(s.error), owner_id, vehicle_id });
    await sbPatch(`owners?id=eq.${enc(owner_id)}`, { stripe_account: label, session_id: s.id, verify_url: s.url, verify_status: s.status, updated_at: new Date().toISOString() });
    return json({ ok: true, owner_id, vehicle_id, url: s.url, session_id: s.id, client_secret: s.client_secret, verify_status: s.status });
  } catch (e) { return json({ error: String(e) }, 500); }
});
