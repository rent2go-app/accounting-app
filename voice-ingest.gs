/**
 * Rent 2 Go — port incoming customer texts (Google Voice / Quo) into the accounting app.
 *
 * SETUP (one time):
 *  1) Google Voice → Settings → Messages → tick "Forward messages to email" (to this Gmail).
 *  2) https://script.google.com → New project → paste this file → Save → run installTrigger() once, authorise.
 * It then checks every 5 minutes and posts new texts into Linda's Incoming Messages log.
 *
 * NOTE: LABEL is 'r2g-ingest2' so it re-processes the last 2 days with the fixed parser. Leave it.
 */
var CONFIG = {
  FN_URL: 'https://fsapfxhyjbgxjydahdlx.supabase.co/functions/v1/ingest-message',
  TOKEN:  'msgin_c8cde3405f4c643664d9503181aacb42',
  GV_QUERY: 'from:(voice-noreply@google.com) newer_than:2d',
  LABEL: 'r2g-ingest2'
};

function installTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='ingestNow') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('ingestNow').timeBased().everyMinutes(5).create();
  ingestNow();
}

function ingestNow(){
  var label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  var threads = GmailApp.search(CONFIG.GV_QUERY + ' -label:' + CONFIG.LABEL, 0, 50);
  threads.forEach(function(th){
    th.getMessages().forEach(function(m){
      try { var p = parseGV(m); if (p.body || p.from) postMsg(p); } catch (e) {}
    });
    th.addLabel(label);
  });
}

function parseGV(m){
  var subj = m.getSubject() || '';
  // Subject is "New text message from <name-or-number>"
  var sender = subj.replace(/^(New (text|group)\s*(message|messages)?\s*from|SMS from|Text message from|New voicemail from|Missed call from)\s*/i, '')
                   .replace(/\s*[-–:].*$/, '').trim();
  var phone = (sender.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/) || [])[0] || '';
  var name  = phone ? '' : sender;

  // Google Voice notifications are HTML. If the "plain" body is empty or looks like markup, use the HTML and strip tags.
  var raw = m.getPlainBody() || '';
  if (raw.replace(/\s/g, '').length < 3 || /<[a-z!\/]/i.test(raw)) {
    raw = (m.getBody() || raw).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  raw = raw.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;|&#8217;/gi, "'")
           .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  // keep only the message text, drop Google Voice boilerplate/footer
  var body = raw.split(/To respond to this (text )?message|YOUR ACCOUNT|https?:\/\/voice\.google\.com|Get the Google Voice app|This message was sent to/i)[0];
  body = body.replace(/\s+/g, ' ').trim();
  // strip a leading repeat of the sender number if present
  if (phone) body = body.replace(new RegExp('^\\s*\\(?' + phone.replace(/[^\d]/g, '').slice(-10) + '\\)?\\s*'), '').trim();

  return { source:'google_voice', from:phone, name:name, body:(body || '(could not read message text)'),
           received_at:m.getDate().toISOString(), ext_id:'gv_' + m.getId() };
}

function postMsg(p){
  UrlFetchApp.fetch(CONFIG.FN_URL, {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    headers:{ 'x-ingest-token': CONFIG.TOKEN },
    payload: JSON.stringify(p)
  });
}
