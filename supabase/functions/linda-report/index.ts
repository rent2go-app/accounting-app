// linda-report — payment-behavior trend for Linda's dashboard.
// Pulls Stripe invoice history across the fleets (LINDA_ACCOUNTS) and buckets by week (or month):
// how much was collected, how many paid on time vs late, average days late, late-fee $.
// Overlays Linda's own activity from the local tables (notices sent, fees raised/cured, disconnections/restores)
// so you can see payment behaviour against when Linda started intervening (first notice: 2026-07-29).
// Auth: verify_jwt=true — service_role or an admin email. Read-only.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]"); // [{label,key,portal}]
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const LINDA_STARTED = "2026-07-29"; // first customer notice sent
const enc = encodeURIComponent;
function json(o: any, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
async function stripe(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } }); return await r.json(); }
async function stripeAll(base: string, key: string) { let out: any[] = [], sa: string | null = null; while (true) { const d = await stripe(base + (sa ? `&starting_after=${sa}` : ""), key); const rows = d.data || []; out = out.concat(rows); if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break; } return out; }
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json().catch(() => []) : []; }
async function sbUpsert(path: string, body: unknown) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(body) }); }
function isLateFee(i: any) { const d = (i.lines?.data?.[0]?.description || i.description || "").toLowerCase(); return d.includes("late fee") || d.includes("latefee"); }

// bucket key for a unix-seconds timestamp
function bucket(sec: number, gran: string) {
  const d = new Date(sec * 1000);
  if (gran === "month") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // week — Monday start, UTC
  const day = d.getUTCDay(); const diff = (day + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return mon.toISOString().slice(0, 10);
}
function bucketISO(iso: string, gran: string) { return bucket(Math.floor(new Date(iso).getTime() / 1000), gran); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const gran = body.granularity === "month" ? "month" : "week";
    const now = Math.floor(Date.now() / 1000);
    const from = body.from ? Math.floor(new Date(body.from).getTime() / 1000) : (now - 120 * 86400);
    const to = body.to ? Math.floor(new Date(body.to).getTime() / 1000) : now;
    const onlyLabel = body.account_label || null;
    const accts = ACCTS.filter((a: any) => !onlyLabel || a.label === onlyLabel);

    // The default all-fleet view is expensive (every fleet, paginated) — serve it from cache so the
    // dashboard loads instantly. Filtered views (a single fleet / custom dates) compute live and are fast.
    const isDefault = !onlyLabel && !body.from && !body.to;
    const cacheKey = `default:${gran}`;
    if (isDefault && !body.refresh) {
      const c = await sbGet(`linda_report_cache?k=eq.${enc(cacheKey)}&select=payload,built_at`);
      if (c && c[0]?.payload) return json({ ...c[0].payload, cached: true, built_at: c[0].built_at });
    }

    // ---- Stripe invoice history → payment-timeliness buckets ----
    const B: Record<string, any> = {};
    const row = (k: string) => (B[k] = B[k] || { bucket: k, invoices: 0, paid: 0, ontime: 0, late: 0, days_late_sum: 0, collected: 0, latefee_collected: 0, open_pastdue: 0 });
    for (const a of accts) {
      const invs = await stripeAll(`https://api.stripe.com/v1/invoices?created%5Bgte%5D=${from}&created%5Blte%5D=${to}&limit=100`, a.key);
      for (const i of invs) {
        if (i.status === "void" || i.status === "draft") continue;
        const ref = i.due_date || i.created || now;
        const r = row(bucket(ref, gran));
        r.invoices++;
        const fee = isLateFee(i);
        if (i.status === "paid") {
          const pat = i.status_transitions?.paid_at || i.created || 0;
          const dl = i.due_date ? Math.floor((pat - i.due_date) / 86400) : 0; // no due_date => auto-charged, treat on-time
          r.paid++;
          if (dl > 0) { r.late++; r.days_late_sum += dl; } else r.ontime++;
          const amt = (i.amount_paid || 0) / 100;
          r.collected += amt;
          if (fee) r.latefee_collected += amt;
        } else if ((i.status === "open" || i.status === "uncollectible") && i.due_date && i.due_date < now) {
          r.open_pastdue++;
        }
      }
    }
    const months = Object.values(B).sort((x: any, y: any) => x.bucket < y.bucket ? -1 : 1).map((r: any) => ({
      bucket: r.bucket, invoices: r.invoices, paid: r.paid, ontime: r.ontime, late: r.late,
      ontime_pct: r.paid ? Math.round(r.ontime / r.paid * 100) : null,
      avg_days_late: r.late ? Math.round(r.days_late_sum / r.late * 10) / 10 : 0,
      collected: Math.round(r.collected * 100) / 100,
      latefee_collected: Math.round(r.latefee_collected * 100) / 100,
      open_pastdue: r.open_pastdue,
    }));

    // ---- Linda activity overlay from local tables ----
    const iv: Record<string, any> = {};
    const irow = (k: string) => (iv[k] = iv[k] || { bucket: k, reminders: 0, disconnect_notices: 0, fees_raised: 0, fees_cured: 0, disconnections: 0, restores: 0 });
    const fromISO = new Date(from * 1000).toISOString();
    for (const d of await sbGet(`linda_drafts?sent_at=gte.${enc(fromISO)}&select=sent_at,kind`)) { if (!d.sent_at) continue; const r = irow(bucketISO(d.sent_at, gran)); if (String(d.kind).includes("disconnect")) r.disconnect_notices++; else r.reminders++; }
    for (const f of await sbGet(`linda_fees?select=raised_at,created_at,dismissed_at`)) { const ra = f.raised_at || f.created_at; if (ra) irow(bucketISO(ra, gran)).fees_raised++; if (f.dismissed_at) irow(bucketISO(f.dismissed_at, gran)).fees_cured++; }
    for (const dc of await sbGet(`linda_disconnections?select=created_at,restored,restored_at`)) { if (dc.created_at) irow(bucketISO(dc.created_at, gran)).disconnections++; if (dc.restored && dc.restored_at) irow(bucketISO(dc.restored_at, gran)).restores++; }
    const interventions = Object.values(iv).sort((x: any, y: any) => x.bucket < y.bucket ? -1 : 1);

    // ---- headline totals over the window ----
    const T = months.reduce((t: any, m: any) => ({ collected: t.collected + m.collected, paid: t.paid + m.paid, ontime: t.ontime + m.ontime, late: t.late + m.late, latefee: t.latefee + m.latefee_collected }), { collected: 0, paid: 0, ontime: 0, late: 0, latefee: 0 });
    const totals = { collected: Math.round(T.collected * 100) / 100, payments: T.paid, ontime: T.ontime, late: T.late, ontime_pct: T.paid ? Math.round(T.ontime / T.paid * 100) : null, latefee_collected: Math.round(T.latefee * 100) / 100 };

    const result = { ok: true, granularity: gran, from: fromISO, to: new Date(to * 1000).toISOString(), linda_started: LINDA_STARTED, accounts: accts.map((a: any) => a.label), months, interventions, totals };
    if (isDefault) await sbUpsert("linda_report_cache", [{ k: cacheKey, payload: result, built_at: new Date().toISOString() }]);
    return json(result);
  } catch (e) { return json({ error: String(e) }, 500); }
});
