/**
 * Rent 2 Go — port incoming customer texts (Google Voice / Quo) into the accounting app.
 *
 * SETUP (one time):
 *  1) Google Voice → Settings → Messages → tick "Forward messages to email" (to this Gmail).
 *  2) https://script.google.com → New project → paste this file → Save → run installTrigger() once, authorise.
 * It then checks every 5 minutes and posts new texts into Linda's Incoming Messages log.
 *
 * NOTE: LABEL is 'r2g-ingest3' so it re-processes the last 2 days with the corrected parser. Leave it.
 */
var CONFIG = {
  FN_URL: 'https://fsapfxhyjbgxjydahdlx.supabase.co/functions/v1/ingest-message',
  TOKEN:  'msgin_c8cde3405f4c643664d9503181aacb42',
  GV_QUERY: 'from:(txt.voice.google.com OR voice-noreply@google.com) newer_than:2d',
  LABEL: 'r2g-ingest3'
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
  var fromRaw = m.getFrom() || '';

  // Most reliable: the sender's number is the 2nd segment of the Google Voice address
  //   <your-GV-number>.<sender-number>.<random>@txt.voice.google.com
  var num = '';
  var vm = fromRaw.match(/\.(\d{10,15})\.[^.@]+@txt\.voice\.google\.com/i);
  if (vm) num = vm[1];
  if (!num) { var sp = subj.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/); if (sp) num = sp[0]; }
  var digits = (num || '').replace(/[^\d]/g, '');
  var phone = digits ? ('+' + (digits.length === 10 ? '1' : '') + digits) : '';

  // Name = subject minus the "New text message from" prefix minus a trailing phone number
  var name = subj.replace(/^New (text|group|voicemail|missed call)\s*(message|messages)?\s*from\s*/i, '')
                 .replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\s*$/, '').trim();

  // Body: plain text is clean; if it's HTML-only, strip tags. Drop the "Google Voice" header + footer.
  var raw = m.getPlainBody() || '';
  if (raw.replace(/\s/g, '').length < 3 || /<[a-z!\/]/i.test(raw)) {
    raw = (m.getBody() || raw).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  raw = raw.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;|&#8217;/gi, "'").replace(/&quot;/gi, '"');
  var body = raw.split(/To respond to this (text )?message|YOUR ACCOUNT|https?:\/\/voice\.google\.com|This email was sent to you/i)[0];
  body = body.replace(/^\s*Google Voice\s*/i, '').replace(/\s+/g, ' ').trim();

  return { source:'google_voice', from:phone, name:name, body:(body || '(no message text)'),
           received_at:m.getDate().toISOString(), ext_id:'gv_' + m.getId() };
}

function postMsg(p){
  UrlFetchApp.fetch(CONFIG.FN_URL, {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    headers:{ 'x-ingest-token': CONFIG.TOKEN },
    payload: JSON.stringify(p)
  });
}
