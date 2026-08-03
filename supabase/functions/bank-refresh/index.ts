// bank-refresh — pulls the connected bank account(s) balance + transactions from Stripe Financial
// Connections into bank_accounts / bank_transactions. Runs on the RENT 2 GO - 1.0 key. Cron daily.
// verify_jwt=true. Balances are usually available immediately; transactions need the Transactions
// feature approved — if it's not yet active, we still refresh balances and skip transactions cleanly.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const LABEL = "RENT 2 GO - 1.0";
const HOLDER_EMAIL = "bank-reconciliation@rent2go.internal";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } }); }
function keyFor(label: string) { const a = ACCTS.find((x: any) => x.label === label); return a ? a.key : null; }
function ymd(e: number) { return new Date(e * 1000).toISOString().slice(0, 10); }
async function sGET(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "bank-refresh" } }); return await r.json(); }
async function sPOST(url: string, key: string, form: URLSearchParams) { const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bank-refresh" }, body: form }); return await r.json(); }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function stripeAll(base: string, key: string) { let out: any[] = [], sa: string | null = null; while (true) { const d = await sGET(base + (sa ? `&starting_after=${sa}` : ""), key); const rows = d.data || []; out = out.concat(rows); if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break; } return out; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return json({ error: "unauthorized" }, 401);
  try {
    const key = keyFor(LABEL);
    if (!key) return json({ error: "no Stripe key for " + LABEL });
    const cust = (await sGET(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(HOLDER_EMAIL)}&limit=1`, key)).data?.[0];
    if (!cust) return json({ ok: true, accounts: 0, note: "no bank connected yet — use Connect bank first" });
    const accounts = await stripeAll(`https://api.stripe.com/v1/financial_connections/accounts?account_holder%5Bcustomer%5D=${cust.id}&limit=100`, key);
    const out: any[] = [];
    for (const a of accounts) {
      // refresh + read balance
      await sPOST(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}/refresh`, key, new URLSearchParams([["features[]", "balance"]])).catch(() => ({}));
      const acct = await sGET(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}`, key);
      const cur = acct.balance?.current || {};
      const ccy = Object.keys(cur)[0] || "usd";
      const balAmt = cur[ccy] != null ? cur[ccy] / 100 : null;
      await sbPost(`bank_accounts?on_conflict=id`, [{
        id: acct.id, account_label: LABEL, institution: acct.institution_name || null, display_name: acct.display_name || null,
        last4: acct.last4 || null, category: acct.category || null, subcategory: acct.subcategory || null, status: acct.status || null,
        balance_current: balAmt, balance_currency: ccy, balance_as_of: acct.balance?.as_of ? new Date(acct.balance.as_of * 1000).toISOString() : null, updated_at: new Date().toISOString(),
      }], "resolution=merge-duplicates,return=minimal");
      // transactions (best-effort — needs the Transactions feature active)
      let txCount = 0, txNote = "";
      try {
        await sPOST(`https://api.stripe.com/v1/financial_connections/accounts/${a.id}/subscribe`, key, new URLSearchParams([["features[]", "transactions"]]));
        const txns = await stripeAll(`https://api.stripe.com/v1/financial_connections/transactions?account=${a.id}&limit=100`, key);
        for (const t of txns) {
          await sbPost(`bank_transactions?on_conflict=id`, [{ id: t.id, account_id: a.id, amount: (t.amount || 0) / 100, currency: t.currency || ccy, status: t.status || null, description: t.description || null, transacted_at: t.transacted_at ? ymd(t.transacted_at) : null, posted_at: t.status_transitions?.posted_at ? ymd(t.status_transitions.posted_at) : null, updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal");
          txCount++;
        }
      } catch (e) { txNote = "transactions unavailable (feature pending?)"; }
      out.push({ id: acct.id, bank: acct.institution_name, last4: acct.last4, balance: balAmt, currency: ccy, transactions: txCount, note: txNote });
    }
    return json({ ok: true, accounts: accounts.length, detail: out });
  } catch (e) { return json({ error: String(e) }, 500); }
});
