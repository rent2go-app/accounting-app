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


/* Say it the way a person would.
   Linda's replies are written to be read on screen - "$69.95/day ($489.65 for 7
   days)" is clear to the eye and a mess out loud: the slash is read as the word
   "slash", the brackets flatten the sentence, and a bare "$489.65" comes out as
   digits rather than money. Only the spoken copy is changed; what the renter
   reads in the chat stays exactly as written. */
function sayable(t: string): string {
  const spell = (d: string) => d.replace(/,/g, "");
  return String(t)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s*\/\s*day\b/gi, " per day")
    .replace(/\s*\/\s*(wk|week)\b/gi, " per week")
    .replace(/\s*\/\s*(mo|month)\b/gi, " per month")
    .replace(/\s*\/\s*(yr|year)\b/gi, " per year")
    // money with cents, then whole dollars
    .replace(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})/g, (_m, d, c) => {
      const cents = Number(c);
      return cents ? `${spell(d)} dollars and ${cents} cents` : `${spell(d)} dollars`;
    })
    .replace(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)/g, (_m, d) => `${spell(d)} dollars`)
    .replace(/(\d)\s*%/g, "$1 percent")
    // a range said as a range, not as a subtraction
    .replace(/\b(\d{1,4})\s*[-\u2013]\s*(\d{1,4})\b/g, "$1 to $2")
    // brackets stop the sentence dead; a comma keeps it moving
    .replace(/[()\[\]]/g, ", ")
    .replace(/\s*[\u2022\u00b7]\s*/g, ", ")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")   // a bracket at the end of a sentence left ", ."
    .replace(/,\s*$/g, ".")          // ...or a comma hanging off the end
    .replace(/\s+/g, " ")
    .trim();
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
    const text = sayable(String(body.text || "")).slice(0, 700);
    // dry:true returns what would be spoken, for checking the wording without
    // spending a generation on it
    if (body.dry) {
      return new Response(JSON.stringify({ spoken: text }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
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
