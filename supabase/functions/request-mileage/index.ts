// request-mileage — ask the renter of one car for an odometer reading.
//
// The dashboard used to carry a standing "Quick mileage check" card that came
// back every fortnight whether anyone needed a reading or not. A prompt that is
// always there is furniture: it stops being read, and when a reading is genuinely
// needed it carries no more weight than it did last week.
//
// So the office asks, from the car. The renter is emailed and texted, the prompt
// appears on their dashboard while the request is open, and it clears when they
// answer.
//
// Auth: verify_jwt = true — service_role or an admin email.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = (Deno.env.get("SITE_URL") || "https://demo.rentaride2go.com/").replace(/\/?$/, "/");
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const enc = encodeURIComponent;
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sbGet(path: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } });
  return r.ok ? await r.json().catch(() => []) : [];
}
async function sbPost(table: string, rows: unknown[]) {
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json",
               Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  return r.ok ? await r.json().catch(() => []) : [];
}

const BRAND = { green: "#0f8a4d", ink: "#131820", muted: "#5c6a7a", line: "#e2e8e4", wash: "#f4f7f6",
                phone: "980 272 8122" };

function emailHtml(first: string, car: string, note: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.wash}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.wash}">
<tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid ${BRAND.line};border-radius:14px">
<tr><td align="center" style="padding:26px 30px 0"><img src="${SITE}assets/logo.png" width="176" alt="Rent 2 Go" style="display:block;width:176px;max-width:60%;height:auto;border:0"></td></tr>
<tr><td style="padding:18px 30px 0"><div style="height:3px;background:${BRAND.green};border-radius:3px"></div></td></tr>
<tr><td style="padding:22px 30px 26px;font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink}">
<h1 style="margin:0 0 14px;font-size:21px;color:${BRAND.green}">Quick mileage check</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hi ${first},</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Could you send us the current odometer reading on your <b>${car}</b>? It takes a few seconds and it is how we keep the car serviced on time — oil changes are scheduled on mileage, not on dates.</p>
${note ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;background:${BRAND.wash};border-radius:8px;padding:12px 14px">${note}</p>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">
<tr><td bgcolor="${BRAND.green}" style="border-radius:8px">
<a href="${SITE}#dashboard" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#fff;text-decoration:none;border-radius:8px">Enter the mileage</a>
</td></tr></table>
<p style="margin:16px 0 0;font-size:13px;line-height:1.55;color:${BRAND.muted}">A photo of the dash works too — reply to this message or text us on ${BRAND.phone}.</p>
</td></tr>
<tr><td style="padding:0 30px"><div style="border-top:1px solid ${BRAND.line}"></div></td></tr>
<tr><td style="padding:16px 30px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.65;color:${BRAND.muted}">
<strong style="color:${BRAND.ink}">Rent 2 Go LLC</strong><br>9711 David Taylor Drive, Suite 111, Charlotte, NC 28262<br>${BRAND.phone}
</td></tr></table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR, who = "service_role";
  if (!ok) {
    try {
      const p = JSON.parse(atob(tok.split(".")[1]));
      if (p.role === "service_role") { ok = true; }
      else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) { ok = true; who = String(p.email); }
    } catch (_) { /* */ }
  }
  if (!ok) return json({ error: "unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({} as any));
    const vehicleId = String(body.vehicle_id || "");
    if (!vehicleId) return json({ error: "vehicle_id required" }, 400);

    const veh = (await sbGet(`vehicles?id=eq.${enc(vehicleId)}&select=id,name,plate&limit=1`))[0];
    if (!veh) return json({ error: "no such vehicle" }, 404);

    /* Whoever is in the car right now. The renter record is the authority - a
       booking can be closed while the car is still out on a daily subscription. */
    const renter = (await sbGet(
      `renters?current_vehicle_id=eq.${enc(vehicleId)}&select=id,name,email,phone&limit=1`))[0];
    if (!renter) return json({ error: "nobody is renting that car", reason: "no_renter" }, 404);

    const first = String(renter.name || "there").trim().split(/\s+/)[0];
    const nice = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    const carName = String(veh.name || "your car").split("·")[0].trim();
    const note = String(body.note || "").slice(0, 300);

    const row = (await sbPost("mileage_requests", [{
      vehicle_id: vehicleId, renter_id: renter.id, requested_by: who, note: note || null,
    }]))[0];

    // email
    let sentEmail = false, emailError = null;
    const rk = Deno.env.get("RESEND_API_KEY");
    if (rk && renter.email) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + rk, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("RESEND_FROM") || "Rent 2 Go <noreply@rentaride2go.com>",
            to: [renter.email],
            subject: `Quick mileage check — ${carName}`,
            html: emailHtml(nice, carName, note),
          }),
        });
        sentEmail = r.ok;
        if (!r.ok) emailError = (await r.text().catch(() => "")).slice(0, 140);
      } catch (e) { emailError = String(e).slice(0, 120); }
    }

    // text — short, because a text that runs past a screen does not get read
    let sentSms = false, smsError = null;
    if (renter.phone) {
      try {
        const r = await fetch(`${SB.replace(".supabase.co", ".functions.supabase.co")}/send-sms`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            to: renter.phone,
            body: `Hi ${nice}, Rent 2 Go here. Could you send us the current mileage on your ${carName}? `
                + `It keeps the service due on time. Enter it at ${SITE.replace(/^https?:\/\//, "").replace(/\/$/, "")} `
                + `or just reply with the number.`,
          }),
        });
        const j = await r.json().catch(() => ({}));
        sentSms = !!(r.ok && !j.error);
        if (!sentSms) smsError = String(j.error || r.status).slice(0, 140);
      } catch (e) { smsError = String(e).slice(0, 120); }
    }

    await fetch(`${SB}/rest/v1/mileage_requests?id=eq.${enc(row?.id)}`, {
      method: "PATCH",
      headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ sent_email: sentEmail, sent_sms: sentSms }),
    });

    return json({ ok: true, request_id: row?.id, vehicle: carName,
                  renter: renter.name, email: renter.email, phone: renter.phone || null,
                  sent_email: sentEmail, sent_sms: sentSms,
                  email_error: emailError, sms_error: smsError });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});
