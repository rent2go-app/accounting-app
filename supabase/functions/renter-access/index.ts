// renter-access — give a renter a way into their own dashboard.
//
// Creates the Supabase Auth account if they do not have one, mints a magic
// sign-in link, emails it, and hands the same link back so it can be pasted into
// a text or WhatsApp. One link works in both places.
//
// Auth: verify_jwt = true (service_role, or an admin email).
// Secrets: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM, SITE_URL.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = Deno.env.get("SITE_URL") || "https://rent2go-app.github.io/Rent2Go/";
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
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SB}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function auth(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`${SB}/auth/v1/${path}`, {
    method,
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/* One message, written to work as an email and as a text. Kept short: a text
   that runs past a couple of screens does not get read. */
function smsText(first: string, link: string) {
  return `Hi ${first}, here is your Rent 2 Go account. Tap to sign in — no password needed. `
       + `You can see your car, your daily invoices and pay them here: ${link}`;
}
function emailHtml(first: string, link: string, car: string | null, balance: number) {
  const owing = balance > 0
    ? `<p style="margin:0 0 14px">Your current balance is <b>$${balance.toFixed(2)}</b>. You can settle it from your dashboard.</p>`
    : `<p style="margin:0 0 14px">Your account is up to date. Thank you.</p>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#131820;line-height:1.55;max-width:560px">
  <h2 style="color:#0f8a4d;margin:0 0 12px">Your Rent 2 Go account is ready</h2>
  <p style="margin:0 0 14px">Hi ${first},</p>
  <p style="margin:0 0 14px">You can now manage your rental online${car ? ` — your ${car}` : ""}.
  See your daily invoices, what is outstanding, and pay, all in one place.</p>
  ${owing}
  <p style="margin:0 0 20px">
    <a href="${link}" style="background:#0f8a4d;color:#fff;padding:13px 24px;border-radius:8px;
       text-decoration:none;font-weight:700;display:inline-block">Open my dashboard</a></p>
  <p style="margin:0 0 14px;color:#5c6a7a;font-size:13px">No password needed — the button signs you in.
  The link is single-use; if it stops working just ask us for another.</p>
  <hr style="border:none;border-top:1px solid #e2e8e4;margin:22px 0 10px">
  <div style="color:#5c6a7a;font-size:12px">Rent 2 Go · 9711 David Taylor Drive, Suite 111, Charlotte, NC 28262 · 980 272 8122</div></div>`;
}

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

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = body.action || "invite";

    // which renters to act on: explicit ids, or every active one without a login
    let targets: any[] = [];
    if (Array.isArray(body.renter_ids) && body.renter_ids.length) {
      const inList = body.renter_ids.map((x: string) => `"${x}"`).join(",");
      targets = await sbGet(`v_admin_renters?select=*&id=in.(${enc(inList)})`);
    } else {
      targets = await sbGet(`v_admin_renters?select=*&bucket=eq.ACTIVE&order=fleet,name`);
      if (action !== "relink") targets = targets.filter((t: any) => !t.has_login || body.force === true);
    }

    const out: any[] = [];
    for (const t of targets) {
      const email = String(t.email || "").trim().toLowerCase();
      if (!email) { out.push({ renter: t.name, error: "no email on file" }); continue; }
      const first = String(t.name || email.split("@")[0]).trim().split(/\s+/)[0];
      const nice = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();

      // 1. the account — create it if this is their first time
      let created = false;
      if (!t.has_login) {
        const mk = await auth("admin/users", "POST", {
          email, email_confirm: true,
          user_metadata: { name: t.name, renter_id: t.id, source: "admin invite" },
        });
        if (mk.ok && mk.data?.id) created = true;
        else if (mk.status !== 422 && !String(JSON.stringify(mk.data)).includes("already")) {
          out.push({ renter: t.name, email, error: JSON.stringify(mk.data).slice(0, 160) });
          continue;
        }
      }

      // 2. tie the login to the renter record, so RLS lets them see their own bills
      const users = await auth(`admin/users?filter=${enc(email)}`);
      const uid = (users.data?.users || []).find((u: any) =>
        String(u.email || "").toLowerCase() === email)?.id;
      if (uid) await sbPatch(`renters?id=eq.${enc(t.id)}`, { auth_uid: uid });

      // 3. the sign-in link
      const gl = await auth("admin/generate_link", "POST", {
        type: "magiclink", email,
        options: { redirect_to: SITE + "#dashboard" },
      });
      const link = gl.data?.properties?.action_link || gl.data?.action_link;
      if (!link) { out.push({ renter: t.name, email, created, error: "could not mint a link" }); continue; }

      const row: any = {
        renter_id: t.id, renter: t.name, email, phone: t.phone || null,
        fleet: t.fleet, car: t.vehicle, balance: Number(t.balance || 0),
        created_account: created, link, sms: smsText(nice, link),
      };

      // 4. send it, unless the caller only wants the link back
      if (body.send !== false) {
        const key = Deno.env.get("RESEND_API_KEY");
        if (key) {
          const from = Deno.env.get("RESEND_FROM") || "Rent 2 Go <noreply@rentaride2go.com>";
          try {
            const er = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
              body: JSON.stringify({
                from, to: [email],
                subject: "Your Rent 2 Go account — sign in to manage your rental",
                html: emailHtml(nice, link, t.vehicle, Number(t.balance || 0)),
              }),
            });
            row.emailed = er.ok;
            if (!er.ok) row.email_error = (await er.text().catch(() => "")).slice(0, 140);
          } catch (e) { row.emailed = false; row.email_error = String(e).slice(0, 120); }
        } else { row.emailed = false; row.email_error = "RESEND_API_KEY not set"; }
      }
      out.push(row);
    }

    return json({
      ok: true,
      count: out.length,
      accounts_created: out.filter((r) => r.created_account).length,
      emailed: out.filter((r) => r.emailed).length,
      failed: out.filter((r) => r.error).length,
      results: out,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
