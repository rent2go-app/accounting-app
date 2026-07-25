// Rent 2 Go — admin user management (Edge Function).
// Holds service_role privately (injected by Supabase at runtime — NEVER in the client).
// Only allow-listed admin emails may call it. Actions: list / create / password / delete.
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_EMAILS = ["gorentaride@gmail.com", "thurstonrdavis@gmail.com"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";

    // who is calling?
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uerr } = await caller.auth.getUser();
    if (uerr || !user) return j(401, { error: "Not signed in." });
    if (!ADMIN_EMAILS.includes((user.email || "").toLowerCase()))
      return j(403, { error: "You are not an administrator." });

    const admin = createClient(url, svcKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "list") {
      const { data, error } = await admin.auth.admin.listUsers();
      if (error) throw error;
      const users = data.users.map((u) => ({
        id: u.id, email: u.email, created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at, is_admin: ADMIN_EMAILS.includes((u.email || "").toLowerCase()),
      }));
      return j(200, { users });
    }
    if (action === "create") {
      if (!body.email || !body.password || String(body.password).length < 8)
        return j(400, { error: "Email and a password of at least 8 characters are required." });
      const { data, error } = await admin.auth.admin.createUser({
        email: body.email, password: body.password, email_confirm: true,
      });
      if (error) throw error;
      return j(200, { ok: true, user: { id: data.user.id, email: data.user.email } });
    }
    if (action === "password") {
      if (!body.user_id || !body.password || String(body.password).length < 8)
        return j(400, { error: "A user and a password of at least 8 characters are required." });
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) throw error;
      return j(200, { ok: true });
    }
    if (action === "delete") {
      if (!body.user_id) return j(400, { error: "user_id required." });
      const { error } = await admin.auth.admin.deleteUser(body.user_id);
      if (error) throw error;
      return j(200, { ok: true });
    }
    return j(400, { error: "Unknown action." });
  } catch (e) {
    return j(500, { error: String((e as Error)?.message || e) });
  }
});
