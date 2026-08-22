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

    // ---- create a test subscription (admin only, deliberate) ----
    // Bills like a real rental does: a daily recurring price, collected by
    // invoice rather than auto-charge, so the whole pay-now path can be walked.
    if (body.action === "create_test_subscription") {
      const label = String(body.account_label || "RENT 2 GO LLC 2.0");
      const acct = ACCTS.find((a: any) => a.label === label);
      if (!acct || !acct.key) return json({ error: "no Stripe key for " + label }, 400);
      const key = acct.key;
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const vehicleId = String(body.vehicle_id || "");
      const amount = Math.round(Number(body.daily_amount || 1) * 100);
      if (!email || !vehicleId) return json({ error: "email and vehicle_id are required" }, 400);

      const veh = (await sbGet(`vehicles?id=eq.${enc(vehicleId)}&select=id,name,make,model,year,color`))[0];
      if (!veh) return json({ error: "no such vehicle" }, 404);
      const productName = [[veh.make, veh.model].filter(Boolean).join(" "), veh.year, veh.color]
        .filter(Boolean).join(" - ").toUpperCase() || String(veh.name || "TEST VEHICLE").toUpperCase();

      const form = (o: Record<string, string>) => new URLSearchParams(o);
      const post = async (url: string, f: URLSearchParams) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: f,
        });
        return await r.json();
      };

      // customer — reuse if they already exist in this account
      const found = await (await fetch(
        `https://api.stripe.com/v1/customers?email=${enc(email)}&limit=1`,
        { headers: { Authorization: `Bearer ${key}` } })).json();
      let customer = (found.data && found.data[0]) || null;
      if (!customer) {
        customer = await post("https://api.stripe.com/v1/customers",
          form({ email, name, phone, "metadata[r2g_test]": "true" }));
        if (customer.error) return json({ error: "customer: " + customer.error.message }, 400);
      }

      // product + a daily price
      const product = await post("https://api.stripe.com/v1/products",
        form({ name: productName, "metadata[r2g_vehicle_id]": vehicleId, "metadata[r2g_test]": "true" }));
      if (product.error) return json({ error: "product: " + product.error.message }, 400);
      const price = await post("https://api.stripe.com/v1/prices", form({
        product: product.id, currency: "usd", unit_amount: String(amount),
        "recurring[interval]": "day",
      }));
      if (price.error) return json({ error: "price: " + price.error.message }, 400);

      // the subscription — invoiced daily, never auto-charged
      const sub = await post("https://api.stripe.com/v1/subscriptions", form({
        customer: customer.id, "items[0][price]": price.id,
        collection_method: "send_invoice", days_until_due: "1",
        "metadata[r2g_vehicle_id]": vehicleId,
        "metadata[r2g_renter_email]": email,
        "metadata[r2g_test]": "true",
      }));
      if (sub.error) return json({ error: "subscription: " + sub.error.message }, 400);

      // teach the map about it, so the sync claims the car straight away
      await sbUpsert("stripe_product_map", [{
        account_label: label, product_id: product.id, product_name: productName,
        vehicle_id: vehicleId, confidence: "confirmed", note: "test subscription",
      }], "account_label,product_id");

      return json({
        ok: true, account_label: label, customer_id: customer.id,
        product_id: product.id, product_name: productName, price_id: price.id,
        subscription_id: sub.id, status: sub.status,
        daily_amount: amount / 100,
        cancel_hint: "cancel it in Stripe, or call this function with action=cancel_test_subscription",
      });
    }

    // ---- push the first invoice out now ----
    // A send_invoice subscription leaves its first invoice as a draft for up to
    // an hour. For a test we want something payable immediately.
    if (body.action === "finalize_invoices") {
      const label = String(body.account_label || "RENT 2 GO LLC 2.0");
      const acct = ACCTS.find((a: any) => a.label === label);
      if (!acct || !acct.key) return json({ error: "no Stripe key for " + label }, 400);
      const cust = String(body.customer_id || "");
      if (!cust) return json({ error: "customer_id required" }, 400);
      const list = await (await fetch(
        `https://api.stripe.com/v1/invoices?customer=${enc(cust)}&limit=20`,
        { headers: { Authorization: `Bearer ${acct.key}` } })).json();
      const out: any[] = [];
      for (const inv of (list.data || [])) {
        if (inv.status !== "draft") { out.push({ id: inv.id, status: inv.status, hosted: inv.hosted_invoice_url }); continue; }
        const fin = await (await fetch(`https://api.stripe.com/v1/invoices/${inv.id}/finalize`, {
          method: "POST", headers: { Authorization: `Bearer ${acct.key}` },
        })).json();
        if (fin.error) { out.push({ id: inv.id, error: fin.error.message }); continue; }
        await fetch(`https://api.stripe.com/v1/invoices/${inv.id}/send`, {
          method: "POST", headers: { Authorization: `Bearer ${acct.key}` },
        }).catch(() => {});
        out.push({ id: fin.id, number: fin.number, status: fin.status,
                   amount_due: (fin.amount_due || 0) / 100, hosted: fin.hosted_invoice_url });
      }
      return json({ ok: true, invoices: out });
    }

    /* ---- register the webhook endpoints ----
       Each Stripe account needs its own endpoint and issues its own signing
       secret. The keys live in this function's secrets and cannot be read back
       out of Supabase, so the registration has to happen from in here. Returns
       the secrets so they can be stored for stripe-webhook to verify against.
       Idempotent: an account that already points at this URL is left alone and
       its existing secret reported, because Stripe only reveals a signing secret
       when the endpoint is created. */
    if (body.action === "create_webhooks") {
      const url = String(body.url || `${SB.replace(".supabase.co", ".functions.supabase.co")}/stripe-webhook`);
      const events = [
        "invoice.created", "invoice.finalized", "invoice.updated", "invoice.paid",
        "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible",
        "customer.subscription.created", "customer.subscription.updated",
        "customer.subscription.deleted",
      ];
      const only = body.account_label ? String(body.account_label) : null;
      const out: any[] = [];
      for (const a of ACCTS) {
        if (!a.key) continue;
        if (only && a.label !== only) continue;
        try {
          const have = await (await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", {
            headers: { Authorization: `Bearer ${a.key}` },
          })).json();
          const dup = (have.data || []).find((w: any) => w.url === url && w.status !== "disabled");
          if (dup) { out.push({ label: a.label, id: dup.id, existing: true, secret: dup.secret || null }); continue; }
          const form = new URLSearchParams();
          form.set("url", url);
          form.set("description", "Rent 2 Go - keep the app level with Stripe");
          events.forEach((e, i) => form.set(`enabled_events[${i}]`, e));
          const r = await (await fetch("https://api.stripe.com/v1/webhook_endpoints", {
            method: "POST",
            headers: { Authorization: `Bearer ${a.key}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          })).json();
          if (r.error) { out.push({ label: a.label, error: r.error.message }); continue; }
          out.push({ label: a.label, id: r.id, created: true, secret: r.secret });
        } catch (e) { out.push({ label: a.label, error: String(e).slice(0, 140) }); }
      }
      return json({ ok: true, url, events, results: out,
                    secrets: Object.fromEntries(out.filter((o) => o.secret).map((o) => [o.label, o.secret])) });
    }

    // ---- cancel it again ----
    if (body.action === "cancel_test_subscription") {
      const label = String(body.account_label || "RENT 2 GO LLC 2.0");
      const acct = ACCTS.find((a: any) => a.label === label);
      if (!acct || !acct.key) return json({ error: "no Stripe key for " + label }, 400);
      const id = String(body.subscription_id || "");
      if (!id) return json({ error: "subscription_id required" }, 400);
      const r = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${acct.key}` },
      });
      const j = await r.json();
      if (j.error) return json({ error: j.error.message }, 400);
      return json({ ok: true, subscription_id: id, status: j.status });
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

    // A full sweep of 14 accounts plus 90 days of invoices exceeds the 150s edge
    // function limit. Callers run it one account at a time, and can skip invoices
    // for a fast subscriptions-only pass - that is what moves the cars.
    const only = body.account_label ? String(body.account_label) : null;
    const skipInvoices = body.skip_invoices === true;
    for (const a of ACCTS) {
      if (!a.key) continue;
      if (only && a.label !== only) continue;
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
        if (skipInvoices) { accountsDone++; continue; }
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
            invoice_pdf: i.invoice_pdf || null,
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
    // Releasing a car has to be judged against EVERY live subscription in the
    // mirror, not just the ones this pass happened to read. A single-account run
    // otherwise frees a car that is live on a different fleet - which put six
    // rented cars back on the market the first time this ran per account.
    const allLive = await sbGet(
      "renter_subscriptions?select=account_label,product_id&status=in.(active,past_due,unpaid,trialing)&limit=1000");
    const mapRows2 = await sbGet(
      "stripe_product_map?select=account_label,product_id,vehicle_id,confidence&limit=1000");
    const carOf2: Record<string, string> = {};
    for (const m of mapRows2) {
      if (m.vehicle_id && (m.confidence === "auto" || m.confidence === "confirmed")) {
        carOf2[m.account_label + "|" + m.product_id] = m.vehicle_id;
      }
    }
    const rentedAnywhere = new Set<string>();
    for (const s of allLive) {
      const v = carOf2[s.account_label + "|" + s.product_id];
      if (v) rentedAnywhere.add(v);
    }
    for (const v of shouldBeRented) rentedAnywhere.add(v);

    // one release per CAR, not per cancelled subscription
    const seenEnded = new Set<string>();
    const ended = subsOut.filter((s) => {
      if (LIVE.includes(s.status) || !s.vehicle_id) return false;
      if (rentedAnywhere.has(s.vehicle_id)) return false;
      if (seenEnded.has(s.vehicle_id)) return false;
      seenEnded.add(s.vehicle_id);
      return true;
    });
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
      ok: true, accounts: accountsDone, account_errors: accountErrors, swept: only || "all", invoices_skipped: skipInvoices,
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
