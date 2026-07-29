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

// Proof of address. The visitor is anonymous and cannot write to storage, so the
// file rides in as a base64 data URL and is uploaded here with the service_role
// key. Requires the `renter-docs` bucket (supabase-renters-alter.sql).
async function uploadProof(renter_id: string, proof: any): Promise<{ path: string; name: string } | null> {
  try {
    const m = String(proof.data || "").match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return null;
    const mime = m[1];
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 10 * 1024 * 1024) return null;           // 10 MB cap
    const ext = mime.includes("pdf") ? "pdf" : (mime.split("/")[1] || "jpg");
    const path = `${renter_id}/proof-${Date.now()}.${ext}`;
    const r = await fetch(`${SB}/storage/v1/object/renter-docs/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SR}`, apikey: SR, "Content-Type": mime, "x-upsert": "true" },
      body: bytes,
    });
    if (!r.ok) return null;
    return { path, name: String(proof.name || `proof.${ext}`) };
  } catch (_) { return null; }
}

async function createSession(renter: any, renter_id: string, key: string, return_url?: string) {
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
  // where Stripe sends the renter when they're done. Without this they land on
  // a Stripe dead-end page with no way back to the site.
  if (return_url) f.set("return_url", return_url);
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

    // Compliance data from the sign-up wizard. All optional so existing
    // callers keep working, but the prototype must send these — the six
    // acknowledgements and the signed agreement are what make the rental
    // enforceable, and proof of address is an insurance requirement.
    const questionnaire = (body.questionnaire && typeof body.questionnaire === "object") ? body.questionnaire : null;
    const signature = body.signature ? String(body.signature).trim() : null;
    const agreedAt  = body.agreed_at ? String(body.agreed_at) : (signature ? new Date().toISOString() : null);
    // proof of address arrives as { name, data } where data is a base64 data URL.
    // Anonymous visitors can't write to storage, so the upload happens here with
    // the service_role key instead.
    const proof = (body.proof && body.proof.data) ? body.proof : null;
    // Supabase Auth user id, so the renter can sign in and see their own row.
    // Sent by the prototype after it creates the account. RLS keys off this.
    const authUid = body.auth_uid ? String(body.auth_uid) : null;
    // Home address + dob drive the deposit rules (out-of-town / young renter).
    // These are what the renter TYPED — a database trigger recomputes the
    // deposit from Stripe's verified dob and address once the check completes.
    const dob   = body.dob ? String(body.dob) : null;
    const addr  = body.home_address ? String(body.home_address).trim() : null;
    const city  = body.home_city    ? String(body.home_city).trim()    : null;
    const st    = body.home_state   ? String(body.home_state).trim()   : null;
    const zip   = body.home_postal  ? String(body.home_postal).trim()  : null;
    const homeFields: Record<string, unknown> = {};
    if (dob)  homeFields.dob = dob;
    if (addr) homeFields.home_address = addr;
    if (city) homeFields.home_city = city;
    if (st)   homeFields.home_state = st;
    if (zip)  homeFields.home_postal = zip;

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
      const insert: any = { name, email, phone, status: "new", notes: "Website signup", signup_source: "prototype" };
      if (questionnaire) insert.questionnaire = questionnaire;
      if (signature) { insert.signature = signature; insert.agreed_at = agreedAt; }
      if (authUid) insert.auth_uid = authUid;
      Object.assign(insert, homeFields);
      const row = await sbPost("renters", [insert], "return=representation");
      renter_id = row && row[0] ? row[0].id : null;
      if (!renter_id) return json({ error: "could not create renter" }, 500);
    } else {
      const patch: any = { name, phone };
      if (questionnaire) patch.questionnaire = questionnaire;
      if (signature) { patch.signature = signature; patch.agreed_at = agreedAt; }
      if (authUid) patch.auth_uid = authUid;   // claim an admin-created row on first self-serve signup
      Object.assign(patch, homeFields);
      await sbPatch(`renters?id=eq.${enc(renter_id)}`, patch);
    }

    // proof of address — needs renter_id for the storage path, so it happens here
    if (proof && renter_id) {
      const up = await uploadProof(renter_id, proof);
      if (up) await sbPatch(`renters?id=eq.${enc(renter_id)}`, { proof_path: up.path, proof_name: up.name });
    }

    const s = await createSession({ name, email }, renter_id, key, body.return_url ? String(body.return_url) : undefined);
    if (s.error) return json({ error: s.error.message || JSON.stringify(s.error), renter_id });
    await sbPatch(`renters?id=eq.${enc(renter_id)}`, { stripe_account: label, session_id: s.id, verify_url: s.url, status: s.status, updated_at: new Date().toISOString() });
    // Welcome email — they have just handed over documents and a signature, so
    // silence here reads as "did that work?". Never let a mail failure break signup.
    try {
      const rk = Deno.env.get("RESEND_API_KEY");
      if (rk && email) {
        const from = Deno.env.get("RESEND_FROM") || "Rent 2 Go <noreply@rentaride2go.com>";
        const first = (name || "").split(" ")[0] || "there";
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + rk, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [email], subject: "We've got your application — Rent 2 Go", html:
            `<div style="font-family:Arial,Helvetica,sans-serif;color:#131820;line-height:1.55;max-width:560px">
             <h2 style="color:#0f8a4d;margin:0 0 12px">Thanks, ${first} — we've got everything</h2>
             <p>Your Rent 2 Go application is in. Here's what happens next:</p>
             <ol style="line-height:1.9">
               <li><b>Identity check</b> — Stripe confirms your driver's licence. Usually under a minute.</li>
               <li><b>Final review</b> — our team checks your licence and proof of address by hand, normally within one business day.</li>
             </ol>
             <p>We'll email you at each step. You can sign in any time to see where you are:</p>
             <p><a href="https://rent2go-app.github.io/Rent2Go/#dashboard" style="background:#0f8a4d;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Open my dashboard</a></p>
             <p style="color:#5c6a7a;font-size:13px">Reminder: 7-day minimum rental, and vehicles stay within 100 miles of Charlotte, NC.</p>
             <hr style="border:none;border-top:1px solid #e2e8e4;margin:22px 0 10px">
             <div style="color:#5c6a7a;font-size:12px">Rent 2 Go · Suite 111, 9711 David Taylor Drive, Charlotte, NC 28262 · 980 272 8122</div></div>` }),
        });
      }
    } catch (_) { /* signup must never fail because email did */ }

    return json({ ok: true, renter_id, url: s.url, session_id: s.id, client_secret: s.client_secret, status: s.status });
  } catch (e) { return json({ error: String(e) }, 500); }
});
