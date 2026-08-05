// create-payouts — sweep the available balance of the Rent 2 Go (1.0) and Rent 2 Go 2.0 Stripe
// accounts to the bank as INSTANT payouts, then import them into the ledger. Runs on the 8x/day cron.
//
// REAL MONEY: creates instant payouts (Stripe charges ~1% per payout). Safety:
//  - only sweeps the INSTANT-available balance (what Stripe deems eligible for instant payout);
//  - an Idempotency-Key per account+currency+hour prevents a retry from double-paying the same balance;
//  - {dry_run:true} reports balances and intended amounts WITHOUT moving any money.
// verify_jwt=true (service_role cron / admin). After creating, it invokes import-payouts to load the ledger.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]"); // [{label,key,portal}]
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const WANT: Record<string, string> = { "RENT 2 GO - 1.0": "Rent 2 Go 1.0", "RENT 2 GO LLC 2.0": "Rent 2 Go 2.0" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
async function sGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "create-payouts" } }); return await r.json(); }
async function sPOST(url: string, key: string, form: URLSearchParams, idem: string) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idem, "User-Agent": "create-payouts" }, body: form });
  return { ok: r.ok, d: await r.json().catch(() => ({})) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const body = await req.json().catch(() => ({} as any));
    const dry = !!body.dry_run;
    const minCents = Math.round((Number(body.min) || 0) * 100);   // optional: skip balances below this $ amount
    const hourBucket = Math.floor(Date.now() / 3600000);           // idempotency window (1h)
    const out: any[] = [];
    for (const a of ACCTS) {
      const short = WANT[a.label];
      if (!short || !a.key) continue;
      const bal = await sGET("https://api.stripe.com/v1/balance", a.key);
      const inst = (bal.instant_available && bal.instant_available.length) ? bal.instant_available : [];
      if (!inst.length) { out.push({ account: short, note: "no instant-available balance", available: (bal.available || []).map((x: any) => x.amount / 100) }); continue; }
      for (const b of inst) {
        const amount = b.amount as number, currency = b.currency as string;
        if (amount <= 0) { out.push({ account: short, currency, skipped: "zero balance" }); continue; }
        if (minCents && amount < minCents) { out.push({ account: short, currency, skipped: "below min", amount: amount / 100 }); continue; }
        if (dry) { out.push({ account: short, currency, would_pay: amount / 100 }); continue; }
        const form = new URLSearchParams({ amount: String(amount), currency, method: "instant" });
        // Idempotency key MUST include the amount: a time-only key gets locked to the first amount for 24h,
        // so when new funds accumulate (a different amount) in the same window Stripe rejects the payout and
        // the balance never sweeps. amount+hour → same-amount retries dedupe, new amounts always pay out.
        const idem = `ip_${a.label}_${currency}_${amount}_${hourBucket}`;
        const r = await sPOST("https://api.stripe.com/v1/payouts", a.key, form, idem);
        if (r.ok && !r.d.error) out.push({ account: short, currency, paid: amount / 100, id: r.d.id, status: r.d.status });
        else out.push({ account: short, currency, amount: amount / 100, error: (r.d.error && r.d.error.message) || `HTTP ${r.ok}` });
      }
    }
    // Pull the freshly-created payouts into the ledger (unless dry run).
    let imported: any = null;
    if (!dry) { try { const ir = await fetch(`${SB}/functions/v1/import-payouts`, { method: "POST", headers: { Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: "{}" }); imported = await ir.json(); } catch (e) { imported = { error: String(e) }; } }
    return json({ ok: true, dry, hourBucket, out, imported });
  } catch (e) { return json({ error: String(e) }, 500); }
});
