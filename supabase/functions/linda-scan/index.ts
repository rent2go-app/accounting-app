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
const monthKey = todaystr.slice(0, 7); // YYYY-MM (ET)
const monthStart = Math.floor(new Date(`${monthKey}-01T00:00:00${etOffset(new Date())}`).getTime() / 1000);
function m(x: number) { return "$" + x.toFixed(2); }
const enc = encodeURIComponent;

async function sbGet(path: string) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); return r.ok ? await r.json() : []; }
async function sbDel(path: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "DELETE", headers: { apikey: SR, Authorization: `Bearer ${SR}` } }); }
async function sbPost(path: string, body: unknown, prefer: string) { await fetch(`${SB}/rest/v1/${path}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", Prefer: prefer }, body: JSON.stringify(body) }); }
async function stripe(url: string, key: string) { const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "linda" } }); return await r.json(); }
async function stripeAll(base: string, key: string) { let out: any[] = [], sa: string | null = null; while (true) { const d = await stripe(base + (sa ? `&starting_after=${sa}` : ""), key); const rows = d.data || []; out = out.concat(rows); if (d.has_more && rows.length) sa = rows[rows.length - 1].id; else break; } return out; }

// A $10 invoice is a late fee (rentals are ~$70+). Description text varies ("late fee", "Past Due", etc.) so amount is the reliable signal.
function isLateFee(i: any) { return i.amount_due === 1000; }
function isPastDue(i: any) {
  // Late fees are due the SAME day they're raised → past due once created before today (ignore a stray future due date).
  if (isLateFee(i)) return (i.due_date && i.due_date < now) || (etYMD(i.created || now) < todaystr);
  const dd = i.due_date; return dd ? (dd < now) : ((now - (i.created || now)) > 86400);
}
function cleanlbl(s: string) { s = (s || "Rental").trim(); if (s.includes("×")) s = s.split("×")[1].trim(); const p = s.indexOf("(at "); if (p > 0) s = s.slice(0, p).trim(); return s; }
function invline(i: any, icon: string) { const lbl = isLateFee(i) ? "Late fee" : cleanlbl((i.lines?.data || [{}])[0]?.description || i.description || "Rental"); const gen = i.created ? etMD(i.created) : "—"; const url = i.hosted_invoice_url || ""; return `${icon} ${gen} · ${lbl.slice(0, 34)} · ${m((i.amount_remaining || 0) / 100)}${url ? ` · [Pay now](${url})` : ""}`; }
function footer(portal: string) { return portal ? `\n\n💳 Manage & pay anytime in your [Customer Portal](${portal}) — sign in with your email on file.` : `\n\nManage & pay from your customer portal — sign in with your email on file.`; }
const APPREC_PAID = "Thank you so much for your recent payment — we truly appreciate you keeping up with your account. ";
const APPREC_GEN = "Thank you for being a valued Rent 2 Go customer — we really appreciate your efforts to stay on top of your account. ";
const LATEFEE_NOTE = "Please note that a $10 late fee has been applied to your past-due balance. We strongly recommend settling your account as soon as possible to avoid further penalties or a service interruption.";

async function scanAccount(acc: any) {
  const LABEL = acc.label, SKEY = acc.key, FOOTER = footer(acc.portal || "");
  const aL = "account_label=eq." + enc(LABEL);
  const MID = enc(midnightISO);
  // DAILY RESET (each day starts fresh; TODAY's sent/reviewed are preserved, skipped left to the 3-day snooze):
  await sbDel(`linda_drafts?${aL}&status=eq.sent&sent_at=lt.${MID}`);                            // yesterday's sent
  await sbDel(`linda_drafts?${aL}&status=neq.skipped&sent_at=is.null&created_at=lt.${MID}`);     // yesterday's unsent (draft/reviewed)
  await sbDel(`linda_drafts?${aL}&status=eq.draft&reviewed_at=is.null&created_at=gte.${MID}`);   // today's untouched -> regenerate fresh
  await sbDel(`linda_fees?${aL}&status=eq.proposed`);
  await sbDel(`linda_fees?${aL}&status=eq.dismissed&dismissed_at=lt.${MID}`);   // yesterday's dismissals expire -> fee can return today if still past due
  await sbDel(`linda_drafts?${aL}&status=eq.skipped&skipped_at=lt.${enc(cutoffISO)}`);
  await sbDel(`linda_drafts?${aL}&status=eq.skipped&skipped_at=is.null`);
  const skipset = new Set((await sbGet(`linda_drafts?select=customer_id&${aL}&status=eq.skipped`)).map((r: any) => r.customer_id));
  const keepset = new Set((await sbGet(`linda_drafts?select=customer_id&${aL}&or=(sent_at.gte.${enc(midnightISO)},reviewed_at.gte.${enc(midnightISO)})`)).map((r: any) => r.customer_id));
  // Read EVERY customer's plan flag for this account so the sweep carries it FORWARD verbatim.
  // on_plan/plan_terms are set by the admin (dashboard toggle) and must survive every upsert —
  // we re-write them with their existing values so the badge can never flip off on a scan.
  const planExisting: Record<string, { on_plan: boolean; plan_terms: string | null }> = {};
  const planmap: Record<string, string> = {};
  (await sbGet(`linda_customers?select=customer_id,on_plan,plan_terms&${aL}`)).forEach((r: any) => {
    planExisting[r.customer_id] = { on_plan: !!r.on_plan, plan_terms: r.plan_terms || null };
    if (r.on_plan) planmap[r.customer_id] = r.plan_terms || "2 rental invoices and 2 late fees per day";
  });

  const subs = await stripeAll(`https://api.stripe.com/v1/subscriptions?status=all&limit=100&expand[]=data.customer`, SKEY);
  const active = subs.filter((s: any) => ["active", "past_due", "unpaid", "trialing"].includes(s.status));
  const custs: any[] = [], drafts: any[] = [], fees: any[] = [], payments: any[] = [];

  // WHO to scan = ONLY active-subscription customers. This keeps the workflow current — we do NOT
  // chase the historical open-invoice backlog (old/canceled renters with lingering unpaid invoices).
  const targets = new Map<string, { customer: any; sub_status: string }>();
  for (const s of active) { const c = s.customer || {}; if (c.id) targets.set(c.id, { customer: c, sub_status: s.status }); }
  // TEMPORARY EXCEPTION (JJM only, today): ONE specific renter — Penny Mitchell — switched cars into
  // JJM and already has standalone invoices, but her subscription starts tomorrow. Include ONLY her,
  // by customer id / email — NOT every standalone customer (that wrongly pulled in ended-subscription
  // renters like Cordell). Remove this whole block once Penny's subscription goes live.
  if (LABEL === "RENT 2 GO JJMusa") {
    const PENNY_ID = "cus_UxzNqzVmRub6bS", PENNY_EMAIL = "mitchellpenny746@gmail.com";
    const openInvAll = await stripeAll(`https://api.stripe.com/v1/invoices?status=open&limit=100&expand[]=data.customer`, SKEY);
    for (const i of openInvAll) {
      const co = i.customer;
      const id = typeof co === "string" ? co : (co && co.id);
      const em = (co && typeof co === "object") ? (co.email || "") : "";
      const isPenny = id === PENNY_ID || (em && em.toLowerCase() === PENNY_EMAIL);
      if (isPenny && id && !targets.has(id)) targets.set(id, { customer: (co && typeof co === "object") ? co : { id }, sub_status: "no_subscription" });
    }
  }

  await Promise.all(Array.from(targets.values()).map(async (t: any) => {
    const c = t.customer || {}, cid = c.id, nm = c.name || "(no name)", em = c.email || "", ph = c.phone || "", substatus = t.sub_status;
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
    if (pdinv.length === 0) { custs.push({ account_label: LABEL, customer_id: cid, name: nm, email: em, phone: ph, sub_status: substatus, open_count: inv.length, pastdue_count: 0, outstanding: 0, state: "current", flag: "none", disconnect_notice_at: null, on_plan: !!(planExisting[cid] && planExisting[cid].on_plan), plan_terms: (planExisting[cid] && planExisting[cid].plan_terms) || null, updated_at: nowISO }); return; }
    // ONE $10 late fee per customer — attached to the LATEST past-due rental only.
    // We do NOT back-bill older missed days; only the most recent past-due rental gets a fee.
    const latestPd = rental_pd.slice().sort((a: any, b: any) => ((b.due_date || b.created || 0) - (a.due_date || a.created || 0)))[0];
    if (latestPd) {
      const i = latestPd;
      const dd = i.due_date || i.created || now;
      // a rental's late fee is raised the DAY AFTER it goes past due, so an existing fee lands on due+1 (allow +2 slack)
      const feedays = [etYMD(dd + 86400), etYMD(dd + 2 * 86400)];
      if (!feedays.some((f) => existing_fee_dates.has(f))) {   // skip only if THIS rental already has a fee
        const ln = (i.lines?.data || [{}])[0] || {};
        const veh = cleanlbl(ln.description || i.description || "your rental");
        const num = i.number || i.id;
        const fdate = i.created ? etMDY(i.created) : "—";
        const memo = `One-time $10 late fee for your ${veh} rental — invoice ${num} (${fdate}) was not settled by its due date. This applies once per past-due rental. Please clear your balance to keep your rental in good standing. Thank you — Rent 2 Go LLC`;
        fees.push({ invoice_id: i.id, account_label: LABEL, customer_id: cid, fee: 10, status: "proposed", invoice_number: num, rental_desc: veh.slice(0, 90), for_date: fdate, memo });
      }
    }
    // DISCONNECTION trigger (admin rule, 2026-07-28):
    //  (a) 3+ OPEN rentals with 2+ already past due — i.e. 2 past-due rentals + a current/new open rental; OR
    //  (b) $70+ in open late fees AND 2+ past-due rentals.
    // (Requiring 2+ past due avoids disconnecting a brand-new renter whose open rentals are all still current.)
    const open_rentals = inv.filter((i: any) => !isLateFee(i));   // all unpaid rentals: past-due + current
    // Plan customers are NEVER auto-disconnected here — even if behind, disconnection is a MANUAL
    // recommendation (admin removes them from the plan in the dashboard, which then lets them auto-flag).
    const disc = !planmap[cid] && ((open_rentals.length >= 3 && rental_pd.length >= 2) || (unpaid_latefees >= 70 && rental_pd.length >= 2));
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
    let planBehind = false;
    if (planmap[cid]) {
      const terms = planmap[cid];
      if (/per day/i.test(terms)) {
        // daily catch-up plan — verify yesterday's 2 rentals + 2 late fees
        const yday = etYMD(now - 86400);
        let yRent = 0, yLF = 0;
        for (const iv of allinv) { const pat = iv.status === "paid" ? (iv.status_transitions?.paid_at || 0) : 0; if (pat && etYMD(pat) === yday) { if (isLateFee(iv)) yLF++; else yRent++; } }
        planBehind = !(yRent >= 2 && yLF >= 2);   // didn't pay 2 rentals + 2 late fees yesterday → falling behind the plan
        if (yRent >= 2 && yLF >= 2) {
          subj = "Thank you — your Rent 2 Go payment plan is on track";
          intro = `Good morning ${nm} 👋\n\nThank you for keeping to your payment plan — yesterday we received ${yRent} rental payments and ${yLF} late-fee payments, exactly as agreed. To stay on track, today’s step is again ${terms}.`;
          closing = "Tap Pay now above to make today’s plan payments. Staying on plan steadily clears your balance and keeps you on the road — thank you.";
        } else {
          subj = "⚠ Your Rent 2 Go payment plan — you've fallen behind";
          intro = `Good morning ${nm},\n\nYour payment plan is ${terms}. Yesterday we received ${yRent} rental payment${yRent === 1 ? "" : "s"} and ${yLF} late-fee payment${yLF === 1 ? "" : "s"} — short of your agreed plan, so you have fallen behind. It's important that you catch up today to stay on your plan and in good standing.`;
          closing = "Please tap Pay now on the invoices above to bring your plan back on track today. If you don't get back on track, your account may be recommended for disconnection. If anything has changed, reach out right away to arrange payments or discuss a plan of action.";
        }
      } else {
        // custom plan (e.g. clear a balance by a date) — on track vs behind is judged on whether the past-due is growing
        planBehind = rental_pd.length >= 2;   // multiple past-due rentals while on a custom plan → falling behind
        if (planBehind) {
          subj = "⚠ Your Rent 2 Go payment plan — you're falling behind";
          intro = `Good morning ${nm},\n\nYour agreed payment plan is: ${terms}. Your past-due balance is growing (${rental_pd.length} past-due rentals), which means you're falling behind your plan. Please catch up today to stay in good standing.`;
          closing = "Please tap Pay now on any invoice above to get back on plan today. If you don't, your account may be recommended for disconnection. If anything has changed, reach out right away to arrange payments or discuss a plan of action.";
        } else {
          subj = "Your Rent 2 Go payment plan — a friendly reminder";
          intro = `Good morning ${nm} 👋\n\nJust a friendly reminder of your agreed payment plan: ${terms}. Every payment brings your balance down — please keep to your plan to stay in good standing.`;
          closing = "Tap Pay now on any invoice above to make a payment toward your plan. If anything has changed, just reply and we'll work with you.";
        }
      }
      // Plan customers are NEVER disconnected, no matter how many invoices are open — but if they
      // missed yesterday's 2 rentals + 2 late fees, mark them "falling behind their plan" so it's visible.
      kind = "reminder"; state = planBehind ? "plan_behind" : "plan"; flag = "none"; dnote = null;
    } else if (disc) {
      subj = "⛔ FINAL NOTICE — your Rent 2 Go rental is scheduled for disconnection today (" + m(pd_total) + " past due)";
      intro = `${nm},\n\nThis is a FINAL NOTICE. Your Rent 2 Go rental is ${m(pd_total)} past due (${rental_pd.length} past-due rental invoices) and is scheduled for DISCONNECTION today. To keep your vehicle, your account must be brought fully current right away.`;
      closing = "Tap Pay now on every invoice above to settle immediately. If you intend to keep the vehicle, reach out right away to arrange payments or discuss a plan of action — otherwise recovery will proceed.";
      kind = "disconnect"; state = "disconnect"; flag = "disconnect"; dnote = nowISO;
    } else if (rental_pd.length > 0 && pd_total > 250) {
      subj = "Important — your Rent 2 Go account needs prompt attention (" + m(pd_total) + " past due)";
      intro = `Good morning ${nm},\n\nYour Rent 2 Go account now stands at ${m(pd_total)} past due — a balance that needs your prompt attention today.`;
      closing = "If you intend to continue the rental with us today, it is imperative that you catch up your account as soon as possible — to avoid service interruption as well as vehicle recovery. Please tap Pay now on any invoice above to settle without delay.";
    } else if (rental_pd.length >= 2) {
      subj = "Your Rent 2 Go account is past due — " + m(pd_total);
      intro = `Good morning ${nm},\n\nYour Rent 2 Go rental is ${m(pd_total)} past due (${rental_pd.length} days${unpaid_latefees > 0 ? ", plus " + m(unpaid_latefees) + " in late fees" : ""}). Please cure your balance as soon as possible, or reach out so we can discuss a way forward.`;
      closing = "Tap Pay now on any invoice above to settle. If you can't clear it today, reach out right away to arrange payments or discuss a plan of action.";
    } else if (rental_pd.length > 0) {
      subj = "A reminder about your Rent 2 Go balance — " + m(pd_total) + " past due";
      intro = `Good morning ${nm} 👋\n\nJust a quick reminder that ${m(pd_total)} is now past due on your rental. Settling it today keeps everything active and in good standing.`;
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
    // Whenever there are past-due RENTALS, remind them a $10 late fee applies and to settle ASAP to
    // avoid further penalties / service interruption. Skip for disconnect (its own stronger language)
    // and for plan customers (they're on an agreed catch-up plan).
    if (rental_pd.length > 0 && kind !== "disconnect" && !planmap[cid]) closing = closing + " " + LATEFEE_NOTE;
    const body = intro + "\n\n" + pd_lines + "\n\n" + closing + "\n\nThank you so much for your urgent attention to this matter.\n\nRent 2 Go" + FOOTER;
    if (!skipset.has(cid) && !keepset.has(cid)) drafts.push({ account_label: LABEL, customer_id: cid, customer_name: nm, email: em, phone: ph, kind, channel: "email", subject: subj, body, amount: Math.round(pd_total * 100) / 100, status: "draft" });
    custs.push({ account_label: LABEL, customer_id: cid, name: nm, email: em, phone: ph, sub_status: substatus, open_count: inv.length, pastdue_count: rental_pd.length, outstanding: Math.round(pd_total * 100) / 100, state, flag, disconnect_notice_at: dnote, on_plan: !!(planExisting[cid] && planExisting[cid].on_plan), plan_terms: (planExisting[cid] && planExisting[cid].plan_terms) || null, updated_at: nowISO });
  }));

  if (custs.length) await sbPost(`linda_customers?on_conflict=account_label,customer_id`, custs, "resolution=merge-duplicates,return=minimal");
  if (fees.length) await sbPost(`linda_fees?on_conflict=invoice_id`, fees, "resolution=ignore-duplicates,return=minimal");
  if (payments.length) await sbPost(`linda_payments?on_conflict=invoice_id`, payments, "resolution=merge-duplicates,return=minimal");
  if (drafts.length) await sbPost(`linda_drafts`, drafts, "return=minimal");
  await sbPost(`linda_accounts?on_conflict=label`, [{ label: LABEL, active: custs.length, notices: drafts.length, scanned_at: nowISO }], "resolution=merge-duplicates,return=minimal");

  // FLEET FINANCIALS — per-vehicle daily payment map for the current ET calendar month (bill-driven)
  const finv = await stripeAll(`https://api.stripe.com/v1/invoices?created%5Bgte%5D=${monthStart}&limit=100&expand[]=data.customer`, SKEY);
  const rentals: Record<string, any> = {};
  const lateByCust: Record<string, any[]> = {};   // cid -> [{day,amount}] of PAID late fees this month
  for (const i of finv) {
    const c = i.customer || {};
    const cid = (typeof c === "object" ? c.id : c) || "?";
    const paid = i.status === "paid";
    if (isLateFee(i)) {                        // paid late fees add to the car's bottom line (attributed below)
      if (paid) { const pat = i.status_transitions?.paid_at || i.created; (lateByCust[cid] = lateByCust[cid] || []).push({ day: etYMD(pat), amount: (i.amount_paid || 0) / 100 }); }
      continue;
    }
    if ((i.amount_due || 0) <= 0) continue;
    const nm = (typeof c === "object" ? (c.name || "") : "") || "(no name)";
    const ln = (i.lines?.data || [{}])[0] || {};
    const vehicle = cleanlbl(ln.description || i.description || "Rental");
    if (/deposit|toll|late\s*fee|past\s*due|balance|\bcharge/i.test(vehicle)) continue;  // skip non-vehicle line items
    const day = etYMD(i.created);
    const amt = (paid ? (i.amount_paid || 0) : (i.amount_due || 0)) / 100;
    const key = cid + "|" + vehicle;
    if (!rentals[key]) rentals[key] = { cid, nm, vehicle, days: {} as Record<string, any> };
    const prev = rentals[key].days[day];
    rentals[key].days[day] = { p: ((prev && prev.p) || paid) ? 1 : 0, a: Math.max(prev ? prev.a : 0, amt), lf: prev ? (prev.lf || 0) : 0 };
  }
  // attribute each customer's paid late fees to their primary (most-billed) vehicle for the month
  for (const cid in lateByCust) {
    const keys = Object.keys(rentals).filter((k) => rentals[k].cid === cid);
    if (!keys.length) continue;
    keys.sort((a, b) => Object.keys(rentals[b].days).length - Object.keys(rentals[a].days).length);
    const r = rentals[keys[0]];
    for (const lf of lateByCust[cid]) { const d = r.days[lf.day] = r.days[lf.day] || { p: 0, a: 0 }; d.lf = (d.lf || 0) + lf.amount; }
  }
  const r2f = (x: number) => Math.round(x * 100) / 100;
  const fleetRows = Object.values(rentals).map((r: any) => {
    const dv = Object.values(r.days) as any[];
    const income = dv.filter((d) => d.p).reduce((s, d) => s + d.a, 0);
    const lf_income = dv.reduce((s, d) => s + (d.lf || 0), 0);
    return { account_label: LABEL, vehicle: r.vehicle, customer_id: r.cid, customer_name: r.nm, month: monthKey, days: r.days, days_paid: dv.filter((d) => d.p).length, days_billed: dv.length, income: r2f(income), lf_income: r2f(lf_income), lf_days: dv.filter((d) => (d.lf || 0) > 0).length, updated_at: nowISO };
  });
  if (fleetRows.length) await sbPost(`fleet_performance?on_conflict=account_label,vehicle,customer_id,month`, fleetRows, "resolution=merge-duplicates,return=minimal");

  return { account: LABEL, active: custs.length, notices: drafts.length, disc: drafts.filter((d) => d.kind === "disconnect").length, fees: fees.length, payments: payments.length, fleet: fleetRows.length, outstanding: Math.round(custs.reduce((s: number, c: any) => s + (+c.outstanding || 0), 0) * 100) / 100, pastdue_cust: custs.filter((c: any) => (c.pastdue_count || 0) > 0).length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") || "";
  const tok = auth.replace("Bearer ", "");
  let ok = tok === SR;
  if (!ok) { try { const p = JSON.parse(atob(tok.split(".")[1])); if (p.role === "service_role") ok = true; else if (p.email && ADMINS.includes(String(p.email).toLowerCase())) ok = true; } catch (_) { /* ignore */ } }
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const body = await req.json().catch(() => ({}));

    // ── ONE-TIME ASSIST: Penny Mitchell combined notice (today only) ──────────────────
    // Penny switched cars; her JJM subscription starts tomorrow. She has 2 standalone JJM invoices
    // (one dated for yesterday 27th = past due, one for today 28th) PLUS a past-due balance on her
    // previous account (LLC 2.0, on a plan to clear $246 by 1 Aug). Build ONE combined notice with
    // real Pay-now links from BOTH accounts and insert it as a draft for review. This is a manual,
    // single-use exception — not part of the normal sweep.
    if (body.penny_oneoff) {
      const jjm = ACCTS.find((a: any) => a.label === "RENT 2 GO JJMusa");
      const llc = ACCTS.find((a: any) => a.label === "RENT 2 GO LLC 2.0");
      if (!jjm || !llc) return new Response(JSON.stringify({ error: "JJM or LLC 2.0 account not found in LINDA_ACCOUNTS" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      const PENNY_JJM = "cus_UxzNqzVmRub6bS", PENNY_LLC = "cus_Ui1U2mD77s5YP6";
      const jInv = (await stripeAll(`https://api.stripe.com/v1/invoices?customer=${PENNY_JJM}&status=open&limit=100`, jjm.key)).sort((a: any, b: any) => (a.created || 0) - (b.created || 0));
      const lInv = (await stripeAll(`https://api.stripe.com/v1/invoices?customer=${PENNY_LLC}&status=open&limit=100`, llc.key)).filter((i: any) => (i.amount_remaining || 0) > 0);
      // JJM: oldest = the "for yesterday (27th)" invoice → treat as past due; the rest (28th) → current.
      const jPast = jInv.slice(0, Math.max(1, jInv.length - 1));
      const jCurr = jInv.slice(Math.max(1, jInv.length - 1));
      const lPast = lInv.filter(isPastDue);
      const jPastAmt = jPast.reduce((a: number, i: any) => a + (i.amount_remaining || 0), 0) / 100;
      const jCurrAmt = jCurr.reduce((a: number, i: any) => a + (i.amount_remaining || 0), 0) / 100;
      const lPastAmt = lPast.reduce((a: number, i: any) => a + (i.amount_remaining || 0), 0) / 100;
      const grand = Math.round((jPastAmt + jCurrAmt + lPastAmt) * 100) / 100;
      // Both JJM invoices were created today (the "27th" one was generated today with a note that it's
      // for yesterday), so their created-date reads Jul 28. Force the business dates: past-due = Jul 27, current = Jul 28.
      const jline = (i: any, icon: string, dateLabel: string) => { const lbl = cleanlbl((i.lines?.data || [{}])[0]?.description || i.description || "Rental"); const url = i.hosted_invoice_url || ""; return `${icon} ${dateLabel} · ${lbl.slice(0, 34)} · ${m((i.amount_remaining || 0) / 100)}${url ? ` · [Pay now](${url})` : ""}`; };
      const P: string[] = [];
      P.push("Good morning Penny 👋\n\nWelcome to your new vehicle! Here's a quick summary of everything outstanding across your Rent 2 Go accounts so we can get you set up cleanly before your new plan begins tomorrow.");
      P.push("① Your new rental account:");
      if (jPast.length) P.push("Past due (for July 27):\n\n" + jPast.map((i: any) => jline(i, "❌", "Jul 27")).join("\n\n"));
      if (jCurr.length) P.push("Due today (July 28):\n\n" + jCurr.map((i: any) => jline(i, "✅", "Jul 28")).join("\n\n"));
      P.push("Pay these in your new account portal:" + footer(jjm.portal || "").replace(/^\n\n/, "\n"));
      P.push("② Your previous account balance:");
      if (lPast.length) P.push("Past due (please clear per your plan — the agreed $246 before 1 August):\n\n" + lPast.map((i: any) => invline(i, "❌")).join("\n\n") + "\n\nPast-due subtotal: " + m(lPastAmt));
      else P.push("No past-due invoices remain on your previous account — thank you.");
      P.push("Pay these in your previous account portal:" + footer(llc.portal || "").replace(/^\n\n/, "\n"));
      P.push("💰 Total across both accounts: " + m(grand));
      P.push("Please settle today, or reach out right away to arrange payments or discuss a plan of action. Thank you, Penny — we're glad to have you back on the road.\n\nRent 2 Go");
      const pbody = P.join("\n\n");
      const em = "mitchellpenny746@gmail.com";
      // preserve across today's resets: mark reviewed so the daily reset + keepset leave it in place
      await sbDel(`linda_drafts?account_label=eq.${enc("RENT 2 GO JJMusa")}&customer_id=eq.${PENNY_JJM}`);
      await sbPost(`linda_drafts`, [{ account_label: "RENT 2 GO JJMusa", customer_id: PENNY_JJM, customer_name: "PENNY MITCHELL", email: em, phone: "", kind: "reminder", channel: "email", subject: "Your Rent 2 Go accounts — a quick summary before your new plan starts", body: pbody, amount: grand, status: "draft", reviewed_at: nowISO }], "return=minimal");
      return new Response(JSON.stringify({ ok: true, penny: true, jjm_past: jPast.length, jjm_current: jCurr.length, llc_pastdue: lPast.length, total: grand, body: pbody }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    const only = body && body.account;                       // optional: sweep a SINGLE account
    const list = only ? ACCTS.filter((a: any) => a.label === only) : ACCTS;
    const results = [];
    for (const acc of list) { try { results.push(await scanAccount(acc)); } catch (e) { results.push({ account: acc.label, error: String(e) }); } }
    const total = results.reduce((a: any, r: any) => ({ active: a.active + (r.active || 0), notices: a.notices + (r.notices || 0), disc: a.disc + (r.disc || 0), fees: a.fees + (r.fees || 0), payments: a.payments + (r.payments || 0), outstanding: a.outstanding + (r.outstanding || 0), pastdue_cust: a.pastdue_cust + (r.pastdue_cust || 0) }), { active: 0, notices: 0, disc: 0, fees: 0, payments: 0, outstanding: 0, pastdue_cust: 0 });
    // capture the MORNING snapshot once per ET day (full sweep only; first scan wins)
    if (!only) await sbPost(`linda_day?on_conflict=day`, [{ day: todaystr, opening_outstanding: Math.round(total.outstanding * 100) / 100, opening_pastdue_cust: total.pastdue_cust, opening_notices: total.notices, captured_at: nowISO }], "resolution=ignore-duplicates,return=minimal");
    return new Response(JSON.stringify({ ok: true, ranAt: nowISO, only: only || null, total, accounts: results }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
});
