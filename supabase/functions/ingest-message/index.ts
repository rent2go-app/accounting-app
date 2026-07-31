// ingest-message — receives an incoming customer text (from Google Voice / Quo, forwarded by an
// Apps Script or a webhook) and logs it to `messages`. Guarded by MSG_INGEST_TOKEN (no JWT needed).
// Matches the sender phone to a linda_customers row and flags likely grace/extension requests.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("MSG_INGEST_TOKEN") || "";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const GRACE_RX = /\b(grace|extension|extend|more time|another day|one more day|by tomorrow|pay(?:ing)?\s+(?:tomorrow|later|monday|friday)|can'?t\s+pay|need(?:s)?\s+(?:a bit|more)?\s*time|hold\s+(?:on|off)|give me|wait until|push (?:it|to))\b/i;
function digits(x: string) { return String(x || "").replace(/\D/g, ""); }
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbPost(path: string, body: unknown, prefer: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); return r.ok ? await r.json().catch(() => null) : null; }
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const token = req.headers.get("x-ingest-token") || body.token || "";
    if (!TOKEN || token !== TOKEN) return json({ error: "unauthorized" }, 401);

    const from = String(body.from || body.from_number || "").trim();
    const text = String(body.body || body.message || "").trim();
    if (!text && !from) return json({ error: "empty message" }, 400);
    const fromD = digits(from).slice(-10);

    // match sender to a customer — by phone (last 10 digits), then fall back to the contact name
    const rows = await sbGet(`linda_customers?select=customer_id,account_label,name,phone`) as any[];
    const norm = (x: string) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
    let cust: any = null;
    if (fromD.length >= 7) cust = rows.find((c) => digits(c.phone).slice(-10) === fromD) || null;
    const nm = norm(body.name || body.from_name || "");
    if (!cust && nm) cust = rows.find((c) => norm(c.name) === nm) || null;
    // back-fill the customer's phone from this text so future texts match by number
    if (cust && from && digits(cust.phone).length < 10) {
      await fetch(`${SB}/rest/v1/linda_customers?customer_id=eq.${encodeURIComponent(cust.customer_id)}&account_label=eq.${encodeURIComponent(cust.account_label)}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify({ phone: from }) });
    }

    const row = {
      source: body.source || "google_voice",
      from_number: from, from_name: body.name || body.from_name || (cust ? cust.name : "") || "",
      body: text, received_at: body.received_at || new Date().toISOString(),
      customer_id: cust ? cust.customer_id : null, account_label: cust ? cust.account_label : null, customer_name: cust ? cust.name : null,
      is_grace_request: GRACE_RX.test(text), direction: "in", handled: false,
      ext_id: body.ext_id || null,
    };
    // dedupe on ext_id if provided
    const ins = await sbPost(`messages${body.ext_id ? "?on_conflict=ext_id" : ""}`, [row], body.ext_id ? "resolution=ignore-duplicates,return=representation" : "return=representation");
    const id = ins && ins[0] ? ins[0].id : null;
    return json({ ok: true, id, matched: !!cust, customer: cust ? cust.name : null, is_grace_request: row.is_grace_request });
  } catch (e) { return json({ error: String(e) }, 500); }
});
