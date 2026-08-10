// ai-notices — AI-writes the day's template notices. Finds fresh, unsent, unreviewed, not-yet-AI'd drafts
// and rewrites each via linda-draft (professional tone, preserves links/markers, reads grace texts). Idempotent
// via ai_drafted flag → never re-writes an edited/sent notice. Runs on a cron a few minutes after each scan.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
async function sbGet(p: string) { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbPatch(p: string, body: unknown) { await fetch(`${SB}/rest/v1/${p}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) }); }
async function draft(d: any, sit: any) {
  const r = await fetch(`${SB}/functions/v1/linda-draft`, { method: "POST", headers: { Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: (d.customer_name || "there").split(" ")[0], scenario: sit.state || d.kind, situation: sit, customer_id: d.customer_id, current_body: d.body }) });
  return await r.json();
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const limit = 40;
    const drafts = await sbGet(`linda_drafts?select=id,customer_id,customer_name,account_label,kind,body&status=eq.draft&reviewed_at=is.null&or=(ai_drafted.is.null,ai_drafted.is.false)&body=not.is.null&limit=${limit}`);
    if (!drafts.length) return json({ ok: true, drafted: 0, note: "nothing to AI-draft" });
    const custs = await sbGet(`linda_customers?select=customer_id,account_label,state,pastdue_count,outstanding,on_plan`);
    const cmap: Record<string, any> = {}; for (const c of custs) cmap[c.account_label + "|" + c.customer_id] = c;
    let done = 0, skipped = 0;
    for (let i = 0; i < drafts.length; i += 6) {   // batches of 6 to stay within the wall-clock budget
      const batch = drafts.slice(i, i + 6);
      await Promise.all(batch.map(async (d: any) => {
        const c = cmap[d.account_label + "|" + d.customer_id] || {};
        const sit = { state: c.state || d.kind, pastdue_count: +(c.pastdue_count || 0), outstanding: +(c.outstanding || 0), on_plan: !!c.on_plan };
        try {
          const r = await draft(d, sit);
          // SAFETY GUARD — never save a rewrite that lost content or was cut off. Keep the clean template
          // instead. Guards against: (1) truncation mid-URL (broken Pay-now links), (2) dropped Pay-now
          // links, (3) dropped 🔴/🟢 line items, (4) suspiciously short output. A rejected draft stays as
          // the template with ai_drafted unset, so it is retried on the next run rather than lost.
          if (r && r.draft) {
            const links = (s: string) => (s.match(/invoice\.stripe\.com/g) || []).length;
            const marks = (s: string) => (s.match(/🔴|🟢/g) || []).length;
            const truncated = r.stop_reason === "max_tokens";
            const lostLinks = links(r.draft) < links(d.body);
            const lostLines = marks(r.draft) < marks(d.body);
            const tooShort = r.draft.length < d.body.length * 0.5;
            if (truncated || lostLinks || lostLines || tooShort) { skipped++; return; }   // keep template, retry next run
            await sbPatch(`linda_drafts?id=eq.${d.id}`, { body: r.draft, ai_drafted: true }); done++;
          }
        } catch (_) { /* leave template if AI fails */ }
      }));
    }
    return json({ ok: true, drafted: done, skipped, seen: drafts.length });
  } catch (e) { return json({ error: String(e) }, 500); }
});
