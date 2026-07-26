// Linda scan — daily billing sweep across every Stripe account.
// Deno / Supabase Edge Function. Faithful port of the reference scan (seed_linda.py).
// Auth: verify_jwt=true. Allowed callers: service_role (cron) OR an admin email (RE-AUDIT button).
// Reads secret LINDA_ACCOUNTS = [{label,key,portal}, ...]. Writes linda_customers/drafts/fees/payments.

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ACCTS = JSON.parse(Deno.env.get("LINDA_ACCOUNTS") || "[]"); // [{label,key,portal}]
const ADMINS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com", "thandobnkala@gmail.com"];
const TZ = "America/New_York";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const now = Math.floor(Date.now() / 1000);
const nowISO = new Date().toISOString();
function etYMD(e: number) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(e * 1000)); }
function etMD(e: number) { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(e * 1000)); }
function etMDY(e: number) { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }).format(new Date(e * 1000)); }
function etOffset(d: Date) { const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value; return s.replace("GMT", "") || "+00:00"; }
function etISO(e: number) { const d = new Date(e * 1000); const hms = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d); return `${etYMD(e)}T${hms}${etOffset(d)}`; }
const todaystr = etYMD(now);
const midnightISO = `${todaystr}T00:00:00${etOffset(new Date())}`;
const cutoffISO = new Date((now - 3 * 86400) * 1000).toISOString();
function m(x: number) { return "$" + x.toFixed(2); }
const enc = encodeURIComponent;

async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbDel(path: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "DELETE", headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function stripe(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "linda" } }); return await r.json(); }
async function stripeAll(base: string, key: string) { let out: any[] = [], sa: string | null = null; while (true) { const d = await stripe(base + (sa ? `&starting_after=${sa}` : ""), key); const rows = d.data || []; out = out.concat(rows); if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break; } return out; }

function isLateFee(i: any) { const md = i.metadata || {}; const ln = (i.lines?.data || [{}])[0] || {}; const txt = ((i.description || "") + " " + (ln.description || "")).toLowerCase(); return i.amount_due === 1000 && (txt.includes("late fee") || md.linda_late_fee); }
function isPastDue(i: any) { const dd = i.due_date; return dd ? (dd < now) : ((now - (i.created || now)) > 86400); }
function cleanlbl(s: string) { s = (s || "Rental").trim(); if (s.includes("×")) s = s.split("×")[1].trim(); const p = s.indexOf("(at "); if (p > 0) s = s.slice(0, p).trim(); return s; }
function invline(i: any, icon: string) { const lbl = isLateFee(i) ? "Late fee" : cleanlbl((i.lines?.data || [{}])[0]?.description || i.description || "Rental"); const gen = i.created ? etMD(i.created) : "—"; const url = i.hosted_invoice_url || ""; return `${icon} ${gen} · ${lbl.slice(0, 34)} · ${m((i.amount_remaining || 0) / 100)}${url ? ` · [Pay now](${url})` : ""}`; }
function footer(portal: string) { return portal ? `\n\n💳 Manage & pay anytime in your [Customer Portal](${portal}) — sign in with your email on file.` : `\n\nManage & pay from your customer portal — sign in with your email on file.`; }
const APPREC_PAID = "Thank you so much for your recent payment — we truly appreciate you keeping up with your account. ";
const APPREC_GEN = "Thank you for being a valued Rent 2 Go customer — we really appreciate your efforts to stay on top of your account. ";

