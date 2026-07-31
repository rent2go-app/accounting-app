// checkout-webhook — Stripe tells us a rental has been paid for.
//
// Deploy with verify_jwt = FALSE (Stripe sends no Supabase JWT; the request is
// authenticated by its signature). Secret: STRIPE_CHECKOUT_WHSEC.
//
// On checkout.session.completed: confirm the booking, take the car out of the
// catalogue, and email the renter their pickup details plus you a heads-up.
// On expiry/failure: release the provisional booking so the car frees up.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHSEC = Deno.env.get("STRIPE_CHECKOUT_WHSEC") || "";
const ADMIN_NOTIFY = Deno.env.get("ADMIN_NOTIFY") || "gorentaride@gmail.com";
// where the renter completes their pickup inspection (our own form, not Typeform)
const SITE = Deno.env.get("SITE_URL") || "https://rent2go-app.github.io/Rent2Go/";
const enc = encodeURIComponent;
function json(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }

async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => null) : null;
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error("sbPatch failed", r.status, await r.text().catch(() => ""));
}

/* ---- Stripe signature (Web Crypto HMAC-SHA256, no SDK) ---- */
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifySig(payload: string, header: string, secret: string) {
  if (!secret || !header) return false;
  let t = ""; const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;   // replay guard
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return v1.some((s) => safeEq(mac, s));
}

async function sendMail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key || !to) return;
  const from = Deno.env.get("RESEND_FROM") || "Rent 2 Go <noreply@rentaride2go.com>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch (_) { /* a rental must never fail because email did */ }
}
const shell = (title: string, body: string) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#131820;line-height:1.55;max-width:560px">
<h2 style="color:#0f8a4d;margin:0 0 12px">${title}</h2>${body}
<hr style="border:none;border-top:1px solid #e2e8e4;margin:22px 0 10px">
<div style="color:#5c6a7a;font-size:12px">Rent 2 Go · Suite 111, 9711 David Taylor Drive, Charlotte, NC 28262 · 980 272 8122</div></div>`;
const usd = (n: unknown) => "$" + Number(n || 0).toFixed(2);

/* ---- contact-less pickup instructions ----
   Built from the real booking + vehicle at the moment payment lands, so the
   time, date, car, colour and plate are always the ones the renter paid for.
   Stored on the booking AND emailed, so it can be re-sent or shown in-app. */
const ORD = (n: number) => n + (["th","st","nd","rd"][(n % 100 - 20) % 10] || ["th","st","nd","rd"][n % 100] || "th");
function longDate(iso: string | null) {
  if (!iso) return "TBC";
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return "TBC";
  const wd = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"][d.getDay()];
  const mo = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"][d.getMonth()];
  return `${wd} ${ORD(d.getDate()).toUpperCase()} ${mo} ${d.getFullYear()}`;
}
function pickupText(b: any, v: any) {
  const carName = [v?.make, v?.model].filter(Boolean).join(" ").toUpperCase() || String(b.vehicle_name || "YOUR VEHICLE").toUpperCase();
  const desc = [v?.color, v?.type].filter(Boolean).join(" ").toUpperCase() || "";
  const plate = (v?.plate || "TBC").toUpperCase();
  return `📍 CONTACT-LESS PICK UP INSTRUCTIONS📍
————————————————————
PICK UP TIME: ${b.pickup_time || "TBC"}
DATE: ${longDate(b.start_date)}
—————————————————————-

Go to
🏢9711 David Taylor Dr, Charlotte,
NC 28262, United States

📍2. To get your ride - When you pull up to the car park the car is parked in the first few Bays to the right when you pull in to parking lot

🚗3. ${carName}
${desc}

::: PLATE: ${plate}  :::

🔑4. The keys are in the cup holder in center console

🔒5. The car is disabled for safety reasons - so please let us know when you arrive so we can get you enabled and on your way

🏁 PICK UP FORM - BEGIN YOUR RENTAL
When you get to the Car - Please Complete the PICKUP by documenting the condition of the car Inside & outside as well as recording Gas and Mileage by using this pick up Form - Click This Link To Begin

🚦Use This Link TO BEGIN Your Rental
${SITE}#pickupForm

