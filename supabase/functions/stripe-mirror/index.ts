// stripe-mirror — makes Stripe the source of truth for who is renting what.
//
// Stripe already knows: an active subscription is a live rental, a cancelled one
// has ended. The website was tracking that separately and drifting. This sweeps
// every fleet account and mirrors subscriptions and invoices into Supabase, then
// moves the car to match.
//
// The car comes from stripe_product_map, which is resolved ONCE per product and
// then trusted. We deliberately do not string-match product names during a sync:
// colours disagree between the two systems and two subscriptions can otherwise
// land on the same vehicle. An unmapped product is reported, never guessed.
//
// Auth: verify_jwt = true (service_role, or an admin email).
// Secrets: LINDA_ACCOUNTS (+ LINDA_ACCOUNTS_EXTRA), SUPABASE_SERVICE_ROLE_KEY.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = (() => {
  const b = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]");
  let e: any[] = []; try { e = JSON.parse(Deno.env.get("LINDA_ACCOUNTS_EXTRA") || "[]"); } catch (_) { /* */ }
  const m: Record<string, any> = {};
  for (const a of [...b, ...e]) if (a && a.label && a.key) m[a.label] = a;
  return Object.values(m) as any[];
})();
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const LIVE = ["active", "past_due", "unpaid", "trialing"];
const enc = encodeURIComponent;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => []) : [];
}
async function sbUpsert(table: string, rows: unknown[], onConflict: string) {
  if (!Array.isArray(rows) || !rows.length) return;
  const r = await fetch(`${SB}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json",
               Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error("upsert " + table, r.status, (await r.text().catch(() => "")).slice(0, 300));
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error("patch " + path, r.status, (await r.text().catch(() => "")).slice(0, 200));
}
const LOG: any[] = [];
function note(kind: string, detail: string, extra: Record<string, unknown> = {}) {
  LOG.push({ kind, detail, ...extra });
}

async function stripeAll(url: string, key: string) {
  const out: any[] = []; let after = "";
  for (let i = 0; i < 25; i++) {
    const r = await fetch(url + (after ? `&starting_after=${after}` : ""), { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const d = j.data || [];
    out.push(...d);
    if (!j.has_more || !d.length) break;
    after = d[d.length - 1].id;
  }
  return out;
}
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
const money = (c: number | null | undefined) => Math.round((c || 0)) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) {
    try {
      const p = JSON.parse(atob(tok.split(".")[1]));
      if (p.role === "service_role") ok = true;
      else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true;
    } catch (_) { /* */ }
  }
  if (!ok) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({} as any));
  const dryRun = body.dry_run === true;

  try {
    // ---- rename Stripe products to the house naming protocol ----
    // MAKE MODEL - YEAR - COLOUR, capitals. The product name is what a renter
    // reads on every invoice, so it has to match what the fleet calls the car.
    if (body.action === "rename_products") {
      const veh = await sbGet("vehicles?select=id,make,model,year,color&limit=500");
      const vById: Record<string, any> = {};
      for (const v of veh) vById[v.id] = v;
      const maps = await sbGet("stripe_product_map?select=account_label,product_id,product_name,vehicle_id,confidence&limit=500");
      const out: any[] = [];
      for (const a of ACCTS) {
        if (!a.key) continue;
        for (const m of maps) {
          if (m.account_label !== a.label || !m.vehicle_id) continue;
          if (m.confidence !== "auto" && m.confidence !== "confirmed") continue;
          const v = vById[m.vehicle_id];
          if (!v || !v.make || !v.model) continue;
          const want = [ [v.make, v.model].filter(Boolean).join(" "), v.year, v.color ]
            .filter(Boolean).join(" - ").toUpperCase();
          if (!want || want === (m.product_name || "").toUpperCase()) continue;
          out.push({ account_label: a.label, product_id: m.product_id, from: m.product_name, to: want });
          if (!body.dry_run) {
            const f = new URLSearchParams(); f.set("name", want);
            const r = await fetch(`https://api.stripe.com/v1/products/${m.product_id}`, {
              method: "POST",
              headers: { Authorization: `Bearer ${a.key}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: f,
            });
            const j = await r.json();
            if (j.error) { out[out.length - 1].error = j.error.message; continue; }
            await sbPatch(`stripe_product_map?account_label=eq.${enc(a.label)}&product_id=eq.${enc(m.product_id)}`,
                          { product_name: want });
          }
        }
      }
      return json({ ok: true, dry_run: !!body.dry_run, renamed: out.length, changes: out });
    }

    // ---- who we already know ----
    const renters = await sbGet("renters?select=id,email,name,auth_uid,current_vehicle_id&limit=1000");
    const byEmail: Record<string, any> = {};
    for (const r of renters) if (r.email) byEmail[String(r.email).trim().toLowerCase()] = r;

    const mapRows = await sbGet("stripe_product_map?select=account_label,product_id,vehicle_id,confidence&limit=2000");
    const carFor: Record<string, string | null> = {};
    for (const m of mapRows) {
      // only a resolved product may move a vehicle
      carFor[m.account_label + "|" + m.product_id] = (m.confidence === "auto" || m.confidence === "confirmed") ? m.vehicle_id : null;
    }

    const subsOut: any[] = [], invOut: any[] = [], newProducts: any[] = [];
    const seenProduct = new Set(mapRows.map((m: any) => m.account_label + "|" + m.product_id));
    const productNames: Record<string, string> = {};
    let accountsDone = 0, accountErrors: any[] = [];

    for (const a of ACCTS) {
      if (!a.key) continue;
      try {
        const subs = await stripeAll("https://api.stripe.com/v1/subscriptions?status=all&limit=100&expand[]=data.customer", a.key);

        // resolve product names once per account
        const pids = Array.from(new Set(subs.map((s: any) => (s.items?.data || [])[0]?.price?.product).filter(Boolean)));
        for (const pid of pids) {
          const k = a.label + "|" + pid;
          if (productNames[k]) continue;
          try {
            const pr = await fetch(`https://api.stripe.com/v1/products/${pid}`, { headers: { Authorization: `Bearer ${a.key}` } });
            const pj = await pr.json();
            productNames[k] = pj?.name || "";
          } catch (_) { productNames[k] = ""; }
          if (!seenProduct.has(k)) {
            seenProduct.add(k);
            newProducts.push({ account_label: a.label, product_id: pid, product_name: productNames[k], confidence: "unmatched" });
          }
        }

        for (const s of subs) {
          const c = (typeof s.customer === "object" ? s.customer : {}) || {};
          const email = String(c.email || "").trim().toLowerCase();
          const it = (s.items?.data || [])[0] || {};
          const pid = it.price?.product || null;
          const renter = email ? byEmail[email] : null;
          subsOut.push({
            id: s.id, account_label: a.label,
            customer_id: c.id || (typeof s.customer === "string" ? s.customer : null),
            customer_email: c.email || null, customer_name: c.name || null,
            status: s.status, product_id: pid, product_name: pid ? (productNames[a.label + "|" + pid] || null) : null,
            daily_amount: it.price ? money(it.price.unit_amount) : null,
            current_period_end: iso(s.current_period_end), started_at: iso(s.start_date),
            canceled_at: iso(s.canceled_at),
            renter_id: renter ? renter.id : null,
            vehicle_id: pid ? (carFor[a.label + "|" + pid] || null) : null,
            updated_at: new Date().toISOString(),
          });
          if (LIVE.includes(s.status) && !renter && email) note("needs_review", `active subscription for ${email} has no website account yet`, { account_label: a.label, subscription_id: s.id });
          if (LIVE.includes(s.status) && pid && !carFor[a.label + "|" + pid]) note("needs_review", `product "${productNames[a.label + "|" + pid] || pid}" is not mapped to a car`, { account_label: a.label, subscription_id: s.id });
        }

        // invoices — last 90 days is plenty for a daily-billing dashboard
        const since = Math.floor(Date.now() / 1000) - 90 * 86400;
        const invs = await stripeAll(`https://api.stripe.com/v1/invoices?limit=100&created[gte]=${since}`, a.key);
        for (const i of invs) {
          const email = String(i.customer_email || "").trim().toLowerCase();
          const renter = email ? byEmail[email] : null;
          invOut.push({
            id: i.id, account_label: a.label, customer_id: i.customer || null,
            subscription_id: i.subscription || null, renter_id: renter ? renter.id : null,
            number: i.number || null,
            description: (i.lines?.data || [])[0]?.description || i.description || null,
            amount_due: money(i.amount_due), amount_paid: money(i.amount_paid),
            status: i.status, is_late_fee: (i.amount_due || 0) === 1000,
            due_date: i.due_date ? new Date(i.due_date * 1000).toISOString().slice(0, 10) : null,
            issued_at: iso(i.created), paid_at: iso(i.status_transitions?.paid_at),
            hosted_invoice_url: i.hosted_invoice_url || null,
            updated_at: new Date().toISOString(),
          });
        }
        accountsDone++;
      } catch (e) {
        accountErrors.push({ label: a.label, error: String(e).slice(0, 160) });
        note("error", `${a.label}: ${String(e).slice(0, 140)}`, { account_label: a.label });
      }
    }

    if (dryRun) {
      return json({ ok: true, dry_run: true, accounts: accountsDone, account_errors: accountErrors,
        subscriptions: subsOut.length, live: subsOut.filter((s) => LIVE.includes(s.status)).length,
        invoices: invOut.length, new_products: newProducts.length, log: LOG.slice(0, 60) });
    }

    // ---- write the mirror ----
    if (newProducts.length) await sbUpsert("stripe_product_map", newProducts, "account_label,product_id");
    for (let i = 0; i < subsOut.length; i += 200) await sbUpsert("renter_subscriptions", subsOut.slice(i, i + 200), "id");
    for (let i = 0; i < invOut.length; i += 200) await sbUpsert("renter_invoices", invOut.slice(i, i + 200), "id");

    // ---- move the cars to match Stripe ----
    // Only where BOTH the renter and the car are known. Anything else is reported,
    // never guessed at — a wrong link takes a real car out of the catalogue.
    const liveSubs = subsOut.filter((s) => LIVE.includes(s.status) && s.renter_id && s.vehicle_id);
    const shouldBeRented = new Set(liveSubs.map((s) => s.vehicle_id));

    for (const s of liveSubs) {
      const r = renters.find((x: any) => x.id === s.renter_id);
      if (r && r.current_vehicle_id !== s.vehicle_id) {
        await sbPatch(`renters?id=eq.${enc(s.renter_id)}`, { current_vehicle_id: s.vehicle_id });
        note("linked", `${r.name || r.email} -> ${s.product_name || s.vehicle_id}`, { account_label: s.account_label, subscription_id: s.id, renter_id: s.renter_id, vehicle_id: s.vehicle_id });
      }
      await sbPatch(`vehicles?id=eq.${enc(s.vehicle_id)}&available=is.true`, { available: false });
    }

    // a subscription that has ended releases its car and clears the renter's link
    const ended = subsOut.filter((s) => !LIVE.includes(s.status) && s.vehicle_id && !shouldBeRented.has(s.vehicle_id));
    for (const s of ended) {
      await sbPatch(`vehicles?id=eq.${enc(s.vehicle_id)}&available=is.false`, { available: true });
      if (s.renter_id) {
        await sbPatch(`renters?id=eq.${enc(s.renter_id)}&current_vehicle_id=eq.${enc(s.vehicle_id)}`, { current_vehicle_id: null });
      }
      note("ended", `${s.customer_name || s.customer_email || s.id} ended — ${s.product_name || s.vehicle_id} released`, { account_label: s.account_label, subscription_id: s.id, renter_id: s.renter_id, vehicle_id: s.vehicle_id });
    }

    if (LOG.length) {
      await fetch(`${SB}/rest/v1/stripe_sync_log`, {
        method: "POST",
        headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(LOG.slice(0, 500)),
      }).catch(() => {});
    }

    return json({
      ok: true, accounts: accountsDone, account_errors: accountErrors,
      subscriptions: subsOut.length, live_subscriptions: subsOut.filter((s) => LIVE.includes(s.status)).length,
      invoices: invOut.length, new_products_found: newProducts.length,
      cars_linked: LOG.filter((l) => l.kind === "linked").length,
      cars_released: LOG.filter((l) => l.kind === "ended").length,
      needs_review: LOG.filter((l) => l.kind === "needs_review").length,
      log: LOG.slice(0, 80),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
