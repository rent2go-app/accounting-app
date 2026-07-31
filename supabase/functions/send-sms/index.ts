// send-sms — Linda texts a notice to a customer via Twilio (SMS), mirror of send-doc (email).
// Auth: verify_jwt=true — service_role or an admin email. Creds live ONLY in Supabase secrets.
// Body: { to: "+1704…" | "704-727-4605", body: "message text", (optional) test: true }
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const AC = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TK = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const FROM = Deno.env.get("TWILIO_FROM") || "";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }

// customers store phones a dozen ways — reduce to E.164 (US default).
function e164(raw: string): string | null {
  let s = String(raw || "").trim();
  if (s.startsWith("+")) { const d = s.slice(1).replace(/\D/g, ""); return d.length >= 8 ? "+" + d : null; }
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d.length >= 8 ? "+" + d : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  if (!AC || !TK || !FROM) return json({ error: "Twilio not configured (missing SID / token / from number)" });
  try {
    const b = await req.json().catch(() => ({}));
    const to = e164(b.to);
    const body = String(b.body || "").trim();
    if (!to) return json({ error: "no valid phone number for this customer" });
    if (!body) return json({ error: "empty message" });
    const form = new URLSearchParams({ To: to, From: FROM, Body: body.slice(0, 1500) });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${AC}:${TK}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error_code) return json({ error: d.message || `Twilio error ${r.status}`, code: d.error_code });
    return json({ ok: true, sid: d.sid, status: d.status, to });
  } catch (e) { return json({ error: String(e) }, 500); }
});
