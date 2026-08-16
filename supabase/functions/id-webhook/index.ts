// id-webhook — Stripe Identity webhook. Stripe calls this the moment a renter
// finishes (or fails) their ID check, so nobody has to sit polling `status`.
//
// Deploy with verify_jwt = FALSE. Stripe does not send a Supabase JWT; the
// request is authenticated by the Stripe-Signature header instead.
//
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_… from the Stripe endpoint),
//          LINDA_ACCOUNTS (for the account's secret key),
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected),
//          RESEND_API_KEY, RESEND_FROM, optional ADMIN_NOTIFY.
//
// Events handled: identity.verification_session.{verified,requires_input,processing,canceled}
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHSEC = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
const DEFAULT_ACCT = "RENT 2 GO - 1.0";
const ADMIN_NOTIFY = Deno.env.get("ADMIN_NOTIFY") || "gorentaride@gmail.com";
const enc = encodeURIComponent;

function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
function d2(x: any) { return x ? String(x).padStart(2, "0") : ""; }
function fmtDate(o: any) { return (o && o.year) ? `${o.year}-${d2(o.month)}-${d2(o.day)}` : null; }
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }

async function sbPatch(path: string, bodyObj: unknown) {
  await fetch(`${SB}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}
async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => null) : null;
}
async function stripeGET(url: string, key: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  return await r.json();
}

/* ---- Stripe signature check (no SDK; Web Crypto HMAC-SHA256) ---- */
function hex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifySig(payload: string, header: string, secret: string) {
  if (!secret || !header) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length) return false;
  // reject anything older than 5 minutes (replay protection)
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return v1.some((s) => safeEq(mac, s));
}

/* ---- email ---- */
async function sendMail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || !to) return;
  const from = Deno.env.get("RESEND_FROM") || "Rent 2 Go <noreply@rentaride2go.com>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch (_) { /* never fail the webhook because email failed */ }
}
const shell = (title: string, body: string) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#131820;line-height:1.55;max-width:560px">
<h2 style="color:#0f8a4d;margin:0 0 12px">${title}</h2>${body}
<hr style="border:none;border-top:1px solid #e2e8e4;margin:22px 0 10px">
<div style="color:#5c6a7a;font-size:12px">Rent 2 Go · Suite 111, 9711 David Taylor Drive, Charlotte, NC 28262 · 980 272 8122</div></div>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const raw = await req.text();
  const sig = req.headers.get("Stripe-Signature") || "";
  if (!await verifySig(raw, sig, WHSEC)) return json({ error: "bad signature" }, 400);

  let evt: any;
  try { evt = JSON.parse(raw); } catch (_) { return json({ error: "bad payload" }, 400); }

  const type = String(evt.type || "");
  if (!type.startsWith("identity.verification_session.")) return json({ ok: true, ignored: type });

  const s0 = evt.data?.object || {};
  const sessionId = s0.id;
  if (!sessionId) return json({ ok: true, ignored: "no session id" });

  // Owners and renters share one Stripe Identity flow, so a session id can
  // belong to either table. Look in both.
  const rRows = await sbGet(`renters?session_id=eq.${enc(sessionId)}&select=id,name,email,status,stripe_account`);
  const renter = rRows && rRows[0];
  const oRows = renter ? null : await sbGet(`owners?session_id=eq.${enc(sessionId)}&select=id,name,owner_name,email,verify_status,stripe_account`);
  const owner = oRows && oRows[0];
  const subject: any = renter || owner || null;

  const label = (subject && subject.stripe_account) || s0.metadata?.account_label || DEFAULT_ACCT;
  const key = keyFor(label);

  const patch: any = { status: s0.status, updated_at: new Date().toISOString() };

  // The webhook payload redacts the document details — re-fetch expanded to get them.
  if (s0.status === "verified" && key) {
    const s = await stripeGET(
      `https://api.stripe.com/v1/identity/verification_sessions/${sessionId}?expand[]=last_verification_report&expand[]=verified_outputs`, key,
    );
    if (!s.error) {
      const vo = s.verified_outputs || {};
      const doc = (s.last_verification_report && s.last_verification_report.document) || {};
      const name = [vo.first_name || doc.first_name, vo.last_name || doc.last_name].filter(Boolean).join(" ");
      if (name) patch.verified_name = name;
      const dob = fmtDate(vo.dob || doc.dob); if (dob) patch.verified_dob = dob;
      if (doc.type) patch.verified_doc_type = doc.type;
      if (doc.number) patch.verified_doc_number = doc.number;
      const exp = fmtDate(doc.expiration_date); if (exp) patch.verified_expiry = exp;
      const a = vo.address || doc.address;
      if (a) patch.verified_address = [a.line1, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(", ");
      patch.last_error = null;
    }
  }
  if (s0.last_error) patch.last_error = s0.last_error.reason || s0.last_error.code || null;

  if (renter) {
    await sbPatch(`renters?session_id=eq.${enc(sessionId)}`, patch);
  } else if (owner) {
    // owners carry the result on verify_status (not status) and flip id_verified —
    // same shape id-verify writes, so both paths stay consistent.
    const opatch: any = { ...patch, verify_status: patch.status };
    delete opatch.status;
    if (s0.status === "verified") opatch.id_verified = true;
    await sbPatch(`owners?session_id=eq.${enc(sessionId)}`, opatch);
  }

  /* ---- notify ---- */
  const isOwner = !renter && !!owner;
  const kind = isOwner ? "owner" : "renter";
  const who = (subject && (subject.name || subject.owner_name)) || patch.verified_name || (isOwner ? "An owner" : "A renter");
  const to = subject && subject.email;

  if (s0.status === "verified") {
    await sendMail(to, "Your ID is verified — Rent 2 Go", shell("You're verified", `
      <p>Good news${patch.verified_name ? ", " + patch.verified_name : ""} — your identity check passed.</p>
      <p>Your account is now with our team for final approval. We'll email you as soon as you're cleared to book,
      usually within one business day.</p>`));
    await sendMail(ADMIN_NOTIFY, `ID verified — ${who} (${kind})`, shell("ID verification passed", `
      <p><b>${who}</b>${to ? " (" + to + ")" : ""} — ${kind} — has passed Stripe Identity.</p>
      <p>Document: ${patch.verified_doc_type || "—"} · expires ${patch.verified_expiry || "—"}<br>
      Address: ${patch.verified_address || "—"}</p>
      <p>Approve or reject them in the Renters page.</p>`));
  } else if (s0.status === "requires_input") {
    await sendMail(to, "We couldn't verify your ID — Rent 2 Go", shell("Your ID check needs another try", `
      <p>Unfortunately your identity check didn't go through${patch.last_error ? " (" + patch.last_error + ")" : ""}.</p>
      <p>This is usually a blurry photo or glare on the licence. Sign in and try again — it only takes a minute.</p>`));
    await sendMail(ADMIN_NOTIFY, `ID check failed — ${who}`, shell("ID verification failed", `
      <p><b>${who}</b>${to ? " (" + to + ")" : ""} failed the ID check.</p>
      <p>Reason: ${patch.last_error || "not given"}</p>`));
  }

  return json({ ok: true, type, status: s0.status });
});
