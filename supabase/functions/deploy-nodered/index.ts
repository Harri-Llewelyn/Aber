import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

async function resolveUserRole(
  supabaseUser: ReturnType<typeof createClient>,
  userId: string,
  jwtRole: string | null
): Promise<string | null> {
  const { data } = await supabaseUser
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId)
    .maybeSingle();

  const dbRole = (data as { roles?: { name?: string } } | null)?.roles?.name;
  if (typeof dbRole === "string") return dbRole;
  return jwtRole;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid user token", details: userError?.message }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userRole = await resolveUserRole(
      supabaseUser,
      user.id,
      user.app_metadata?.role || null
    );

    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      return new Response(
        JSON.stringify({ error: "Forbidden: Insufficient privileges" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();

    if (body?.commit_message && !Array.isArray(body)) {
      return new Response(
        JSON.stringify({
          status: "ACCEPTED",
          message: "GitOps sync request accepted; flow deployment requires a Node-RED flow array payload",
        }),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!Array.isArray(body)) {
      return new Response(
        JSON.stringify({ error: "Body must be a Node-RED flow array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nodeRedUrl = Deno.env.get("NODERED_URL") || "http://node-red:1880/flows";
    const nodeRedAdminToken = Deno.env.get("NODERED_ADMIN_TOKEN");

    if (!nodeRedAdminToken) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration: NODERED_ADMIN_TOKEN is not set" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const response = await fetch(nodeRedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nodeRedAdminToken}`,
      },
      body: JSON.stringify(body),
    });

    const responseData = await response.text();

    return new Response(responseData, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Failed to deploy flow to Node-RED", details: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

serve(handler);
