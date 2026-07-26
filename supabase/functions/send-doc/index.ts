// Emails an invoice/statement (HTML body) via Resend.
// Auth: verify_jwt = true — only logged-in app users can call it.
// Secrets: RESEND_API_KEY, RESEND_FROM (e.g. "Rent 2 Go <invoices@rentaride2go.com>").
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ error: "RESEND_API_KEY not set" }, 500);
    const from = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_) { return json({ error: "invalid JSON body" }, 400); }
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const html = String(body.html || "");
    const replyTo = body.replyTo ? String(body.replyTo) : undefined;
    if (!to || !subject || !html) return json({ error: "to, subject and html are required" }, 400);

    const payload: Record<string, unknown> = { from, to: [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: d?.message || d?.error || ("Resend HTTP " + r.status), detail: d }, 400);
    return json({ ok: true, id: d.id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
