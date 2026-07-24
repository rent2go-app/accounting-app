// Rent 2 Go — read-only ledger export for external backup (e.g. Google Sheets).
// Auth: a shared secret (BACKUP_TOKEN, stored as a Supabase secret — NOT in this file).
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-backup-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const token = req.headers.get("x-backup-token") || url.searchParams.get("token") || "";
  const expected = Deno.env.get("BACKUP_TOKEN") || "";
  if (!expected || token !== expected)
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: days } = await admin.from("day_blocks").select("day,deposits,income,expenses").order("day");
  const { data: settings } = await admin.from("app_settings").select("*").eq("id", 1).single();
  return new Response(JSON.stringify({ generated_at: new Date().toISOString(), days: days || [], settings }), { headers: { ...cors, "Content-Type": "application/json" } });
});
