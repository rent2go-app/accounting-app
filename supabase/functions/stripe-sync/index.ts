// Nightly Stripe income sync — pulls gross/fee/net balance transactions from
// each configured account for a given day and upserts into stripe_income.
// Config: env STRIPE_ACCOUNTS = JSON [{"label":"mbali","key":"rk_live_..."}, ...]
//         env SYNC_TOKEN      = shared secret; caller must send header x-sync-token.
// verify_jwt = false (guarded by SYNC_TOKEN). Service role writes; RLS bypassed.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-sync-token, apikey, x-client-info",
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
function yesterdayUTC() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = req.headers.get("x-sync-token") || "";
    if (!token || token !== (Deno.env.get("SYNC_TOKEN") || "__unset__")) return json({ error: "unauthorized" }, 401);

    let accounts: Array<{ label: string; key: string }> = [];
    try { accounts = JSON.parse(Deno.env.get("STRIPE_ACCOUNTS") || "[]"); } catch (_) { return json({ error: "STRIPE_ACCOUNTS is not valid JSON" }, 500); }

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_) { /* no body */ }
    const day = (body.day as string) || yesterdayUTC();
    const start = Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
    const end = start + 86400;

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const results: unknown[] = [];

    for (const a of accounts) {
      if (!a || !a.key || !a.label) { results.push({ label: a?.label || "?", error: "missing key/label" }); continue; }
      let gross = 0, fee = 0, net = 0, txns = 0, startingAfter: string | null = null, more = true, guard = 0, err: string | undefined;
      while (more && guard++ < 25) {
        const url = new URL("https://api.stripe.com/v1/balance_transactions");
        url.searchParams.set("limit", "100");
        url.searchParams.set("created[gte]", String(start));
        url.searchParams.set("created[lt]", String(end));
        if (startingAfter) url.searchParams.set("starting_after", startingAfter);
        const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + a.key } });
        if (!r.ok) { err = "stripe HTTP " + r.status; more = false; break; }
        const d = await r.json();
        const rows = d.data || [];
        for (const t of rows) {
          if (t.type === "charge" || t.type === "payment") { gross += (t.amount || 0); fee += (t.fee || 0); net += (t.net || 0); txns++; }
        }
        more = !!d.has_more && rows.length > 0;
        if (more) startingAfter = rows[rows.length - 1].id;
      }
      if (err) { results.push({ label: a.label, error: err }); continue; }
      const row = { day, label: a.label, gross: gross / 100, fee: fee / 100, net: net / 100, txns, updated_at: new Date().toISOString() };
      const up = await sb.from("stripe_income").upsert(row, { onConflict: "day,label" });
      results.push({ label: a.label, gross: row.gross, fee: row.fee, net: row.net, txns, error: up.error ? up.error.message : undefined });
    }
    return json({ ok: true, day, accounts: accounts.length, results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
