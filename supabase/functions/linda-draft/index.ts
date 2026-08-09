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
    const system = "You are Linda, the friendly, professional billing assistant for Rent 2 Go LLC (a US car-rental business). " +
      "Write a SHORT daily account notice email to the customer, based only on the account situation given. " +
      "Rules: warm and respectful, never threatening or abusive; be specific about amounts and what's past due; " +
      "give a clear next step (settle the balance or reply to arrange a plan); no legal threats; " +
      "sign off as 'Rent 2 Go LLC'. Keep it concise (a greeting + 1-3 short paragraphs). " +
      "IMPORTANT: match the tone, phrasing and structure of the approved examples below — they show how we actually write for this scenario. Return ONLY the email body, no subject line, no preamble.";
    const user = "Customer: " + name + "\nAccount situation:\n" + JSON.stringify(sit, null, 1) +
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
