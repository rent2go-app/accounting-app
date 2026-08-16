// bank-refresh — pulls connected bank balances (and, when asked, transactions) from Stripe Financial
// Connections into bank_accounts / bank_transactions. Runs on the RENT 2 GO - 1.0 key.
//   default {}                 → BALANCE ONLY, polled until fresh (fast — used by the button + connect)
//   {sync_transactions:true}   → also pull transactions (slower — used by the daily cron)
// verify_jwt=true.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS=(()=>{const _b=JSON.parse(Deno.env.get("LINDA_ACCOUNTS")||"[]");let _e=[];try{_e=JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA")||"[]");}catch(_){}const _m={};for(const a of [..._b,..._e]){if(a&&a.label&&a.key)_m[a.label]=a;}return Object.values(_m);})(); // LINDA_ACCOUNTS + additive EXTRA
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const LABEL = "RENT 2 GO - 1.0";
const HOLDER_EMAIL = "bank-reconciliation@rent2go.internal";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
function ymd(e: number) { return new Date(e * 1000).toISOString().slice(0, 10); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "bank-refresh" } }); return await r.json(); }
async function sPOST(url: string, key: string, form: URLSearchParams) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bank-refresh" }, body: form }); return await r.json(); }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function sbGetJson(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbReq(path: string, method: string, body?: unknown) { await fetch(`${SB}/rest/v1/${path}`, { method, headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: body ? JSON.stringify(body) : undefined }); }
// SELF-HEAL: reconnecting the bank mints NEW ids for the same real account + transactions, so the FC list
// can hold duplicates. The dedupe_bank() DB function keeps one row per last4 (active/newest), moves
// transactions onto it, drops stale account rows, and removes duplicate transactions by natural key —
// so a reconnect updates in place instead of inflating balances/transactions.
async function dedupeAccounts() { await sbReq(`rpc/dedupe_bank`, "POST", {}); }
async function stripeAll(base: string, key: string, cap = 2000) { let out: any[] = [], sa: string | null = null; while (out.length < cap) { const d = await sGET(base + (sa ? `&starting_after=${sa}` : ""), key); const rows = d.data || []; out = out.concat(rows); if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break; } return out; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const bodyIn = await req.json().catch(() => ({} as any));
    const doTx = !!bodyIn.sync_transactions;
    const doRefresh = !!bodyIn.refresh;                                   // trigger a fresh pull from the bank (button)
    const sinceUnix = bodyIn.days ? Math.floor(Date.now() / 1000) - Number(bodyIn.days) * 86400 : 0;  // only list recent txns (fast)
    const key = keyFor(LABEL);
    if (!key) return json({ error: "no Stripe key for " + LABEL });
    const cust = (await sGET(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(HOLDER_EMAIL)}&limit=1`, key)).data?.[0];
    if (!cust) return json({ ok: true, accounts: 0, note: "no bank connected yet" });
    const accounts = await stripeAll(`https://api.stripe.com/v1/financial_connections/accounts?account_holder%5Bcustomer%5D=${cust.id}&limit=100`, key);
    let latestTx = "";
    // Refresh every account in PARALLEL (was sequential ≈ 3× slower). One refresh call kicks BOTH balance
    // and (when asked) transactions; we poll once for both to go "succeeded", then read balance + list txns.
    const out = await Promise.all(accounts.map(async (a: any) => {
      const feats = ["balance"]; if (doTx && doRefresh) feats.push("transactions");
      if (doTx && !(a.subscriptions || []).includes("transactions")) await sPOST(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}/subscribe`, key, new URLSearchParams([["features[]", "transactions"]])).catch(() => ({}));
      await sPOST(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}/refresh`, key, new URLSearchParams(feats.map((f) => ["features[]", f]))).catch(() => ({}));
      let acct = a;
      for (let i = 0; i < 8; i++) {
        acct = await sGET(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}`, key);
        const balOk = acct.balance_refresh?.status === "succeeded" && (acct.balance?.cash?.available || acct.balance?.current);
        const txOk = !feats.includes("transactions") || acct.transaction_refresh?.status === "succeeded" || acct.transaction_refresh?.status === "failed";
        if (balOk && txOk) break;
        await sleep(1500);
      }
      // Use the AVAILABLE balance (balance.cash.available) — what the bank shows as "Available balance";
      // `current` is a ledger figure that can include uncleared items. Fall back to current.
      const cashAv = acct.balance?.cash?.available || {};
      const cur = acct.balance?.current || {};
      const ccy = Object.keys(cashAv)[0] || Object.keys(cur)[0] || "usd";
      const raw = cashAv[ccy] != null ? cashAv[ccy] : cur[ccy];
      const balAmt = raw != null ? raw / 100 : null;
      await sbPost(`bank_accounts?on_conflict=id`, [{
        id: acct.id, account_label: LABEL, institution: acct.institution_name || null, display_name: acct.display_name || null,
        last4: acct.last4 || null, category: acct.category || null, subcategory: acct.subcategory || null, status: acct.status || null,
        balance_current: balAmt, balance_currency: ccy, balance_as_of: acct.balance?.as_of ? new Date(acct.balance.as_of * 1000).toISOString() : null, updated_at: new Date().toISOString(),
      }], "resolution=merge-duplicates,return=minimal");
      let txCount = 0;
      if (doTx) {
        try {
          const sinceQ = sinceUnix ? `&transacted_at%5Bgte%5D=${sinceUnix}` : "";   // window to recent txns → fast
          const txns = await stripeAll(`https://api.stripe.com/v1/financial_connections/transactions?account=${a.id}&limit=100${sinceQ}`, key, sinceUnix ? 600 : 2000);
          for (const t of txns) {
            const td = t.transacted_at ? ymd(t.transacted_at) : (t.status_transitions?.posted_at ? ymd(t.status_transitions.posted_at) : null);
            if (td && td > latestTx) latestTx = td;
            await sbPost(`bank_transactions?on_conflict=id`, [{ id: t.id, account_id: a.id, amount: (t.amount || 0) / 100, currency: t.currency || ccy, status: t.status || null, description: t.description || null, transacted_at: t.transacted_at ? ymd(t.transacted_at) : null, posted_at: t.status_transitions?.posted_at ? ymd(t.status_transitions.posted_at) : null, updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal"); txCount++;
          }
        } catch (_) { /* transactions feature may be pending */ }
      }
      return { id: acct.id, bank: acct.institution_name, last4: acct.last4, balance: balAmt, type: acct.balance?.type, as_of: acct.balance?.as_of, fresh: acct.balance_refresh?.status, tx_fresh: acct.transaction_refresh?.status, transactions: txCount };
    }));
    await dedupeAccounts();   // collapse any duplicate rows a reconnect created (keep active/newest per last4)
    return json({ ok: true, accounts: accounts.length, synced_transactions: doTx, latest_txn: latestTx || null, total_transactions: out.reduce((s: number, x: any) => s + (x.transactions || 0), 0), detail: out });
  } catch (e) { return json({ error: String(e) }, 500); }
});
