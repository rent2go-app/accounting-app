// create-checkout — turns a renter + a car into a real Stripe payment.
//
// Money is collected in "RENT 2 GO" (acct_1Sc2y0…) via STRIPE_CHECKOUT_KEY.
// Identity verification runs in a DIFFERENT account (Rent 2 Go LLC) — do not
// mix the two keys up.
//
// Auth: verify_jwt = true. The caller must be the signed-in renter; we resolve
// their row from auth.uid() rather than trusting anything in the body, so
// nobody can book as someone else or invent their own deposit.
//
// The renter must be BOTH Stripe-verified AND admin-approved before they can
// pay. Deposit comes from renters.deposit_total (out-of-town / young-renter
// surcharges, promo waivers already applied by the database trigger).
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SK = Deno.env.get("STRIPE_CHECKOUT_KEY") || "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const enc = encodeURIComponent;
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => null) : null;
}
async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error("sbPost failed", r.status, await r.text().catch(() => "")); return null; }
  return await r.json().catch(() => null);
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error("sbPatch failed", r.status, await r.text().catch(() => ""));
}
const money = (n: number) => Math.round(n * 100); // Stripe wants cents

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SK) return json({ error: "STRIPE_CHECKOUT_KEY not set" }, 500);

  // who is calling?
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let uid = "";
  try { const p = JSON.parse(atob(tok.split(".")[1])); uid = String(p.sub || ""); } catch (_) { /* */ }
  if (!uid) return json({ error: "please sign in first" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const vehicleId = String(body.vehicle_id || "");
    const days = Math.max(1, Math.min(90, parseInt(String(body.days || "1"), 10) || 1));
    const usage = body.usage === "rideshare" ? "rideshare" : "personal";
    const startDate = body.start_date ? String(body.start_date) : null;
    const pickupTime = body.pickup_time ? String(body.pickup_time) : null;
    if (!vehicleId) return json({ error: "vehicle_id required" }, 400);

    // ---- the renter, resolved from their token (never from the body) ----
    const rows = await sbGet(`renters?auth_uid=eq.${enc(uid)}&select=*`);
    const renter = rows && rows[0];
    if (!renter) return json({ error: "no renter profile for this login" }, 403);
    if (renter.status !== "verified")
      return json({ error: "Your ID check isn't complete yet.", reason: "not_verified" }, 403);
    if (renter.decision !== "approved")
      return json({ error: "Your account is still with our team for final review.", reason: "not_approved" }, 403);
    if (renter.eligibility === "under_21")
      return json({ error: "The minimum rental age is 21.", reason: "under_21" }, 403);

    // one active rental at a time
    const live = await sbGet(`bookings?auth_uid=eq.${enc(uid)}&status=in.(confirmed,active)&select=id,vehicle_name`);
    if (live && live.length)
      return json({ error: `Please return ${live[0].vehicle_name || "your current car"} before booking another.`, reason: "already_renting" }, 409);

    // ---- the car ----
    const vs = await sbGet(`vehicles?id=eq.${enc(vehicleId)}&select=id,name,make,model,year,daily_rate,status,available`);
    const v = vs && vs[0];
    if (!v) return json({ error: "That vehicle no longer exists" }, 404);
    if (v.status !== "live" || v.available === false)
      return json({ error: "That car has just been taken. Please choose another.", reason: "unavailable" }, 409);
    const rate = Number(v.daily_rate || 0);
    if (!(rate > 0)) return json({ error: "That car isn't priced yet — please choose another." }, 409);

    // ---- a promo code entered at checkout ----
    // Writing it to the renter fires the deposit trigger, so all the surcharge
    // and waiver logic lives in one place rather than being duplicated here.
    const promo = body.promo_code ? String(body.promo_code).trim().toUpperCase() : null;
    if (promo && promo !== (renter.promo_code || "")) {
      const chk = await fetch(`${SB}/rest/v1/rpc/r2g_check_promo`, {
        method: "POST",
        headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_code: promo }),
      });
      const cj = await chk.json().catch(() => null);
      if (!cj || !cj.valid) return json({ error: "That promo code isn't valid.", reason: "bad_promo" }, 400);
      await sbPatch(`renters?id=eq.${enc(renter.id)}`, { promo_code: promo });
      const again = await sbGet(`renters?id=eq.${enc(renter.id)}&select=*`);
      if (again && again[0]) Object.assign(renter, again[0]);
    }

    // ---- the money ----
    const deposit   = Number(renter.deposit_total ?? 150);
    const subtotal  = Math.round(rate * days * 100) / 100;
    const rideshare = usage === "rideshare" ? 10 : 0;
    const total     = Math.round((subtotal + deposit + rideshare) * 100) / 100;
    const label     = [v.year, v.make, v.model].filter(Boolean).join(" ") || v.name || "Vehicle";

    // ---- provisional booking, so a payment can always be traced back ----
    const created = await sbPost("bookings", [{
      renter_id: renter.id, auth_uid: uid, vehicle_id: v.id, vehicle_name: label,
      days, daily_rate: rate, subtotal, deposit, rideshare_fee: rideshare,
      promo_code: renter.promo_code || null, total, usage,
      start_date: startDate, pickup_time: pickupTime,
      status: "pending_payment", stripe_account: "RENT 2 GO",
    }]);
    const booking = created && created[0];
    if (!booking) return json({ error: "could not start the booking" }, 500);

    // ---- Stripe Checkout ----
    const origin = String(body.return_origin || Deno.env.get("SITE_URL") || "https://rent2go-app.github.io/Rent2Go/");
    const f = new URLSearchParams();
    f.set("mode", "payment");
    f.set("success_url", `${origin}#booked`);
    f.set("cancel_url", `${origin}#catalogue`);
    if (renter.email) f.set("customer_email", String(renter.email));
    f.set("client_reference_id", booking.id);
    f.set("metadata[booking_id]", booking.id);
    f.set("metadata[renter_id]", renter.id);
    f.set("metadata[vehicle_id]", v.id);

    let i = 0;
    const line = (name: string, desc: string, amount: number) => {
      f.set(`line_items[${i}][quantity]`, "1");
      f.set(`line_items[${i}][price_data][currency]`, "usd");
      f.set(`line_items[${i}][price_data][unit_amount]`, String(money(amount)));
      f.set(`line_items[${i}][price_data][product_data][name]`, name);
      if (desc) f.set(`line_items[${i}][price_data][product_data][description]`, desc);
      i++;
    };
    line(`${label} — ${days} day${days > 1 ? "s" : ""}`, `$${rate.toFixed(2)} per day`, subtotal);
    if (deposit > 0) {
      const why = [
        Number(renter.deposit_out_of_town) > 0 ? "includes $150 out-of-town" : "",
        Number(renter.deposit_young) > 0 ? "includes $150 younger renter" : "",
      ].filter(Boolean).join(", ");
      line("Refundable security deposit", why || "Returned at the end of your rental", deposit);
    }
    if (rideshare > 0) line("Rideshare documentation", "Insurance & registration for Uber/Lyft", rideshare);

    const sr = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SK}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: f,
    });
    const s = await sr.json();
    if (s.error) {
      await sbPatch(`bookings?id=eq.${enc(booking.id)}`, { status: "cancelled" });
      return json({ error: s.error.message || "Stripe declined the request" }, 400);
    }

    await sbPatch(`bookings?id=eq.${enc(booking.id)}`, { stripe_session_id: s.id });
    return json({
      ok: true, booking_id: booking.id, url: s.url,
      breakdown: { days, daily_rate: rate, subtotal, deposit, rideshare_fee: rideshare, total },
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
