// linda-command — vehicle control for Linda via SareKon GPS. Three functions the admin needs:
//   • track   — current location + ignition ON/OFF + recent event timeline
//   • disable — Starter Auto-Disable (1253) at "Anywhere / earliest possible" (takes effect next time the car is off)
//   • enable  — Starter Auto-Enable (1252)
// Per-fleet creds in secret LINDA_GPS = [{match, api, username, password}] — JJTusa has its own account,
// everything else uses "default". Auth: verify_jwt=true — service_role (cron) or admin email.
// Every send supports dry_run (returns the exact call, sends nothing).
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GPS = JSON.parse(Deno.env.get("LINDA_GPS") || "[]");
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

// disable = starter auto-disable (1253) at earliest opportunity ("Anywhere"); enable = starter auto-enable (1252)
const CMD: Record<string, { id: number; params: Record<string, number> }> = {
  disable: { id: 1253, params: { data_type_23110: 0 } },
  enable: { id: 1252, params: {} },
  locate: { id: 6000, params: {} },
};

function gpsFor(label: string) { return GPS.find((g: any) => g.match === label) || GPS.find((g: any) => g.match === "default"); }
async function getSid(g: any) { const u = new URL(g.api + "/session/create.json"); u.searchParams.set("username", g.username); u.searchParams.set("password", g.password); const r = await fetch(u.toString()); const d = await r.json().catch(() => ({})); return d.sid || ""; }
async function gpsCall(g: any, s: string, path: string, params: Record<string, any>) {
  const u = new URL(g.api + path); u.searchParams.set("sid", s);
  for (const [k, v] of Object.entries(params)) { if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x))); else u.searchParams.set(k, String(v)); }
  const r = await fetch(u.toString()); return { status: r.status, data: await r.json().catch(() => ({})) };
}
function json(o: any) { return new Response(JSON.stringify(o), { headers: { ...CORS, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* */ } }
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const body = await req.json().catch(() => ({}));
    const g = gpsFor(body.account_label || "");
    if (!g) return json({ error: "no GPS account configured for " + body.account_label });
    const s = await getSid(g);
    if (!s) return json({ error: "GPS auth failed for " + (g.username || "?") });

    // list this fleet's devices (for the link-a-device picker)
    if (body.action === "devices") {
      const r = await gpsCall(g, s, "/dvd/enumerate.json", {});
      const devices = (r.data.dvds || []).map((d: any) => ({ device_id: d.device_id, description: d.description || d.device_description || d.device_id }));
      return json({ ok: true, account: g.username, count: devices.length, devices });
    }

    // TRACK — where is it, is the ignition on/off, and the recent event timeline
    if (body.action === "track") {
      if (!body.device_id) return json({ error: "device_id required" });
      const loc = await gpsCall(g, s, "/location/list.json", { "device_ids[]": body.device_id });
      const L = (loc.data.locations || [])[0] || {};
      const msg = await gpsCall(g, s, "/message/list.json", { "device_ids[]": body.device_id });
      const msgs = (msg.data.messages || []);
      const events = msgs.slice(0, 12).map((m: any) => ({ time: m.triggered_on_local, event: m.message_type_description, address: m.address }));
      const ign = msgs.find((m: any) => /ignition\s+(on|off)/i.test(m.message_type_description || ""));
      // motion state: first movement event newest-first tells whether it's driving or stopped, and since when
      const moveEv = msgs.find((m: any) => /\b(stop|trip start|moving|driving)\b/i.test(m.message_type_description || ""));
      const motion = moveEv ? (/stop/i.test(moveEv.message_type_description) ? "stopped" : "driving") : null;
      return json({
        ok: true, device_id: body.device_id, asset: L.asset_description, vin: L.asset_vin,
        address: L.address, lat: L.latitude, lng: L.longitude, speed: L.speed_display,
        last_event: L.message_type_description, last_event_time: L.triggered_on_local,
        ignition: ign ? (/on/i.test(ign.message_type_description) ? "ON" : "OFF") : null,
        ignition_since: ign ? ign.triggered_on_local : null,
        motion, motion_since: moveEv ? moveEv.triggered_on_local : null,
        maps: (L.latitude && L.longitude) ? `https://maps.google.com/?q=${L.latitude},${L.longitude}` : null,
        events,
      });
    }

    // poll a queued command's status
    if (body.action === "status") {
      const r = await gpsCall(g, s, "/command_queue/list.json", body.command_queue_id ? { "command_queue_ids[]": body.command_queue_id } : {});
      return json({ ok: true, data: r.data });
    }

    // SEND disable/enable (dry_run returns the exact call and sends nothing)
    if (body.action === "send") {
      const c = CMD[body.kind];
      if (!c) return json({ error: "kind must be 'disable' or 'enable'" });
      if (!body.device_id) return json({ error: "device_id required" });
      const params: Record<string, any> = { "device_ids[]": body.device_id, message_type_id: c.id, ...c.params };
      if (body.dry_run) {
        const preview = new URL(g.api + "/command_queue/create.json"); preview.searchParams.set("sid", "***");
        for (const [k, v] of Object.entries(params)) preview.searchParams.set(k, String(v));
        return json({ ok: true, dry_run: true, kind: body.kind, message_type_id: c.id, device_id: body.device_id, account: g.username, would_send: preview.toString() });
      }
      const r = await gpsCall(g, s, "/command_queue/create.json", params);
      const cmd = (r.data.commands || [])[0] || {};
      return json({ ok: !r.data.error, http: r.status, kind: body.kind, notice: r.data.notice, error: r.data.error, command_queue_id: cmd.command_queue_id, status_description: cmd.status_description, error_id: cmd.error_id });
    }
    return json({ error: "action must be 'devices', 'track', 'send', or 'status'" });
  } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
});
