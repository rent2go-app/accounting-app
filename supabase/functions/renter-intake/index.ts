// renter-intake — PUBLIC signup endpoint the customer prototype calls when a renter completes sign-up.
// Creates (or reuses) a `renters` row and starts a REAL Stripe Identity session, then returns the hosted
// verify URL so the prototype can redirect the renter to it (replaces the prototype's simulated Stripe step).
// Auth: verify_jwt=false — guarded by a shared RENTER_INTAKE_TOKEN (renters are anonymous at signup).
// Identity runs in the main account "RENT 2 GO - 1.0" (key from LINDA_ACCOUNTS). renters.html then lists/approves them.
const SB = Deno.env.get("SUPABASE_URL")!;
// Where the customer site lives. One secret, so moving domain is one change.
const SITE = (Deno.env.get("SITE_URL") || "https://rent2go-app.github.io/Rent2Go/").replace(/\/?$/, "/");
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

/* ---- does the uploaded file actually prove where they live? ----
   The applicant types a name and an address and uploads a document. Nobody
   compared the two until a person opened the file by hand, which on a busy week
   means not at all - so an application could pass review with a selfie attached.

   Three verdicts, deliberately not two. A file that is not a proof of address is
   a clear reject. A name or address that does not quite line up is not: people
   hold bills in a spouse's name, use a maiden name, or leave the flat number off
   the form. Auto-rejecting those turns away paying customers, so they go to a
   human instead. */
const AK = Deno.env.get("ANTHROPIC_API_KEY") || "";
const VMODEL = Deno.env.get("PROOF_MODEL") || "claude-sonnet-4-6";

