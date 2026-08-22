// The Rent 2 Go email shell — one look for every message we send.
//
// Table-based on purpose: Outlook and several Android clients ignore flexbox and
// modern CSS, and a customer email has to survive all of them. Inline styles for
// the same reason — most clients strip <style> blocks.
//
// Usage:
//   import { emailShell, BRAND } from "../_shared/email.ts";
//   const html = emailShell({ title: "…", body: "<p>…</p>", cta: { label: "…", href: "…" } });

export const BRAND = {
  green: "#0f8a4d",
  greenDark: "#0a6b3a",
  ink: "#131820",
  muted: "#5c6a7a",
  line: "#e2e8e4",
  wash: "#f4f7f6",
  logo: "https://rent2go-app.github.io/Rent2Go/assets/logo.png",
  site: "https://rent2go-app.github.io/Rent2Go/",
  address: "9711 David Taylor Drive, Suite 111, Charlotte, NC 28262",
  phone: "980 272 8122",
  email: "info@rentaride2go.com",
  roadside: "(704) 912-0864",
};

export function emailShell(o: {
  title: string;
  body: string;                       // trusted HTML
  preheader?: string;                 // the grey line beside the subject in an inbox
  cta?: { label: string; href: string };
  footnote?: string;
  showRoadside?: boolean;
}) {
  const pre = o.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${o.preheader}</div>`
    : "";
  const cta = o.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">
         <tr><td bgcolor="${BRAND.green}" style="border-radius:8px">
           <a href="${o.cta.href}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;
              font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${o.cta.label}</a>
         </td></tr>
       </table>`
    : "";
  const note = o.footnote
    ? `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:${BRAND.muted}">${o.footnote}</p>`
    : "";
  const roadside = o.showRoadside
    ? `<br>Roadside assistance ${BRAND.roadside}`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${o.title}</title></head>
<body style="margin:0;padding:0;background:${BRAND.wash}">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.wash}">
  <tr><td align="center" style="padding:28px 14px">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px">

      <!-- masthead -->
      <tr><td align="center" style="padding:26px 30px 0">
        <a href="${BRAND.site}" style="text-decoration:none">
          <img src="${BRAND.logo}" width="176" alt="Rent 2 Go"
               style="display:block;width:176px;max-width:60%;height:auto;border:0"></a>
      </td></tr>
      <tr><td style="padding:18px 30px 0">
        <div style="height:3px;background:${BRAND.green};border-radius:3px"></div>
      </td></tr>

      <!-- message -->
      <tr><td style="padding:22px 30px 26px;font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink}">
        <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${BRAND.greenDark}">${o.title}</h1>
        <div style="font-size:15px;line-height:1.6;color:${BRAND.ink}">${o.body}</div>
        ${cta}
        ${note}
      </td></tr>

      <!-- footer -->
      <tr><td style="padding:0 30px"><div style="border-top:1px solid ${BRAND.line}"></div></td></tr>
      <tr><td style="padding:16px 30px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;
                     line-height:1.65;color:${BRAND.muted}">
        <strong style="color:${BRAND.ink}">Rent 2 Go LLC</strong><br>
        ${BRAND.address}<br>
        ${BRAND.phone} &nbsp;·&nbsp; <a href="mailto:${BRAND.email}" style="color:${BRAND.green};text-decoration:none">${BRAND.email}</a>${roadside}
        <div style="margin-top:10px;color:#98a2ae">Long-term car rental in Charlotte, North Carolina.</div>
      </td></tr>
    </table>

  </td></tr>
</table>
</body></html>`;
}

/* A short plain-text version of the same message, for SMS and WhatsApp.
   Kept to a couple of lines — a text that runs past two screens does not get read. */
export function plain(lines: string[]) {
  return lines.filter(Boolean).join(" ");
}
