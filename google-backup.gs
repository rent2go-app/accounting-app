/**
 * Rent 2 Go — live ledger backup into this Google Sheet.
 * SETUP (once):
 *   1. In your Google Sheet: Extensions → Apps Script
 *   2. Delete any code, paste ALL of this, and set BACKUP_TOKEN below
 *   3. Run backupNow  (authorize when prompted) — fills the sheet
 *   4. Run installTrigger  — auto-backup every 6 hours, forever
 * Download as .xlsx anytime: File → Download → Microsoft Excel (.xlsx)
 */
const EXPORT_URL   = "https://fsapfxhyjbgxjydahdlx.supabase.co/functions/v1/export-ledger";
const BACKUP_TOKEN = "PASTE_YOUR_TOKEN_HERE";   // <-- from Claude / your notes

function backupNow() {
  const resp = UrlFetchApp.fetch(EXPORT_URL, {
    method: "get",
    headers: { "x-backup-token": BACKUP_TOKEN },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) throw new Error("Export failed: " + resp.getContentText());
  const data = JSON.parse(resp.getContentText());
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let sh = ss.getSheetByName("Ledger") || ss.insertSheet("Ledger");
  sh.clearContents();
  const rows = [["Date", "Type", "Description", "Amount (USD)", "Category", "Paid"]];
  (data.days || []).forEach(function (d) {
    (d.deposits || []).forEach(function (a) { rows.push([d.day, "deposit", "Stripe deposit", a, "", ""]); });
    (d.income   || []).forEach(function (l) { rows.push([d.day, l[2] === "Adjustment" ? "adjustment" : "income", l[0], l[1], l[2] || "", ""]); });
    (d.expenses || []).forEach(function (l) { rows.push([d.day, "expense", l[0], l[1], l[2] || "", l[3] ? "paid" : "unpaid"]); });
  });
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.getRange(1, 1, 1, 6).setFontWeight("bold");
  sh.setFrozenRows(1);

  let info = ss.getSheetByName("Backup Info") || ss.insertSheet("Backup Info");
  info.clearContents();
  info.getRange("A1:B4").setValues([
    ["Rent 2 Go — automatic backup", ""],
    ["Last backup", new Date()],
    ["Days", (data.days || []).length],
    ["Line items", rows.length - 1],
  ]);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "backupNow") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("backupNow").timeBased().everyHours(6).create();
}
