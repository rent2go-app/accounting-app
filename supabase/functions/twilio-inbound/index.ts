// twilio-inbound — receives replies TO the Rent 2 Go Twilio number and drops them into Linda's
// Incoming Messages inbox (via ingest-message, same place as Google Voice / Quo).
// Set this as the number's Messaging webhook (A MESSAGE COMES IN → Webhook, POST).
// verify_jwt=false; guarded by a ?t= token on the URL. Returns empty TwiML so Twilio is satisfied.
const SB = Deno.env.get("SUPABASE_URL")!;
const INGEST = `${SB}/functions/v1/ingest-message`;
const TOKEN = Deno.env.get("MSG_INGEST_TOKEN") || "";
const CORS = { "Access-Control-Allow-Origin": "*" };
const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
function twiml() { return new Response(TWIML, { status: 200, headers: { ...CORS, "Content-Type": "text/xml" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (!TOKEN || url.searchParams.get("t") !== TOKEN) return new Response("forbidden", { status: 403 });
  try {
    const form = await req.formData();
    const from = String(form.get("From") || "");
    const body = String(form.get("Body") || "");
    const sid = String(form.get("MessageSid") || form.get("SmsSid") || "");
    if (from || body) {
      await fetch(INGEST, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ingest-token": TOKEN },
        body: JSON.stringify({ source: "twilio", from, body, received_at: new Date().toISOString(), ext_id: "tw_" + sid }),
      });
    }
  } catch (_) { /* never fail the webhook — Twilio retries on non-200 */ }
  return twiml();
});