🎗MAKE SURE TO READ ALL THE RULES to make sure you know what you need to do`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const raw = await req.text();
  if (!await verifySig(raw, req.headers.get("Stripe-Signature") || "", WHSEC))
    return json({ error: "bad signature" }, 400);

  let evt: any; try { evt = JSON.parse(raw); } catch (_) { return json({ error: "bad payload" }, 400); }
  const type = String(evt.type || "");
  const s = evt.data?.object || {};
  const bookingId = s.metadata?.booking_id || s.client_reference_id;
  if (!bookingId) return json({ ok: true, ignored: "no booking reference" });

  const rows = await sbGet(`bookings?id=eq.${enc(bookingId)}&select=*`);
  const b = rows && rows[0];
  if (!b) return json({ ok: true, ignored: "unknown booking" });

  /* ---- payment failed or the customer walked away ---- */
  if (type === "checkout.session.expired" || type === "checkout.session.async_payment_failed") {
    if (b.status === "pending_payment") await sbPatch(`bookings?id=eq.${enc(bookingId)}`, { status: "expired" });
    return json({ ok: true, status: "expired" });
  }

  if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded")
    return json({ ok: true, ignored: type });

  if (s.payment_status && s.payment_status !== "paid")
    return json({ ok: true, ignored: "not paid yet: " + s.payment_status });
  if (b.status === "confirmed" || b.status === "active")
    return json({ ok: true, ignored: "already confirmed" });   // Stripe retries; stay idempotent

  await sbPatch(`bookings?id=eq.${enc(bookingId)}`, {
    status: "confirmed",
    paid_at: new Date().toISOString(),
    stripe_payment_intent: s.payment_intent || null,
  });
  // take it out of the catalogue so nobody double-books it
  if (b.vehicle_id) await sbPatch(`vehicles?id=eq.${enc(b.vehicle_id)}`, { available: false });

  const rs = await sbGet(`renters?id=eq.${enc(b.renter_id)}&select=name,email`);
  const renter = rs && rs[0];
  const who = (renter && renter.name) || "A renter";

  // real car details for the pickup note
  const vv = b.vehicle_id ? await sbGet(`vehicles?id=eq.${enc(b.vehicle_id)}&select=make,model,color,type,plate`) : null;
  const veh = vv && vv[0];
  const pickup = pickupText(b, veh);
  await sbPatch(`bookings?id=eq.${enc(bookingId)}`, { pickup_instructions: pickup, pickup_sent_at: new Date().toISOString() });
  const pickupHtml = `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;background:#f4f7f6;border:1px solid #e2e8e4;border-radius:12px;padding:16px 18px;line-height:1.55">${pickup.replace(/</g, "&lt;")}</pre>`;

  await sendMail(renter && renter.email, `Your ${b.vehicle_name} is booked — Rent 2 Go`,
    shell("You're booked", `
      <p>Thanks${renter && renter.name ? ", " + String(renter.name).split(" ")[0] : ""} — your rental is confirmed.</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:3px 14px 3px 0">Vehicle</td><td><b>${b.vehicle_name}</b></td></tr>
        <tr><td style="padding:3px 14px 3px 0">Days paid</td><td>${b.days} × ${usd(b.daily_rate)} = <b>${usd(b.subtotal)}</b></td></tr>
        <tr><td style="padding:3px 14px 3px 0">Deposit</td><td>${usd(b.deposit)} <span style="color:#5c6a7a">(refundable)</span></td></tr>
        <tr><td style="padding:3px 14px 3px 0"><b>Paid today</b></td><td><b>${usd(b.total)}</b></td></tr>
      </table>
      ${pickupHtml}
      <p style="color:#5c6a7a;font-size:13px">Reminder: 7-day minimum rental, daily payments due by midnight,
      and the vehicle stays within 100 miles of Charlotte.</p>`));

  await sendMail(ADMIN_NOTIFY, `Booking paid — ${who} · ${b.vehicle_name}`,
    shell("New booking paid", `
      <p><b>${who}</b>${renter && renter.email ? " (" + renter.email + ")" : ""} has paid <b>${usd(b.total)}</b>.</p>
      <p>${b.vehicle_name} · ${b.days} day(s) · deposit ${usd(b.deposit)}${b.promo_code ? " · promo " + b.promo_code : ""}</p>
      <p>The car has been marked unavailable. Prepare it for handover.</p>`));

  return json({ ok: true, booking: bookingId, status: "confirmed" });
});
