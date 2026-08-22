// id-verify — renter ID verification via Stripe Identity (driver's license + selfie), persisted to `renters`.
// Identity runs in the main account "RENT 2 GO - 1.0" (key from LINDA_ACCOUNTS). Actions:
//   create → start a session for a renter (insert/link a renters row) → returns hosted URL for the renter
//   status → fetch the session (+ verification report) → update the renters row with the verified result
// Auth: verify_jwt=true — service_role or an admin email.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const DEFAULT_ACCT = "RENT 2 GO - 1.0";
function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
// Stripe classes dob, document number, expiry and the licence images as
// "sensitive verification results". A normal secret key CANNOT read them —
// it needs a RESTRICTED key with Identity sensitive-results permission.
// Set STRIPE_IDENTITY_KEY to that restricted key; we fall back to the normal
// key so nothing breaks while it is absent (you just get no dob/images).
const IDKEY = Deno.env.get("STRIPE_IDENTITY_KEY") || "";
function sensitiveKey(fallback: string) { return IDKEY || fallback; }

// Port the licence images into our own private bucket so the admin can read
// them in renters.html without bouncing to Stripe, and so we keep a copy.
async function portFiles(renter_id: string, ids: string[], key: string) {
  const saved: any[] = [];
  for (const id of ids) {
    try {
      const r = await fetch(`https://files.stripe.com/v1/files/${id}/contents`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const mime = r.headers.get("content-type") || "image/jpeg";
      const ext = mime.includes("png") ? "png" : "jpg";
      const path = `${renter_id}/id-${id}.${ext}`;
      const up = await fetch(`${SB}/storage/v1/object/renter-docs/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SR}`, apikey: SR, "Content-Type": mime, "x-upsert": "true" },
        body: bytes,
      });
      if (up.ok) saved.push({ path, stripe_file: id, mime });
    } catch (_) { /* one bad image must not stop the rest */ }
  }
  return saved;
}
async function stripeForm(url: string, form: URLSearchParams, key: string) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form }); return await r.json(); }
async function stripeGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } }); return await r.json(); }
async function sbPost(path: string, bodyObj: unknown, prefer: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(bodyObj) }); return r.ok ? await r.json().catch(() => null) : null; }
// NOTE: this used to swallow failures silently. A trigger error (or a bad
// column type) meant Stripe said "verified", this function said ok:true, and
// the renters row never changed — with nothing anywhere to show why.
async function sbPatch(path: string, bodyObj: unknown) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify(bodyObj) });
  if (!r.ok) { const t = await r.text().catch(() => ""); console.error("sbPatch failed", r.status, path, t); return { ok: false, status: r.status, error: t }; }
  return { ok: true };
}
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json().catch(() => null) : null; }
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
const enc = encodeURIComponent;
function d2(x: any) { return x ? String(x).padStart(2, "0") : ""; }
function fmtDate(o: any) { return (o && o.year) ? `${o.year}-${d2(o.month)}-${d2(o.day)}` : null; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Three kinds of caller: service_role, an admin email, or a signed-in
  // renter acting on their OWN row (that last one is what self-serve signup uses).
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR, isAdmin = tok === SR, callerUid = "";
  if (!ok) {
    try {
      const p = JSON.parse(atob(tok.split(".")[1]));
      if (p.role === "service_role") { ok = true; isAdmin = true; }
      else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) { ok = true; isAdmin = true; }
      else if (p.sub) { ok = true; callerUid = String(p.sub); }
    } catch (_) { /* */ }
  }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const label = body.account_label || DEFAULT_ACCT;
    const key = keyFor(label);
    if (!key) return json({ error: "no Stripe key for " + label });

    if (body.action === "create") {
      // A renter may only ever start a check against their own row. Resolve it
      // BEFORE calling Stripe so a bad caller can't run up billable sessions.
      let ownRenterId: string | null = null;
      if (!isAdmin) {
        const mine = await sbGet(`renters?auth_uid=eq.${enc(callerUid)}&select=id,status`);
        const row = mine && mine[0];
        if (!row) return json({ error: "no renter profile for this login" }, 403);
        if (row.status === "verified") return json({ error: "already verified" }, 400);
        ownRenterId = row.id;
      }
      const f = new URLSearchParams();
      f.set("type", "document");
      f.set("options[document][require_matching_selfie]", "true");
      f.set("options[document][require_live_capture]", "true");
      f.append("options[document][allowed_types][]", "driving_license");
      f.append("options[document][allowed_types][]", "id_card");
      f.append("options[document][allowed_types][]", "passport");
      if (body.renter?.email) f.set("metadata[renter_email]", String(body.renter.email));
      if (body.renter?.name) f.set("metadata[renter_name]", String(body.renter.name));
      if (body.renter_id) f.set("metadata[renter_id]", String(body.renter_id));
      // where Stripe sends the renter when they finish (self-serve signup)
      if (body.return_url) f.set("return_url", String(body.return_url));
      const s = await stripeForm("https://api.stripe.com/v1/identity/verification_sessions", f, key);
      if (s.error) return json({ error: s.error.message || JSON.stringify(s.error), code: s.error.code });
      const patch = { stripe_account: label, session_id: s.id, verify_url: s.url, status: s.status, updated_at: new Date().toISOString() };
      let renter_id = ownRenterId || body.renter_id;
      if (renter_id) { await sbPatch(`renters?id=eq.${enc(renter_id)}`, patch); }
      else { const row = await sbPost(`renters`, [{ name: body.renter?.name || "", email: body.renter?.email || "", phone: body.renter?.phone || "", ...patch }], "return=representation"); renter_id = row && row[0] ? row[0].id : null; }
      return json({ ok: true, renter_id, session_id: s.id, url: s.url, client_secret: s.client_secret, status: s.status });
    }

    // Stripe does not hand back the date of birth — it hands back photographs of
    // the licence. This returns those images so an admin can read the DOB off the
    // document and confirm it against what the renter typed.
    // Identity files are restricted (no file_links), so we proxy the bytes.
    // Admin-only: list the fleet accounts and their customer-portal URLs.
    // Returns labels and portals ONLY — never the Stripe keys.
    if (body.action === "accounts" && isAdmin) {
      return json({ ok: true, accounts: ACCTS.map((a: any) => ({ label: a.label, portal: a.portal || null })) });
    }

    // Admin-only: sweep EVERY fleet account for Identity verification sessions.
    // Renters were verified on whichever account their fleet bills from, so a
    // single-account lookup misses most of them.
    if (body.action === "sweep" && isAdmin) {
      const out: any[] = [];
      for (const a of ACCTS) {
        if (!a.key) continue;
        try {
          // page through every session - Stripe caps a page at 100
          const maxPages = Math.min(40, Math.max(1, parseInt(String(body.pages || "40"), 10) || 40));
          let after = String(body.after || ""), pages = 0; const all: any[] = [];
          while (pages++ < maxPages) {
            const r = await fetch(`https://api.stripe.com/v1/identity/verification_sessions?limit=100${after ? "&starting_after=" + after : ""}&expand[]=data.verified_outputs`, { headers: { Authorization: `Bearer ${a.key}` } });
            const j = await r.json();
            if (j.error) { out.push({ label: a.label, error: j.error.message }); break; }
            const d = j.data || [];
            all.push(...d);
            if (!j.has_more || !d.length) break;
            after = d[d.length - 1].id;
          }
          for (const vs of all) {
            out.push({
              label: a.label, id: vs.id, status: vs.status,
              created: vs.created,
              email: (vs.metadata && (vs.metadata.renter_email || vs.metadata.email)) || vs.provided_details?.email || null,
              name: (vs.metadata && vs.metadata.renter_name) || null,
              renter_id: (vs.metadata && vs.metadata.renter_id) || null,
              vo: vs.verified_outputs || null,
            });
          }
        } catch (e) { out.push({ label: a.label, error: String(e) }); }
      }
      const ids = out.filter((x) => x.id);
      return json({ ok: true, count: ids.length, next: ids.length ? ids[ids.length - 1].id : null, sessions: out });
    }

    // Admin-only diagnostic: what does a live subscription actually tell us?
    // We need to know whether the car is identifiable from Stripe alone, or only
    // from Linda's manual GPS link. Returns no keys.
    if (body.action === "subs" && isAdmin) {
      const out: any[] = [];
      for (const a of ACCTS) {
        if (!a.key) continue;
        try {
          const r = await fetch("https://api.stripe.com/v1/subscriptions?status=all&limit=6&expand[]=data.customer", { headers: { Authorization: `Bearer ${a.key}` } });
          const j = await r.json();
          if (j.error) { out.push({ label: a.label, error: j.error.message }); continue; }
          for (const s of (j.data || [])) {
            const it = (s.items?.data || [])[0] || {};
            out.push({
              label: a.label, sub: s.id, status: s.status,
              customer: (s.customer && s.customer.email) || s.customer,
              amount: it.price ? (it.price.unit_amount || 0) / 100 : null,
              interval: it.price?.recurring?.interval || null,
              price_nickname: it.price?.nickname || null,
              product_id: it.price?.product || null,
              sub_metadata: s.metadata || {},
            });
          }
        } catch (e) { out.push({ label: a.label, error: String(e) }); }
      }
      return json({ ok: true, subs: out });
    }

    if (body.action === "files") {
      if (!isAdmin) return json({ error: "admins only" }, 403);
      if (!body.session_id) return json({ error: "session_id required" });
      const s = await stripeGET(`https://api.stripe.com/v1/identity/verification_sessions/${body.session_id}?expand[]=last_verification_report`, key);
      if (s.error) return json({ error: s.error.message || "stripe error" });
      const rep = s.last_verification_report || {};
      const ids: string[] = [
        ...(((rep.document || {}).files) || []),
        ...((rep.selfie && rep.selfie.selfie) ? [rep.selfie.selfie] : []),
      ].filter(Boolean);
      const out: any[] = [];
      for (const id of ids) {
        try {
          const r = await fetch(`https://files.stripe.com/v1/files/${id}/contents`, { headers: { Authorization: `Bearer ${sensitiveKey(key)}` } });
          if (!r.ok) { const body = await r.text().catch(() => ""); out.push({ id, error: `HTTP ${r.status}`, detail: body.slice(0, 300) }); continue; }
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          const mime = r.headers.get("content-type") || "image/jpeg";
          out.push({ id, data: `data:${mime};base64,${btoa(bin)}` });
        } catch (e) { out.push({ id, error: String(e) }); }
      }
      return json({ ok: true, session_id: body.session_id, count: out.length, files: out });
    }

    if (body.action === "status") {
      if (!body.session_id) return json({ error: "session_id required" });
      if (!isAdmin) {
        const mine = await sbGet(`renters?auth_uid=eq.${enc(callerUid)}&select=session_id`);
        if (!mine || !mine[0] || mine[0].session_id !== body.session_id) return json({ error: "forbidden" }, 403);
      }
      const s = await stripeGET(`https://api.stripe.com/v1/identity/verification_sessions/${body.session_id}?expand[]=last_verification_report&expand[]=verified_outputs`, sensitiveKey(key));
      if (s.error) return json({ error: s.error.message || JSON.stringify(s.error) });
      const vo = s.verified_outputs || {};
      const doc = (s.last_verification_report && s.last_verification_report.document) || {};
      const patch: any = { status: s.status, updated_at: new Date().toISOString() };
      const name = [vo.first_name || doc.first_name, vo.last_name || doc.last_name].filter(Boolean).join(" ");
      if (name) patch.verified_name = name;
      const dob = fmtDate(vo.dob || doc.dob); if (dob) patch.verified_dob = dob;
      if (doc.type) patch.verified_doc_type = doc.type;
      if (doc.number) patch.verified_doc_number = doc.number;
      const exp = fmtDate(doc.expiration_date); if (exp) patch.verified_expiry = exp;
      const a = vo.address || doc.address; if (a) patch.verified_address = [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ");
      // pull the licence images across too, if we have the permission to
      try {
        const rows = await sbGet(`renters?session_id=eq.${enc(body.session_id)}&select=id,id_images`);
        const row = rows && rows[0];
        const rep = s.last_verification_report || {};
        const ids: string[] = [ ...(((rep.document || {}).files) || []), ...((rep.selfie && rep.selfie.selfie) ? [rep.selfie.selfie] : []) ].filter(Boolean);
        if (row && ids.length && !(row.id_images && row.id_images.length)) {
          const saved = await portFiles(row.id, ids, sensitiveKey(key));
          if (saved.length) patch.id_images = saved;
        }
      } catch (_) { /* never block the status write on image porting */ }
      await sbPatch(`renters?session_id=eq.${enc(body.session_id)}`, patch);
      // Owners share the same Stripe Identity flow — mirror the result onto the owners row (verify_status,
      // not status, and flip id_verified when verified). No-op if no owner has this session_id.
      const opatch: any = { ...patch, verify_status: s.status }; delete opatch.status;
      if (s.status === "verified") opatch.id_verified = true;
      await sbPatch(`owners?session_id=eq.${enc(body.session_id)}`, opatch);
      return json({ ok: true, session_id: s.id, status: s.status, last_error: s.last_error, ...patch });
    }

    return json({ error: "action must be 'create' or 'status'" });
  } catch (e) { return json({ error: String(e) }, 500); }
});
