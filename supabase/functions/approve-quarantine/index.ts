import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isUuid } from "./isUuid.ts";

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
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    const { device_id, gateway_id, merge_into_device_id } = await req.json();

    if (!device_id) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: device_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Suggested-match acceptance: the quarantined row is a device that was already
    // provisioned under a different (correct) name -- e.g. an integrator typo'd the
    // Sparkplug B device name. Rather than un-quarantining the mistyped row, absorb its
    // runtime state into the provisioned row (which may already carry a gateway/schema
    // assignment worth keeping) and discard the quarantined duplicate.
    if (merge_into_device_id) {
      if (merge_into_device_id === device_id) {
        return new Response(
          JSON.stringify({ error: "merge_into_device_id must differ from device_id" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let quarantinedQuery = supabaseAdmin.from("devices").select("*");
      quarantinedQuery = isUuid(device_id)
        ? quarantinedQuery.eq("id", device_id)
        : quarantinedQuery.eq("name", device_id);
      const { data: quarantinedRows, error: quarantinedError } = await quarantinedQuery;

      if (quarantinedError) {
        return new Response(
          JSON.stringify({ error: quarantinedError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const quarantined = quarantinedRows?.[0];
      if (!quarantined) {
        return new Response(
          JSON.stringify({ error: "Quarantined device not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: candidateRows, error: candidateError } = await supabaseAdmin
        .from("devices")
        .select("*")
        .eq("id", merge_into_device_id);

      if (candidateError) {
        return new Response(
          JSON.stringify({ error: candidateError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const candidate = candidateRows?.[0];
      if (!candidate) {
        return new Response(
          JSON.stringify({ error: "Target device not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (candidate.id === quarantined.id) {
        return new Response(
          JSON.stringify({ error: "Cannot merge a device into itself" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // asset_config is keyed by Sparkplug B device name, not id -- re-key the
      // quarantined device's recorded birth parameters onto the candidate's name.
      const { error: rekeyError } = await supabaseAdmin
        .from("asset_config")
        .update({ asset_id: candidate.name })
        .eq("asset_id", quarantined.name);

      if (rekeyError) {
        return new Response(
          JSON.stringify({ error: rekeyError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Absorb the quarantined row's now-known runtime state; leave the candidate's
      // deliberately-provisioned fields (gateway_id, asset_type, connection_method,
      // schema_id) untouched.
      const { data: mergedData, error: mergeError } = await supabaseAdmin
        .from("devices")
        .update({
          status: quarantined.status,
          first_dbirth_at: candidate.first_dbirth_at || quarantined.first_dbirth_at,
          is_quarantined: false
        })
        .eq("id", candidate.id)
        .select();

      if (mergeError) {
        return new Response(
          JSON.stringify({ error: mergeError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { error: deleteError } = await supabaseAdmin
        .from("devices")
        .delete()
        .eq("id", quarantined.id);

      if (deleteError) {
        return new Response(
          JSON.stringify({ error: deleteError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, data: mergedData }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let query = supabaseAdmin
      .from("devices")
      .update({ is_quarantined: false, gateway_id: gateway_id || null });

    if (isUuid(device_id)) {
      query = query.eq("id", device_id);
    } else {
      query = query.eq("name", device_id);
    }

    const { data, error: updateError } = await query.select();

    if (updateError) {
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

serve(handler);
