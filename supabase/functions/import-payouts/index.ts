// import-payouts — pull INSTANT Stripe payouts from the Rent 2 Go (1.0) and Rent 2 Go 2.0 accounts
// into the ledger (day_blocks) as daily income. This is the basis of daily income.
//
// DAY CYCLE = MIDNIGHT-to-MIDNIGHT (ET): a payout belongs to the ET calendar date it was created
// (00:00–24:00). No shift.
//
// Idempotent: each payout is written once, keyed by ref "sp:<payout_id>" — re-runs (and the 8x/day
// cron) never duplicate. Auto-imported lines get a distinct COLOUR (#a855f7 purple) so any manual
// duplicate you entered by hand is easy to spot and delete. verify_jwt=true (service_role cron / admin).
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const TZ = "America/New_York";
const AUTO_COLOR = "#a855f7";
const WANT: Record<string, string> = { "RENT 2 GO - 1.0": "Rent 2 Go 1.0", "RENT 2 GO LLC 2.0": "Rent 2 Go 2.0" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function etYMD(e: number) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(e * 1000)); }
function etTime(e: number) { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(e * 1000)); }
function etMD(e: number) { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(e * 1000)); }
function ledgerDay(created: number) { return etYMD(created); } // calendar day (midnight-to-midnight ET)
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function stripeAll(base: string, key: string) {
  let out: any[] = [], sa: string | null = null;
  while (true) {
    const r = await fetch(base + (sa ? `&starting_after=${sa}` : ""), { headers: { Authorization: `Bearer ${key}`, "User-Agent": "import-payouts" } });
    const d = await r.json(); const rows = d.data || [];
    out = out.concat(rows);
    if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break;
  }
  return out;
}
// OWNERS INCOME by ledger-day — sum the NET of every charge (in the window) whose invoice is tagged
// r2g_income_type=owners_income. Filtering balance-transactions by DATE works for instant payouts (filtering
// by payout does not). Returns { "YYYY-MM-DD": ownerNet }. Used to move owner income to the Income-lines side.
async function ownerIncomeByDay(key: string, from: number) {
  const byDay: Record<string, number> = {};
  let sa: string | null = null, guard = 0;
  while (guard++ < 40) {
    const url = `https://api.stripe.com/v1/invoices?status=paid&limit=100&created%5Bgte%5D=${from}` + (sa ? `&starting_after=${sa}` : "");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "import-payouts" } });
    const d = await r.json(); const rows = d.data || [];
    for (const inv of rows) {
      if (inv.metadata && (inv.metadata.r2g_income_type === "owners_income" || inv.metadata.r2g_owner_maint === "true")) {
        const pat = inv.status_transitions && inv.status_transitions.paid_at;
        if (pat) { const day = etYMD(pat); byDay[day] = (byDay[day] || 0) + (inv.amount_paid || 0) / 100; }   // gross owner payment
      }
    }
    if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break;
  }
  for (const k in byDay) byDay[k] = Math.round(byDay[k] * 100) / 100;
  return byDay;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({} as any));
    const now = Math.floor(Date.now() / 1000);
    // Lookback: cron passes nothing → 60h (covers current+previous day, cheap). The manual button passes
    // {hours:720} (30 days) so a human "Pull now" sweeps up ANY payout that slipped. Backfill: {from:<unix>}.
    const from = body.from ? Number(body.from) : now - (Number(body.hours) || 60) * 3600;

    const byDay: Record<string, { id: string; amount: number; lbl: string; ts: string }[]> = {};
    const perAcct: Record<string, number> = {};
    for (const a of ACCTS) {
      const short = WANT[a.label];
      if (!short || !a.key) continue;
      const payouts = await stripeAll(`https://api.stripe.com/v1/payouts?limit=100&created%5Bgte%5D=${from}`, a.key);
      for (const p of payouts) {
        // Pull EVERY payout that actually paid out — instant AND standard/automatic. Any payout is cash
        // leaving Stripe for the bank, so it must land in the ledger. Deduped by id, so no double-count.
        if (p.status === "canceled" || p.status === "failed") continue;
        const amt = Math.round(p.amount || 0) / 100;
        if (amt <= 0) continue;
        const day = ledgerDay(p.created);
        (byDay[day] = byDay[day] || []).push({ id: p.id, amount: amt, lbl: short, ts: `${etMD(p.created)} · ${etTime(p.created)}` });
        perAcct[short] = (perAcct[short] || 0) + amt;
      }
    }

    // OWNERS INCOME per ledger-day, from the 2.0 account's tagged charges (works for instant payouts).
    const ownerByDay: Record<string, number> = {};
    const acc20: any = ACCTS.find((a: any) => a.label === "RENT 2 GO LLC 2.0");
    if (acc20 && acc20.key) { try { Object.assign(ownerByDay, await ownerIncomeByDay(acc20.key, from)); } catch (_) { /* leave empty */ } }

    const days = Array.from(new Set([...Object.keys(byDay), ...Object.keys(ownerByDay)])).sort();
    let added = 0, skipped = 0;
    const perDay: Record<string, { added: number; total: number; owner: number }> = {};
    for (const day of days) {
      const rows = await sbGet(`day_blocks?day=eq.${day}&select=day,deposits,income,expenses`);
      const row = rows[0] || { day, deposits: [], income: [], expenses: [] };
      let deposits = (row.deposits || []).slice();            // "Daily deposits" — CAR payments (per transfer)
      let income = (row.income || []).slice();                // Income-lines side — Owners Income lands here
      const haveDep = new Set(deposits.filter((x: any) => x && typeof x === "object" && x.ref).map((x: any) => x.ref));
      let dAdded = 0, dTot = 0;
      for (const pay of (byDay[day] || [])) {
        const ref = "sp:" + pay.id; dTot += pay.amount;
        if (haveDep.has(ref)) { skipped++; continue; }         // already imported — never duplicate
        deposits.push({ a: pay.amount, ref, lbl: pay.lbl, ts: pay.ts, src: "stripe" });   // full payout (car)
        haveDep.add(ref); added++; dAdded++;
      }
      // Book OWNERS INCOME as an Income line, and net the SAME amount out of the deposits (a single
      // reclass line) so the deposits side reads as car payments only. Recomputed each run so it stays
      // correct as more owner payments land the same day.
      const O = ownerByDay[day] || 0;
      income = income.filter((l: any) => !(Array.isArray(l) && l[4] === "oi:" + day));
      deposits = deposits.filter((x: any) => !(x && x.ref === "oir:" + day));
      if (O > 0.005) {
        income.push(["Owners Income — Stripe 2.0", O, "Owners Income", "", "oi:" + day]);
        deposits.push({ a: -O, ref: "oir:" + day, lbl: "less: Owners Income → Income lines", ts: "", src: "stripe" });
      }
      perDay[day] = { added: dAdded, total: Math.round(dTot * 100) / 100, owner: O };
      await sbPost(`day_blocks?on_conflict=day`, [{ day, deposits, income, expenses: row.expenses || [], updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal");
    }
    return json({ ok: true, from, days, added, skipped, perDay, perAcct, ownerByDay });
  } catch (e) { return json({ error: String(e) }, 500); }
});
