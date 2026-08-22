// linda-chat — the assistant on the website, answering renter questions live.
//
// Grounded three ways so she cannot invent things:
//   1. the written policy below, which mirrors the rental agreement
//   2. the live catalogue — what is actually bookable, and today's rates
//   3. the caller's own account, when they are signed in, so "what do I owe"
//      has a real answer instead of a deflection
//
// Public on purpose: a visitor who has not signed up yet is exactly who needs
// answering. verify_jwt = false. A user token, if present, is what unlocks
// account answers — never anything supplied in the request body.
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AK = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("LINDA_MODEL") || "claude-sonnet-4-6";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const enc = encodeURIComponent;

async function sbGet(path: string, token?: string) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: SR, Authorization: `Bearer ${token || SR}` },
  });
  return r.ok ? await r.json().catch(() => []) : [];
}

const POLICY = `
RENT 2 GO — long-term car rental, Charlotte, North Carolina.
Address: 9711 David Taylor Drive, Suite 111, Charlotte, NC 28262
Phone: 980 272 8122 · Roadside assistance: (704) 912-0864 · info@rentaride2go.com

RENTING
- Minimum rental is 7 days. We do not do one-day or short-term hire, even though payment is daily.
- You must be 21 or over, with a valid licence free of infractions.
- No credit checks. We validate the licence through Stripe Identity.
- To be approved: verify your licence, upload proof of address (recent mail matching your
  registered address), and sign the rental agreement.
- Approval is usually within one business day.

MONEY
- To start you pay a refundable security deposit plus your first day.
- Deposit is $150 if you are 25 or over and live in metro Charlotte.
- $300 if your home address is outside metro Charlotte.
- $350 if you are aged 21 to 24.
- The two surcharges do NOT stack: someone aged 21-24 AND out of town pays $350, not more.
  $350 is the most anyone pays.
- After day one you pay daily. Each day is due by midnight.
- A payment is late after midnight and a $10 late fee applies.
- Missed payments can disable the engine via GPS. Reconnection costs $30.
- We take debit, credit, Cash App and Apple Pay.
- Daily rates depend on the car and are shown on each vehicle in the catalogue.

DRIVING
- Unlimited miles for local driving. The car must stay within 100 miles of Charlotte.
- Every car carries GPS and the engine disables beyond that boundary. No out-of-state trips.
- Rideshare (Uber, Lyft) is allowed — choose it at checkout and we provide the car's
  insurance and registration documents. Personal use needs no extra paperwork.
- Tolls, tickets and fines are the renter's responsibility.
- No smoking: a $150 fee, and it can end the contract. Keep the car clean.
- Report any fault immediately from the dashboard or by phone. Do not arrange repairs
  yourself — unauthorised repairs are not reimbursed.

PICKUP
- Contact-less. We email the bay, the plate and the time. Keys are in the centre console cup holder.
- The car is immobilised until you complete the pickup form (photos, fuel, mileage), then we enable it.

RETURNING
- Give at least 24 hours notice, and return before 10 AM or you pay for another day.
- Return it clean and fuelled to at least half a tank, with no unreported damage.
- Deductions: under 7 days voids the deposit; no 24-hour notice $50; after 10 AM a new day
  charged; past-due balance deducted; unreported damage voids the deposit; dashboard warning
  lights not reported $25; fuel below half $30; not cleaned $30; tolls billed as charged.

IF SOMETHING GOES WRONG
- Accident: get to safety, call 911, then call us on 980 272 8122. A police report is
  required for insurance.
- Breakdown or lockout: roadside on (704) 912-0864, or request it from the dashboard.

OWNERS
- The Vehicle Partner Program: list a car you already own. We find and vet the renter, fit
  GPS, collect the daily payments and handle maintenance. Earnings, payouts and statements
  appear in the owner dashboard.
`.trim();

