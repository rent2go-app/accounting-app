// reconcile-day — end-of-day bank reconciliation. Refreshes the bank + payouts, ties the sheet's actual
// cash to the bank's close for the last COMPLETED day (via a tagged, idempotent auto-reconcile adjustment),
// and WRITES A REPORT of exactly what it did to reconcile_reports (viewable in the app's Bank tab).
// Runs on a daily midnight-ET cron. verify_jwt=true (service_role cron / admin).
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const TZ = "America/New_York";
const IGNORE_LAST4: Record<string, number> = { "2185": 1 };   // excluded from totals (matches the app)
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function etYMD(e: number) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(e * 1000)); }
function r2(v: number) { return Math.round(v * 100) / 100; }
function num(x: any) { const n = Number(x); return isFinite(n) ? n : 0; }
function dval(x: any) { return (x && typeof x === "object") ? num(x.a) : num(x); }
async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function sbPatch(path: string, body: unknown) { await fetch(`${SB}/rest/v1/${path}`, { method: "PATCH", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) }); }
async function invoke(fn: string, body: unknown) { try { const r = await fetch(`${SB}/functions/v1/${fn}`, { method: "POST", headers: { Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: String(e) }; } }
const isAdj = (l: any) => Array.isArray(l) && (l[2] || "") === "Adjustment";
const isAutoRecon = (l: any) => Array.isArray(l) && l[4] === "autorecon";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({} as any));
    const dry = !!body.dry_run;
    // 1) Pull the latest bank data + payouts so we reconcile against fresh figures.
    const bankRes = await invoke("bank-refresh", { sync_transactions: true, refresh: true, days: 14 });
    const payRes = await invoke("import-payouts", { hours: 720 });
    const newTx = num(bankRes && bankRes.total_transactions);
    const bankThrough = (bankRes && bankRes.latest_txn) || null;
    const newPayouts = num(payRes && payRes.added);

    // 2) Determine the settle day = last day_blocks day strictly before today (ET).
    const now = Math.floor(Date.now() / 1000);
    const todayET = body.settle_day ? null : etYMD(now);
    const blocks = await sbGet(`day_blocks?select=day,deposits,income,expenses&order=day.asc`);
    const days = blocks.map((b: any) => b.day).filter((d: string) => body.settle_day ? d <= body.settle_day : d < todayET);
    const settleDay = body.settle_day || days[days.length - 1];
    if (!settleDay) return json({ error: "no completed day to reconcile" });
    const byDay: Record<string, any> = {}; for (const b of blocks) byDay[b.day] = b;

    // 3) Sheet ACTUAL cash through settleDay = opening + deposits + income (incl. reconciliation adjustments)
    //    − PAID expenses. Exclude the settleDay's own auto-recon line so we can recompute it cleanly.
    const st = await sbGet(`app_settings?id=eq.1&select=opening_balance`);
    const OPEN = num(st[0] && st[0].opening_balance);
    let sheetBase = OPEN;
    for (const b of blocks) {
      if (b.day > settleDay) continue;
      for (const x of (b.deposits || [])) sheetBase += dval(x);
      for (const l of (b.income || [])) { if (b.day === settleDay && isAutoRecon(l)) continue; if (Array.isArray(l)) sheetBase += num(l[1]); }
      for (const l of (b.expenses || [])) { if (Array.isArray(l) && l[3]) sheetBase -= num(l[1]); }
    }
    sheetBase = r2(sheetBase);

    // 4) Bank as of settleDay close = current balance (non-excluded accts) − activity dated AFTER settleDay.
    const accts = await sbGet(`bank_accounts?select=id,last4,subcategory,balance_current`);
    const excluded: Record<string, number> = {};
    for (const a of accts) if ((a.subcategory || "").toLowerCase() === "savings" || IGNORE_LAST4[a.last4 || ""]) excluded[a.id] = 1;
    const bankNow = r2(accts.filter((a: any) => !excluded[a.id]).reduce((s: number, a: any) => s + num(a.balance_current), 0));
    const inclIds = accts.filter((a: any) => !excluded[a.id]).map((a: any) => a.id);
    let afterAmt = 0, unbooked = 0;
    const bkTags = new Set<string>();
    for (const b of blocks) { for (const l of (b.income || [])) if (Array.isArray(l) && typeof l[4] === "string" && l[4].startsWith("bk:")) bkTags.add(l[4].slice(3)); for (const l of (b.expenses || [])) if (Array.isArray(l)) for (const c of l) if (typeof c === "string" && c.startsWith("bk:")) bkTags.add(c.slice(3)); }
    if (inclIds.length) {
      const idIn = inclIds.map((x: string) => `"${x}"`).join(",");
      const tx = await sbGet(`bank_transactions?account_id=in.(${idIn})&select=id,amount,transacted_at,posted_at`);
      for (const t of tx) {
        const d = t.transacted_at || t.posted_at || "";
        if (d > settleDay) afterAmt += num(t.amount);
        // "unbooked" review pointer: recent txns (within 7d of settleDay) not yet booked into the ledger
        if (d && d <= settleDay && !bkTags.has(t.id)) { const dd = (Date.parse(settleDay) - Date.parse(d)) / 86400000; if (dd >= 0 && dd <= 7) unbooked++; }
      }
    }
    const bankSettled = r2(bankNow - afterAmt);
    const neededAdj = r2(bankSettled - sheetBase);   // the auto-recon adjustment that ties sheet → bank

    // 5) Tie the sheet to the bank — but SAFELY. Only auto-book a SMALL residual (timing noise). A large gap
    //    means real bank activity isn't in the ledger yet; we do NOT bury that in a plug — we report it so it
    //    can be reviewed/booked. autobook_max (default $200) is the ceiling for an automatic true-up.
    const THRESH = body.autobook_max != null ? num(body.autobook_max) : 200;
    let action: string; let booked = false;
    if (Math.abs(neededAdj) < 0.01) action = "already tied — no change";
    else if (Math.abs(neededAdj) <= THRESH) { action = "auto-booked " + (neededAdj >= 0 ? "+" : "") + neededAdj.toFixed(2) + " reconciliation adjustment (small residual)"; booked = true; }
    else action = "NOT auto-booked — variance $" + neededAdj.toFixed(2) + " is above the $" + THRESH.toFixed(0) + " limit; likely from " + unbooked + " un-booked bank item(s). Review & book them in the Bank tab.";
    if (!dry) {
      const row = byDay[settleDay] || { day: settleDay, deposits: [], income: [], expenses: [] };
      let inc = (row.income || []).filter((l: any) => !isAutoRecon(l));   // always clear any stale auto-recon line
      if (booked) inc.push(["Auto bank reconciliation — sheet tied to bank close", neededAdj, "Adjustment", "#0ea5e9", "autorecon"]);
      await sbPost(`day_blocks?on_conflict=day`, [{ day: settleDay, deposits: row.deposits || [], income: inc, expenses: row.expenses || [], updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal");
    }

    // 6) Build + store the report.
    const tiedTo = r2(sheetBase + (Math.abs(neededAdj) >= 0.01 ? neededAdj : 0));
    const summary = `Reconciled ${settleDay}: bank close $${bankSettled.toFixed(2)} vs sheet $${sheetBase.toFixed(2)} → ${Math.abs(neededAdj) < 0.01 ? "already tied ✓" : action}; sheet now $${tiedTo.toFixed(2)}. Pulled ${newTx} bank txns (posted through ${bankThrough || "?"}), ${newPayouts} new payout(s). ${unbooked} bank item(s) in last 7d still un-booked — review in Bank tab.`;
    const detail = { settle_day: settleDay, opening: OPEN, sheet_before: sheetBase, bank_now: bankNow, bank_after_settle: r2(afterAmt), bank_settled: bankSettled, variance: neededAdj, sheet_after: tiedTo, bank_txns_synced: newTx, bank_posted_through: bankThrough, new_payouts: newPayouts, unbooked_recent: unbooked, dry };
    if (!dry) await sbPost(`reconcile_reports`, [{ settle_day: settleDay, summary, detail }], "return=minimal");
    return json({ ok: true, summary, detail });
  } catch (e) { return json({ error: String(e) }, 500); }
});
