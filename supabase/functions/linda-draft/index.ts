// linda-draft — LLM-written daily notice. Given a customer's account situation, pulls Linda's learned
// examples (past approved notices for similar scenarios) and asks Claude to draft one that reads naturally
// and matches how the admin actually writes. Admin reviews/edits before sending; each edit feeds learning.
// verify_jwt=true (service_role / admin). Secret: ANTHROPIC_API_KEY.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AK = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("LINDA_MODEL") || "claude-sonnet-4-6";
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  if (!AK) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
  try {
    const b = await req.json().catch(() => ({} as any));
    const name = b.name || "there";
    const sit = b.situation || {};
    const scenario = b.scenario || sit.state || "reminder";
    // Pull the most recent learned examples — prefer the same scenario, then any recent.
    let ex = await sbGet(`linda_notice_learnings?scenario=eq.${encodeURIComponent(scenario)}&order=created_at.desc&limit=6&select=situation,approved_text`);
    if (!ex.length) ex = await sbGet(`linda_notice_learnings?order=created_at.desc&limit=6&select=situation,approved_text`);
    const examples = (ex || []).map((e: any, i: number) => `EXAMPLE ${i + 1}\nSituation: ${JSON.stringify(e.situation)}\nApproved notice:\n${e.approved_text}`).join("\n\n---\n\n");
    // Pull the customer's recent INBOUND texts so the notice can acknowledge what they've said (esp. grace /
    // "give me until X" requests) and reflect it — instead of ignoring a message they just sent.
    let texts: any[] = [];
    if (b.customer_id) { try { texts = await sbGet(`messages?customer_id=eq.${encodeURIComponent(b.customer_id)}&direction=eq.in&order=received_at.desc&limit=4&select=body,received_at,is_grace_request`); } catch (_) { /* */ } }
    const textBlock = (texts && texts.length) ? "\n\nThe customer recently texted us (most recent first) — acknowledge these naturally, and if they asked for more time / grace until a specific day or time, recognise it warmly and reference it:\n" + texts.map((t: any) => `• "${(t.body || "").slice(0, 200)}"${t.is_grace_request ? " (grace request)" : ""}`).join("\n") : "";
    const hasBody = !!b.current_body;
    const system = hasBody
      ? "You are Linda, the friendly, professional billing assistant for Rent 2 Go LLC (a US car-rental business). " +
        "You are REWRITING an existing daily account notice so the wording reads more naturally and warm. " +
        "CRITICAL — you MUST preserve, EXACTLY and unchanged: every invoice/line item, every amount, every date, " +
        "every 'Pay now:' URL, subtotals/total, and the customer portal link that appear in the current notice. " +
        "Do NOT remove, summarise, reorder, or alter any figure or link — the payment links and amounts are the " +
        "whole point of the notice. Only improve the greeting, the sentences around the items, and the closing. " +
        "If the customer recently texted (especially a grace / 'give me until X' request), acknowledge it warmly. " +
        "Sign off 'Rent 2 Go LLC'. Return ONLY the full rewritten notice body — same information and links, better wording."
      : "You are Linda, the friendly, professional billing assistant for Rent 2 Go LLC (a US car-rental business). " +
        "Write a SHORT daily account notice based on the situation. Warm, specific about amounts and what's past due, " +
        "clear next step, no legal threats. Sign off 'Rent 2 Go LLC'. Return ONLY the email body.";
    const user = hasBody
      ? "Customer: " + name + textBlock + "\n\nCURRENT NOTICE — rewrite this, keeping EVERY amount, date and Pay-now link exactly as they are:\n\n" + b.current_body + (examples ? "\n\nStyle reference (match the tone, not the content):\n\n" + examples : "")
      : "Customer: " + name + "\nAccount situation:\n" + JSON.stringify(sit, null, 1) + textBlock +
        (examples ? "\n\nHere is how we have written approved notices for similar situations — match this style:\n\n" + examples : "\n\n(No past examples yet — write a clear, kind, professional notice.)");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (d.error) return json({ error: d.error.message || JSON.stringify(d.error) }, 502);
    const text = (d.content || []).map((c: any) => c.text || "").join("").trim();
    return json({ ok: true, draft: text, model: MODEL, examples_used: (ex || []).length });
  } catch (e) { return json({ error: String(e) }, 500); }
});