async function scanAccount(acc: any) {
  const LABEL = acc.label, SKEY = acc.key, FOOTER = footer(acc.portal || "");
  const aL = "account_label=eq." + enc(LABEL);
  const MID = enc(midnightISO);
  // DAILY RESET (each day starts fresh; TODAY's sent/reviewed are preserved, skipped left to the 3-day snooze):
  await sbDel(`linda_drafts?${aL}&status=eq.sent&sent_at=lt.${MID}`);                            // yesterday's sent
  await sbDel(`linda_drafts?${aL}&status=neq.skipped&sent_at=is.null&created_at=lt.${MID}`);     // yesterday's unsent (draft/reviewed)
  await sbDel(`linda_drafts?${aL}&status=eq.draft&reviewed_at=is.null&created_at=gte.${MID}`);   // today's untouched -> regenerate fresh
  await sbDel(`linda_fees?${aL}&status=eq.proposed`);
  await sbDel(`linda_drafts?${aL}&status=eq.skipped&skipped_at=lt.${enc(cutoffISO)}`);
  await sbDel(`linda_drafts?${aL}&status=eq.skipped&skipped_at=is.null`);
  const skipset = new Set((await sbGet(`linda_drafts?select=customer_id&${aL}&status=eq.skipped`)).map((r: any) => r.customer_id));
  const keepset = new Set((await sbGet(`linda_drafts?select=customer_id&${aL}&or=(sent_at.gte.${enc(midnightISO)},reviewed_at.gte.${enc(midnightISO)})`)).map((r: any) => r.customer_id));

  const subs = await stripeAll(`https://api.stripe.com/v1/subscriptions?status=all&limit=100&expand[]=data.customer`, SKEY);
  const active = subs.filter((s: any) => ["active", "past_due", "unpaid", "trialing"].includes(s.status));
  const custs: any[] = [], drafts: any[] = [], fees: any[] = [], payments: any[] = [];

  await Promise.all(active.map(async (s: any) => {
    const c = s.customer || {}, cid = c.id, nm = c.name || "(no name)", em = c.email || "", ph = c.phone || "";
    const allinv = await stripeAll(`https://api.stripe.com/v1/invoices?customer=${cid}&limit=100`, SKEY);
    for (const i of allinv) { if (i.status === "paid") { const pat = i.status_transitions?.paid_at || 0; if (pat && etYMD(pat) === todaystr) payments.push({ invoice_id: i.id, account_label: LABEL, customer_id: cid, customer_name: nm, amount: Math.round((i.amount_paid || 0) / 100 * 100) / 100, paid_at: etISO(pat), invoice_number: i.number || i.id, kind: isLateFee(i) ? "latefee" : "rental", updated_at: nowISO }); } }
    const inv = allinv.filter((i: any) => i.status === "open" && (i.amount_remaining || 0) > 0);
    const paidrecent = allinv.some((i: any) => i.status === "paid" && ((i.status_transitions?.paid_at || 0) > (now - 7 * 86400)));
    const existing_fee_dates = new Set(allinv.filter((i: any) => isLateFee(i) && i.created).map((i: any) => etYMD(i.created)));
    const pdinv = inv.filter(isPastDue);
    const rental_pd = pdinv.filter((i: any) => !isLateFee(i));
    const latefee_open = inv.filter(isLateFee);
    const unpaid_latefees = latefee_open.reduce((a: number, i: any) => a + i.amount_remaining, 0) / 100;
    const pd_total = pdinv.reduce((a: number, i: any) => a + i.amount_remaining, 0) / 100;
    if (pdinv.length === 0) { custs.push({ account_label: LABEL, customer_id: cid, name: nm, email: em, phone: ph, sub_status: s.status, open_count: inv.length, pastdue_count: 0, outstanding: 0, state: "current", flag: "none", disconnect_notice_at: null, updated_at: nowISO }); return; }
    for (const i of rental_pd) {
      const dd = i.due_date || i.created || now;
      const feedays = [etYMD(dd), etYMD(dd + 86400)];
      if (feedays.some((f) => existing_fee_dates.has(f))) continue;
      feedays.forEach((f) => existing_fee_dates.add(f));
      const ln = (i.lines?.data || [{}])[0] || {};
      const rdesc = i.description || ln.description || "Rental";
      const num = i.number || i.id;
      const fdate = i.created ? etMDY(i.created) : "—";
      const memo = `Late fee — rental invoice ${num} (generated ${fdate}) past due (${rdesc}). A one-time $10 late fee applies to each rental invoice not paid by its due date. If you plan to continue the rental with us today, please make sure you catch up your account today. — Rent 2 Go LLC`;
      fees.push({ invoice_id: i.id, account_label: LABEL, customer_id: cid, fee: 10, status: "proposed", invoice_number: num, rental_desc: rdesc.slice(0, 90), for_date: fdate, memo });
    }
    const disc = (rental_pd.length >= 3) || (unpaid_latefees >= 70 && rental_pd.length >= 2);
    const current_open = inv.filter((i: any) => !isPastDue(i));
    const current_amt = current_open.reduce((a: number, i: any) => a + i.amount_remaining, 0) / 100;
    const grandtot = Math.round((pd_total + current_amt) * 100) / 100;
    const pdRent = pdinv.filter((x: any) => !isLateFee(x)).sort((a: any, b: any) => (a.created || 0) - (b.created || 0));
    const pdLF = pdinv.filter((x: any) => isLateFee(x)).sort((a: any, b: any) => (a.created || 0) - (b.created || 0));
    const pdRentAmt = pdRent.reduce((a: number, i: any) => a + i.amount_remaining, 0) / 100;
    const pdLFAmt = pdLF.reduce((a: number, i: any) => a + i.amount_remaining, 0) / 100;
    const curSorted = current_open.sort((a: any, b: any) => (a.created || 0) - (b.created || 0));
    const parts: string[] = [];
    if (pdRent.length) parts.push("Past-due rental invoices:\n\n" + pdRent.map((i: any) => invline(i, "❌")).join("\n\n") + "\n\nPast-due rentals subtotal: " + m(pdRentAmt));
    if (pdLF.length) parts.push("Past-due late fees:\n\n" + pdLF.map((i: any) => invline(i, "❌")).join("\n\n") + "\n\nPast-due late fees subtotal: " + m(pdLFAmt));
    if (curSorted.length) parts.push("Current — coming due today (not yet late):\n\n" + curSorted.map((i: any) => invline(i, "✅")).join("\n\n") + "\n\nCurrent subtotal: " + m(current_amt));
    parts.push("💰 Total balance: " + m(grandtot));
    const pd_lines = parts.join("\n\n");
    let subj = "", intro = "", closing = "", kind = "reminder", state = "reminder", flag = "none", dnote: string | null = null;
    if (disc) {
      subj = "Action needed today to keep your Rent 2 Go rental active — " + m(pd_total) + " outstanding";
      intro = `Good morning ${nm},\n\nWe'd love to keep you on the road. Our records show ${m(pd_total)} is currently outstanding on your Rent 2 Go rental, which unfortunately places it at risk of being paused later today.`;
      closing = "To avoid any interruption, we kindly ask that the balance be settled by 1:00 PM today — simply tap Pay now above. If you've already paid, or you'd like to arrange a payment plan, just reply and we'll be glad to help.";
      kind = "disconnect"; state = "disconnect"; flag = "disconnect"; dnote = nowISO;
    } else if (rental_pd.length > 0 && pd_total > 250) {
      subj = "Important — your Rent 2 Go account needs prompt attention (" + m(pd_total) + " past due)";
      intro = `Good morning ${nm},\n\n${paidrecent ? "Thank you for your recent payment. " : ""}Your Rent 2 Go account now stands at ${m(pd_total)} past due — a balance that needs your prompt attention today.`;
      closing = "If you intend to continue the rental with us today, it is imperative that you catch up your account as soon as possible — to avoid service interruption as well as vehicle recovery. Please tap Pay now on any invoice above to settle without delay.";
    } else if (rental_pd.length > 0) {
      subj = "A friendly reminder about your Rent 2 Go balance — " + m(pd_total) + " outstanding";
      intro = `Good morning ${nm} 👋\n\n${paidrecent ? APPREC_PAID : APPREC_GEN}We just wanted to gently let you know that ${m(pd_total)} is currently outstanding on your rental. Settling it at your earliest convenience will keep everything active and in good standing.`;
      closing = "Whenever you're ready, simply tap Pay now on any invoice above. If you have any questions, we're always happy to help.";
    } else if (unpaid_latefees >= 70) {
      subj = "A quick note about your Rent 2 Go account — " + m(unpaid_latefees) + " in late fees";
      intro = `Good morning ${nm} 👋\n\nWe wanted to gently flag that your late fees have now added up to ${m(unpaid_latefees)}. Clearing these when you're able will keep your account comfortably in good standing and help avoid any interruption down the line.`;
      closing = "Whenever it's convenient, simply tap Pay now above. Please don't hesitate to reach out if there's anything we can do to help.";
    } else {
      subj = "A gentle reminder about your Rent 2 Go account — " + m(pd_total) + " in late fees";
      intro = `Good morning ${nm} 👋\n\n${paidrecent ? APPREC_PAID : APPREC_GEN}Just a gentle reminder that there's ${m(pd_total)} in late fees on your account whenever you have a moment to take care of it.`;
      closing = "Whenever you're ready, simply tap Pay now above. Please reach out anytime if we can help.";
    }
    const body = intro + "\n\n" + pd_lines + "\n\n" + closing + "\n\nThank you so much for your urgent attention to this matter.\n\nRent 2 Go" + FOOTER;
    if (!skipset.has(cid) && !keepset.has(cid)) drafts.push({ account_label: LABEL, customer_id: cid, customer_name: nm, email: em, phone: ph, kind, channel: "email", subject: subj, body, amount: Math.round(pd_total * 100) / 100, status: "draft" });
    custs.push({ account_label: LABEL, customer_id: cid, name: nm, email: em, phone: ph, sub_status: s.status, open_count: inv.length, pastdue_count: rental_pd.length, outstanding: Math.round(pd_total * 100) / 100, state, flag, disconnect_notice_at: dnote, updated_at: nowISO });
  }));

  if (custs.length) await sbPost(`linda_customers?on_conflict=account_label,customer_id`, custs, "resolution=merge-duplicates,return=minimal");
  if (fees.length) await sbPost(`linda_fees?on_conflict=invoice_id`, fees, "resolution=ignore-duplicates,return=minimal");
  if (payments.length) await sbPost(`linda_payments?on_conflict=invoice_id`, payments, "resolution=merge-duplicates,return=minimal");
  if (drafts.length) await sbPost(`linda_drafts`, drafts, "return=minimal");
  return { account: LABEL, active: custs.length, notices: drafts.length, disc: drafts.filter((d) => d.kind === "disconnect").length, fees: fees.length, payments: payments.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") || "";
  const tok = auth.replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* ignore */ } }
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const results = [];
    for (const acc of ACCTS) { try { results.push(await scanAccount(acc)); } catch (e) { results.push({ account: acc.label, error: String(e) }); } }
    const total = results.reduce((a: any, r: any) => ({ active: a.active + (r.active || 0), notices: a.notices + (r.notices || 0), disc: a.disc + (r.disc || 0), fees: a.fees + (r.fees || 0), payments: a.payments + (r.payments || 0) }), { active: 0, notices: 0, disc: 0, fees: 0, payments: 0 });
    return new Response(JSON.stringify({ ok: true, ranAt: nowISO, total, accounts: results }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
});
