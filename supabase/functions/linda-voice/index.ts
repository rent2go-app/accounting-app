// linda-voice — speaks Linda's reply.
//
// A proxy on purpose: the ElevenLabs key never reaches the browser. The page
// sends text, gets audio back, and never sees the credential.
//
// Public (verify_jwt = false) because visitors who have not signed up are exactly
// who Linda talks to. Guarded by a length cap and a per-IP rate limit, since
// every call costs money.
const KEY = Deno.env.get("ELEVENLABS_API_KEY") || "";
// Jessica — young American woman, warm and conversational. Swap the id here or
// set LINDA_VOICE_ID to change her without touching the code.
const VOICE = Deno.env.get("LINDA_VOICE_ID") || "cgSgspJ2msm6clMCkdW9";
const MODEL = Deno.env.get("LINDA_VOICE_MODEL") || "eleven_turbo_v2_5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// crude but effective: a handful of calls a minute per address
const hits = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const win = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  win.push(now);
  hits.set(ip, win);
  if (hits.size > 500) hits.clear();
  return win.length > 12;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (!KEY) {
    return new Response(JSON.stringify({ error: "voice not configured" }), { status: 503, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";
  if (tooMany(ip)) {
    return new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  try {
    const body = await req.json().catch(() => ({} as any));
    // 700 characters is about 45 seconds of speech — plenty for a chat reply,
    // and a ceiling on what any one request can cost.
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 700);
    if (!text) {
      return new Response(JSON.stringify({ error: "no text" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      return new Response(JSON.stringify({ error: "voice failed", detail }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, {
      headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
