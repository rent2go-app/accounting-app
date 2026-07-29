/**
 * Rent 2 Go — port incoming customer texts (Google Voice / Quo) into the accounting app.
 *
 * SETUP (one time):
 *  1) Google Voice → Settings → Messages → tick "Forward messages to email" (to this Gmail).
 *     (Quo: forward incoming texts to this same Gmail, OR point a Quo/Zapier webhook straight
 *      at FN_URL with header x-ingest-token: <TOKEN> and JSON {source,from,name,body,received_at,ext_id}.)
 *  2) In Gmail: ⚙ → "See all settings" is not needed — go to https://script.google.com → New project,
 *     paste this file, set CONFIG.TOKEN below, then run installTrigger() once and authorise.
 *
 * It then checks every 5 minutes and posts new texts into the Messages log.
 */
var CONFIG = {
  FN_URL: 'https://fsapfxhyjbgxjydahdlx.supabase.co/functions/v1/ingest-message',
  TOKEN:  'PASTE_MSG_INGEST_TOKEN_HERE',          // the MSG_INGEST_TOKEN value
  GV_QUERY: 'from:(voice-noreply@google.com) newer_than:2d',
  LABEL: 'r2g-ingested'
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
  var name = subj.replace(/^New (text|group|voicemail|missed call)\s*(message|messages)?\s*from\s*/i, '').trim();
  var body = (m.getPlainBody() || '').trim();
  body = body.split(/To respond to this text message|YOUR ACCOUNT|https?:\/\/voice\.google\.com/i)[0].trim();
  var rt = (m.getReplyTo() || '') + ' ' + (m.getFrom() || '');
  var phone = (rt.match(/(\+?\d[\d\-\.\(\)\s]{6,})@/) || [])[1]
           || (body.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/) || [])[0] || '';
  return { source:'google_voice', from:phone, name:name, body:body, received_at:m.getDate().toISOString(), ext_id:'gv_' + m.getId() };
}

function postMsg(p){
  UrlFetchApp.fetch(CONFIG.FN_URL, {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    headers:{ 'x-ingest-token': CONFIG.TOKEN },
    payload: JSON.stringify(p)
  });
}
