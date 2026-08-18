// db-restore — restores a backup JSON (from an uploaded desktop file, or the stored latest.json) by
// UPSERTING every table by its primary key. Upsert = rows in the backup overwrite/insert by PK; it does
// NOT delete rows created since the backup, so a restore can't silently wipe newer data.
// Safety: before touching anything it writes a pre-restore snapshot (pre-restore.json) so the restore
// itself is reversible. Guarded: admin/service-role AND body.confirm === "RESTORE".
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
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
    if (!r.ok) break; const d = await r.json(); rows.push(...d); if (d.length < P) break; from += P;
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
    if (b.confirm !== "RESTORE") return json({ error: "confirmation required (confirm:'RESTORE')" }, 400);
    // ── SINGLE-TABLE mode: the app restores a big backup table-by-table so no one call can time out. It
    // is expected to save its own pre-restore snapshot first (db-backup mode:store target:pre-restore.json).
    if (b.table && Array.isArray(b.rows)) {
      const t = b.table;
      if (!TABLES[t]) return json({ error: "unknown table: " + t }, 400);
      const rows = b.rows; let done = 0, err = "";
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const r = await fetch(`${SB}/rest/v1/${t}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(batch) });
        if (r.ok) done += batch.length; else { err = (await r.text()).slice(0, 300); break; }
      }
      return json(err ? { ok: false, table: t, restored: done, error: err } : { ok: true, table: t, restored: done });
    }
    // ── FULL-snapshot mode (small backups) — with an automatic pre-restore safety snapshot ──
    let snap = b.snapshot;
    if (!snap && b.from === "latest") {
      const r = await fetch(`${SB}/storage/v1/object/db-backups/latest.json`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
      if (!r.ok) return json({ error: "no stored latest.json to restore from" }, 404);
      snap = await r.json();
    }
    if (!snap || !snap.data || typeof snap.data !== "object") return json({ error: "invalid backup: missing .data" }, 400);
    const wantTables = Object.keys(snap.data).filter((t) => TABLES[t]);
    if (!wantTables.length) return json({ error: "backup contains no known tables" }, 400);
    // ── SAFETY: snapshot the current state of the tables we're about to touch → pre-restore.json ──
    try {
      const preData: Record<string, any[]> = {};
      for (const t of wantTables) preData[t] = await dumpTable(t, TABLES[t]);
      const pre = { meta: { app: "rent2go-accounting", created_at: new Date().toISOString(), format: 1, note: "auto pre-restore snapshot", tables: wantTables }, data: preData };
      await fetch(`${SB}/storage/v1/object/db-backups/pre-restore.json`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", "x-upsert": "true" }, body: JSON.stringify(pre) });
    } catch (e) { return json({ error: "pre-restore snapshot failed, aborting for safety: " + String(e) }, 500); }
    // ── RESTORE: upsert each table by primary key, in batches ──
    const result: Record<string, any> = {};
    for (const t of wantTables) {
      const rows = snap.data[t];
      if (!Array.isArray(rows) || !rows.length) { result[t] = 0; continue; }
      let done = 0, err = "";
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const r = await fetch(`${SB}/rest/v1/${t}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(batch) });
        if (r.ok) done += batch.length; else { err = (await r.text()).slice(0, 200); break; }
      }
      result[t] = err ? { restored: done, error: err } : done;
    }
    return json({ ok: true, restored_tables: wantTables.length, detail: result, safety: "pre-restore.json written" });
  } catch (e) { return json({ error: String(e) }, 500); }
});
