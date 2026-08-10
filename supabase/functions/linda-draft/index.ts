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
    // Pull the WHOLE recent conversation — BOTH the customer's inbound texts AND our own outbound replies —
    // so the notice is reconciled against what was actually said on both sides (e.g. the customer states an
    // invoice is already paid, or we replied agreeing to waive a fee). Without our side, the notice can
    // contradict a promise we already made in writing.
    // ONLY consider very recent conversation — messages within the last 12 hours. An older text (e.g.
    // "paying today" sent days ago) must NOT be quoted into today's notice as if it were current.
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    let texts: any[] = [];
    if (b.customer_id) { try { texts = await sbGet(`messages?customer_id=eq.${encodeURIComponent(b.customer_id)}&received_at=gte.${since}&order=received_at.desc&limit=10&select=body,received_at,direction,is_grace_request`); } catch (_) { /* */ } }
    const textBlock = (texts && texts.length) ? "\n\nRECENT CONVERSATION with this customer (most recent first) — read BOTH sides. Reconcile the notice against it: if the customer states (credibly) that a listed invoice has already been paid, do NOT present it as currently owed and NEVER attach a late fee to it — instead note it as \"you have indicated this is paid; we are confirming on our end\". If they asked for more time / grace until a specific day, confirm it has been noted. Do not contradict anything we ourselves already told them:\n" + texts.map((t: any) => `${t.direction === "out" ? "US → them" : "THEM → us"}: "${(t.body || "").slice(0, 220)}"${t.is_grace_request ? " (grace request)" : ""}`).join("\n") : "";
    // STANDING RULES — durable, admin-editable rules in linda_rules (seeded from real feedback). Injected
    // into every prompt so lessons learned persist and the admin can add new rules without a code change.
    let rulesBlock = "";
    try { const rs = await sbGet(`linda_rules?active=eq.true&order=id.asc&select=rule`); if (rs && rs.length) rulesBlock = "\n\nSTANDING RULES (learned from admin feedback — follow ALL of them):\n" + rs.map((r: any, i: number) => `${i + 1}. ${r.rule}`).join("\n"); } catch (_) { /* */ }
    const hasBody = !!b.current_body;
    const system = hasBody
      ? "You are Linda, the billing assistant for Rent 2 Go LLC (a US car-rental business). Your register is that of a professional accounts department: courteous, measured and businesslike — never chatty or effusive, with no exclamation marks and no decorative emoji — BUT you MUST keep the 🔴 (past-due) and 🟢 (current/coming-due) status markers on the invoice lines exactly as they appear, since they colour-code the balance and are essential. " +
        "You are REWRITING an existing daily account notice so the wording reads clearly and professionally. " +
        "CRITICAL — you MUST preserve, EXACTLY and unchanged: every invoice/line item, every amount, every date, " +
        "every 'Pay now:' URL, subtotals/total, and the customer portal link that appear in the current notice. " +
        "Do NOT remove, summarise, reorder, or alter any figure or link — the payment links and amounts are the " +
        "whole point of the notice. Only improve the greeting, the sentences around the items, and the closing. " +
        "NEVER copy, quote, or prepend our OWN previous messages (e.g. an SMS auto-reply that begins with a 📩 icon, or any 'US → them' line) into this notice — use the conversation only to understand context. The notice must be a single fresh message, not a transcript. " +
        "MATCH TONE TO THE BALANCE — if the balance is small or nearly cleared (e.g. only a single remaining late fee) or the customer has clearly been paying, OPEN by thanking them for their recent payments and warmly ask that they clear the small remaining amount soon. Do NOT use heavy, urgent, or disconnection language for a minor balance. Reserve firm language for genuinely large or long-overdue balances. " +
        "BE CONCISE — this is a short daily notice, not a letter. No meandering, no repetition, no restating the same point twice, no filler pleasantries. A brief greeting, one or two sentences of context, the itemised balance, one clear next step, sign-off. If the customer has told us something (a payment, a grace request), acknowledge it in ONE line and move on. " +
        "COHERENCE IS MANDATORY — the notice must read as one consistent message, never contradict itself. If you acknowledge a grace request (e.g. 'until tomorrow' or 'until 3pm'), you must NOT in the same notice demand payment 'today' or state the vehicle is 'scheduled for disconnection today' — soften the demand to match the grace granted. If the customer states they have paid specific items, LEAD with that acknowledgement and treat those items as settled/pending-confirmation — do not lecture them that the items are 'separate' or 'still open regardless'. Every line item that legitimately remains owed MUST stay in the notice — do not drop any line; only items the customer has shown are paid should be dropped. " +
        "Sign off 'Rent 2 Go LLC'. Return ONLY the full rewritten notice body — same information and links, better wording, internally consistent."
      : "You are Linda, the billing assistant for Rent 2 Go LLC (a US car-rental business). Your register is that of a professional accounts department: courteous, measured and businesslike — never chatty or effusive, with no exclamation marks and no decorative emoji — BUT you MUST keep the 🔴 (past-due) and 🟢 (current/coming-due) status markers on the invoice lines exactly as they appear, since they colour-code the balance and are essential. " +
        "Write a SHORT daily account notice based on the situation. State the amounts and what is past due precisely, " +
        "give one clear next step, and stay firm without threatening. Address the customer by name, with no greeting emoji. Sign off 'Rent 2 Go LLC'. Return ONLY the email body.";
    const user = hasBody
      ? "Customer: " + name + textBlock + "\n\nCURRENT NOTICE — rewrite this, keeping EVERY amount, date and Pay-now link exactly as they are:\n\n" + b.current_body + (examples ? "\n\nStyle reference (match the tone, not the content):\n\n" + examples : "")
      : "Customer: " + name + "\nAccount situation:\n" + JSON.stringify(sit, null, 1) + textBlock +
        (examples ? "\n\nHere is how we have written approved notices for similar situations — match this style:\n\n" + examples : "\n\n(No past examples yet — write a clear, courteous, professional notice.)");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2400, system: system + rulesBlock, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (d.error) return json({ error: d.error.message || JSON.stringify(d.error) }, 502);
    let text = (d.content || []).map((c: any) => c.text || "").join("").trim();
    // Strip any LLM preamble ("Here is the rewritten notice:") and stray --- fences so only the notice remains.
    text = text
      .replace(/^\s*here(?:'|’|`)?s?\s+(?:is\s+)?[^\n]*:?\s*\n+/i, "")   // "Here is the rewritten notice:"
      .replace(/^\s*subject:[^\n]*\n+/i, "")                              // stray subject line (subject is sent separately)
      .replace(/^\s*-{2,}\s*\n+/, "").replace(/\n+\s*-{2,}\s*$/, "")      // leading/trailing --- fences
      .replace(/\n\s*-{2,}\s*\n/g, "\n\n")                                // collapse mid-body divider lines
      .trim();
    // Deterministically remove any of OUR OWN auto-reply blocks the model may have echoed (📩 SMS
    // auto-responder text) — never rely on the prompt alone for this. Drop whole paragraphs that carry
    // the auto-reply signature, then normalise Pay-now links to ONE consistent "Pay now: URL" format.
    text = text.split(/\n{2,}/)
      .filter((p: string) => !/📩|managed by an automated system|reply with an exact date/i.test(p))
      .join("\n\n")
      .replace(/\[\s*Pay now\s*\]\((https?:\/\/[^\s)]+)\)/gi, "Pay now: $1")   // [Pay now](url) -> Pay now: url
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2")                // any other [text](url) -> text: url
      .trim();
    return json({ ok: true, draft: text, model: MODEL, examples_used: (ex || []).length, stop_reason: d.stop_reason || null });
  } catch (e) { return json({ error: String(e) }, 500); }
});