const STYLE = `
You are Linda, the assistant for Rent 2 Go. You speak to renters and prospective renters on
the company website.

How you write:
- Warm but businesslike, the way a good front-desk person speaks.
- Answer the question first, then add only the detail that matters. Never pad.
- Plain English. No exclamation marks, no emoji, no sales patter.
- Two or three sentences is usually right. Four at most.
- PLAIN TEXT ONLY. This is a chat bubble, not a document: no markdown, no **bold**,
  no tables, no headings. If you need to list cars or fees, write them as short lines
  like "Nissan Sentra 2019 Black - $69.95 a day", one per line.
- Prices as $69.95. Never spell an amount out in words.

What you must not do:
- Never invent a price, a car, a date or a policy. If it is not in the material below,
  say you are not certain and give the phone number: 980 272 8122.
- Never promise a car is available unless it appears in the live list below.
- Never quote a deposit other than the rules given.
- Do not give legal or insurance advice beyond what is written here.
- If someone is upset, or asks about an accident, damage, or a dispute, answer briefly and
  point them to 980 272 8122 — a person should handle it.
- NEVER say you "don't have access" or "can't access their account". If there is no
  "THIS CUSTOMER" section below, they simply aren't signed in yet. When they ask about their
  own balance, car or payments, warmly say you can pull it up the moment they sign in on the
  dashboard — then still answer the general version of their question. Always be helpful; a
  first-time visitor with no account is exactly who you are here for.
`.trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!AK) return json({ error: "assistant unavailable" }, 503);

  try {
    const body = await req.json().catch(() => ({} as any));
    const message = String(body.message || "").slice(0, 1500).trim();
    if (!message) return json({ error: "no message" }, 400);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

    // ---- what is actually bookable today ----
    const cars = await sbGet("v_public_vehicles?select=name,year,type,seats,rate,available,description&limit=60");
    const free = cars.filter((c: any) => c.available && !String(c.name || "").toUpperCase().includes("TESTING"));
    const fleetNote = free.length
      ? "AVAILABLE TO BOOK RIGHT NOW (do not offer anything else as available):\n" +
        free.map((c: any) => `- ${c.name} · ${c.type} · ${c.seats} seats · $${c.rate}/day`).join("\n")
      : "Nothing is available to book right now — every car is out. Offer to take their details " +
        "so we can call when one frees up, and give the phone number.";

    // ---- who is asking, if they are signed in ----
    let account = "";
    const authz = req.headers.get("Authorization") || "";
    const userTok = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (userTok && userTok !== SR) {
      try {
        const me = await sbGet("renters?select=id,name,current_vehicle_id&limit=1", userTok);
        if (Array.isArray(me) && me[0]) {
          const inv = await sbGet("v_my_invoices?select=amount_due,pay_status,due_date&limit=60", userTok);
          const open = (inv || []).filter((i: any) => i.pay_status === "open" || i.pay_status === "past_due");
          const bal = open.reduce((a: number, i: any) => a + Number(i.amount_due || 0), 0);
          const pd = open.filter((i: any) => i.pay_status === "past_due").length;
          const car = me[0].current_vehicle_id
            ? (await sbGet(`vehicles?select=name&id=eq.${enc(me[0].current_vehicle_id)}`))[0]?.name
            : null;
          account =
            `THE PERSON YOU ARE TALKING TO IS SIGNED IN.\n` +
            `Name: ${me[0].name}\n` +
            (car ? `Their car: ${car}\n` : "They have no car on their account right now.\n") +
            `Outstanding balance: $${bal.toFixed(2)} across ${open.length} unpaid invoice(s)` +
            (pd ? `, ${pd} of them past due` : "") + `.\n` +
            `You may answer questions about their own account using this. Tell them they can pay ` +
            `from the Your payments card on their dashboard.`;
        }
      } catch (_) { /* signed out is fine */ }
    }

    const system = [STYLE, "--- POLICY ---", POLICY, "--- LIVE FLEET ---", fleetNote,
                    account ? "--- THIS CUSTOMER ---" : "", account].filter(Boolean).join("\n\n");

    const messages = [
      ...history
        .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && h.content)
        .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, 1200) })),
      { role: "user", content: message },
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages }),
    });
    const d = await r.json();
    if (d.error) return json({ error: d.error.message || "assistant unavailable" }, 502);
    const reply = (d.content || []).map((c: any) => c.text || "").join("").trim();
    return json({ ok: true, reply, signed_in: !!account, available: free.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