async function verifyProof(proof: any, claim: {
  name: string; address: string; city: string; state: string; postal: string;
}): Promise<any | null> {
  if (!AK || !proof?.data) return null;
  const m = String(proof.data).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  const media = m[1].toLowerCase(), b64 = m[2];

  // Claude reads images directly and PDFs through the document block. Anything
  // else - a .docx, a .heic the browser did not convert - cannot be read, and
  // guessing would be worse than saying so.
  let block: any;
  if (media === "application/pdf") {
    block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
  } else if (/^image\/(jpeg|png|webp|gif)$/.test(media)) {
    block = { type: "image", source: { type: "base64", media_type: media, data: b64 } };
  } else {
    return { verdict: "review", reason: `Cannot read a ${media} file automatically - needs a person to open it.`,
             unreadable: true };
  }

  const claimed = [claim.address, claim.city, claim.state, claim.postal].filter(Boolean).join(", ");
  /* The model has no idea what day it is, so any rule about a document being
     recent is unusable unless we say. Without this a hotel stay happening right
     now was read as "in the future". */
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
`You are checking a proof of address for a car rental company in Charlotte, NC.

Today's date is ${today}. Judge every date on the document against that, and never
call a date in the recent past a future date.

The applicant says they are:
  Name:    ${claim.name || "(not given)"}
  Address: ${claimed || "(not given)"}

Read the attached document and answer as JSON only, no other text:

{
  "is_proof_of_address": true|false,
  "doc_type": "utility bill" | "bank statement" | "lease" | "insurance letter" | "government letter" | "phone bill" | "pay stub" | "mail" | "parcel label" | "hotel invoice" | "other" | "none",
  "name_on_document": "exactly as printed, or null",
  "address_on_document": "exactly as printed, or null",
  "document_date": "YYYY-MM-DD or null",
  "name_matches": true|false|null,
  "address_matches": true|false|null,
  "verdict": "accept" | "review" | "reject",
  "reason": "one sentence a customer could be shown"
}

What counts as a proof of address - anything real that carries the person's name
and their residential address together:
  - a utility bill (power, water, gas, phone, internet)
  - a bank, credit card or building society statement
  - a lease or tenancy agreement
  - a medical bill, insurance document or government letter
  - a pay stub showing the address
  - a photograph of actual posted mail with the name and address on it
  - a parcel or delivery label, including an Amazon package, where the name and
    address can be read
  - a hotel invoice or folio, if the guest is currently staying there. This is the
    one case where the address on the document is NOT theirs - it is the hotel's -
    so do not fail it for that. It is acceptable only when ALL of these hold:
      the guest name matches the applicant,
      the stay dates are shown,
      and those dates fall within the last 14 days or are ongoing.
    An older hotel bill is not proof of where somebody lives now: mark it review,
    not accept, and say the stay is out of date.

What does not:
  - a driving licence, passport or any photo ID. These prove who somebody is, not
    where they live, and are never accepted however clearly the address shows
  - a photo of a person
  - a screenshot of an app or a website
  - a blank or unreadable page
  - anything with no address, or with no name

Matching is a judgement, not string equality. Treat as matching: middle names and
initials, maiden or married surnames, common misspellings, "St" for "Street",
missing or extra apartment numbers, and joint accounts where the applicant is one
of the names shown.

On a hotel invoice, set address_matches to true when the hotel's own address is
shown clearly and the stay is current - the address is not meant to be theirs, and
judging it against their registered address would fail every one of them.

Choose the verdict this way:
- "reject" only if it is not a proof of address at all, or the name AND the
  address both clearly belong to somebody else.
- "review" if it is a proof of address but something does not line up, is
  unreadable, or is more than 6 months old.
- "accept" if it is a proof of address and both the name and the address are a
  reasonable match.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: VMODEL, max_tokens: 700,
        messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }],
      }),
    });
    const j = await r.json();
    if (j.error) return { verdict: "review", reason: "Automatic check unavailable - needs a person.", error: String(j.error?.message || "").slice(0, 140) };
    const text = (j.content || []).map((c: any) => c.text || "").join("");
    const raw = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return JSON.parse(raw);
  } catch (e) {
    // never block an application because our own check fell over
    return { verdict: "review", reason: "Automatic check could not run - needs a person.", error: String(e).slice(0, 140) };
  }
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

    /* Check a document without starting an application. The form calls this the
       moment a file is chosen, so somebody who attaches the wrong thing is told
       immediately rather than after they have filled in the rest and submitted. */
    if (body.action === "check_proof") {
      const v = await verifyProof(body.proof, {
        name: [body.first, body.last].filter(Boolean).join(" "),
        address: String(body.home_address || ""), city: String(body.home_city || ""),
        state: String(body.home_state || ""), postal: String(body.home_postal || ""),
      });
      if (!v) return json({ ok: true, checked: false, reason: "No document to check." });
      return json({ ok: true, checked: true, verdict: v.verdict, reason: v.reason,
                    doc_type: v.doc_type, name_on_document: v.name_on_document,
                    address_on_document: v.address_on_document,
                    document_date: v.document_date,
                    name_matches: v.name_matches, address_matches: v.address_matches });
    }


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
    let proofCheck: any = null;
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
    if (body.promo_code) homeFields.promo_code = String(body.promo_code).trim().toUpperCase();

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

      // read it and compare it with what they typed
      const v = await verifyProof(proof, {
        name: [body.first, body.last].filter(Boolean).join(" "),
        address: String(body.home_address || ""), city: String(body.home_city || ""),
        state: String(body.home_state || ""), postal: String(body.home_postal || ""),
      });
      if (v) {
        proofCheck = v;
        const verdict = ["accept", "review", "reject"].includes(v.verdict) ? v.verdict : "review";
        await sbPatch(`renters?id=eq.${enc(renter_id)}`, {
          proof_verdict: verdict,
          proof_reason: String(v.reason || "").slice(0, 400),
          proof_doc_type: v.doc_type || null,
          proof_doc_date: v.document_date || null,
          proof_name_seen: v.name_on_document || null,
          proof_addr_seen: v.address_on_document || null,
          name_match: v.name_matches,
          address_match: v.address_matches,
          proof_checked_at: new Date().toISOString(),
          // a reject stops the application; a review only flags it, because a
          // wrongly rejected applicant is a lost customer who will not come back
          ...(verdict === "reject"
                ? { decision: "rejected", needs_review: true,
                    review_reason: `Proof of address rejected: ${String(v.reason || "").slice(0, 200)}` }
                : verdict === "review"
                ? { needs_review: true,
                    review_reason: `Proof of address needs a look: ${String(v.reason || "").slice(0, 200)}` }
                : {}),
        });
      }
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
             <p><a href="${SITE}#dashboard" style="background:#0f8a4d;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Open my dashboard</a></p>
             <p style="color:#5c6a7a;font-size:13px">Reminder: 7-day minimum rental, and vehicles stay within 100 miles of Charlotte, NC.</p>
             <hr style="border:none;border-top:1px solid #e2e8e4;margin:22px 0 10px">
             <div style="color:#5c6a7a;font-size:12px">Rent 2 Go · Suite 111, 9711 David Taylor Drive, Charlotte, NC 28262 · 980 272 8122</div></div>` }),
        });
      }
    } catch (_) { /* signup must never fail because email did */ }

    return json({ ok: true, renter_id, url: s.url, session_id: s.id, client_secret: s.client_secret, status: s.status,
                  // so the form can tell them there and then, rather than by email tomorrow
                  proof: proofCheck ? { verdict: proofCheck.verdict, reason: proofCheck.reason,
                                        doc_type: proofCheck.doc_type } : null });
  } catch (e) { return json({ error: String(e) }, 500); }
});
