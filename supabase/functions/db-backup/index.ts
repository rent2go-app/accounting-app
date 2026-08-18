// db-backup — full logical backup of every business table to a single JSON.
//   mode "download" (default): returns the backup JSON in the response (app saves it to the desktop).
//   mode "store": overwrites ONE updateable object in the private db-backups bucket (latest.json), keeping
//   the prior one as previous.json (2-slot rotation, not a growing pile) — used by the daily cron.
// Auth: service_role (cron) OR an admin email. verify_jwt handled internally.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
// table -> a stable column to order by for consistent pagination (first primary-key column).
const TABLES: Record<string, string> = {
  app_settings: "id", bank_accounts: "id", bank_transactions: "id", bookings: "id", daily_snapshots: "id",
  day_blocks: "day", day_notes: "id", fleet: "id", fleet_accounts: "label", fleet_performance: "month",
  fleet_reasons: "reason", home_budget: "id", linda_accounts: "label", linda_customers: "customer_id",
  linda_day: "day", linda_disconnections: "customer_id", linda_drafts: "id", linda_fees: "invoice_id",
  linda_learnings: "id", linda_notes: "account_label", linda_notice_learnings: "id", linda_payments: "invoice_id",
  linda_report_cache: "k", linda_rules: "id", messages: "id", owners: "id", owners_program: "id",
  personal_budgets: "user_id", promo_codes: "code", reconcile_reports: "id", renters: "id",
  service_area: "town", stripe_income: "id", team_members: "id", team_payouts: "id", team_refunds: "id",
  team_task_catalog: "id", team_tasks: "id", vehicles: "id", waitlist: "id",
};
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
async function dumpTable(t: string, order: string) {
  const rows: any[] = []; let from = 0; const P = 1000;
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${t}?select=*&order=${order}.asc&limit=${P}&offset=${from}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
    if (!r.ok) throw new Error(`${t}: HTTP ${r.status} ${await r.text()}`);
    const d = await r.json(); rows.push(...d); if (d.length < P) break; from += P;
  }
  return rows;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const b = await req.json().catch(() => ({} as any));
    const mode = b.mode || "download";
    if (mode === "status") {
      const r = await fetch(`${SB}/storage/v1/object/list/db-backups`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 20 }) });
      const objs = r.ok ? await r.json() : [];
      return json({ ok: true, objects: (objs || []).map((o: any) => ({ name: o.name, size: (o.metadata || {}).size || null, updated: (o.metadata || {}).lastModified || o.updated_at || null })) });
    }
    const data: Record<string, any[]> = {};
    let totalRows = 0;
    for (const [t, order] of Object.entries(TABLES)) {
      try { const rows = await dumpTable(t, order); data[t] = rows; totalRows += rows.length; }
      catch (e) { data[t] = []; console.error("dump fail", t, String(e)); }
    }
    const backup = { meta: { app: "rent2go-accounting", created_at: new Date().toISOString(), format: 1, tables: Object.keys(data), total_rows: totalRows }, data };
    if (mode === "store") {
      const body = JSON.stringify(backup);
      const target = b.target === "pre-restore.json" ? "pre-restore.json" : "latest.json";
      // For the daily latest.json, rotate the prior copy to previous.json first (2-slot history, no pile-up).
      if (target === "latest.json") {
        try {
          const cur = await fetch(`${SB}/storage/v1/object/db-backups/latest.json`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
          if (cur.ok) { const prev = await cur.text(); await fetch(`${SB}/storage/v1/object/db-backups/previous.json`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", "x-upsert": "true" }, body: prev }); }
        } catch (_) { /* first run */ }
      }
      const up = await fetch(`${SB}/storage/v1/object/db-backups/${target}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", "x-upsert": "true" }, body });
      if (!up.ok) return json({ error: "store failed: " + await up.text() }, 502);
      return json({ ok: true, stored: target, total_rows: totalRows, tables: Object.keys(data).length, bytes: body.length });
    }
    return json({ ok: true, backup });
  } catch (e) { return json({ error: String(e) }, 500); }
});
