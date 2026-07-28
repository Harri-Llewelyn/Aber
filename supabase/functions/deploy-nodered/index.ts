import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

// Mounted read-only by docker-compose into this function's own directory. It has
// to live here: an edge-runtime user worker can only read files beneath the
// service path it was booted with, so a sibling directory is not visible to it.
const CANONICAL_FLOW_SOURCE = "node_red_flow.json";

/**
 * Loads the flow definition committed to the repository.
 *
 * The flow arrives via the NODERED_FLOW_JSON environment variable, populated by
 * the supabase-functions entrypoint. It is deliberately NOT read from disk: an
 * edge-runtime user worker has no filesystem access to the mounted volumes, and
 * module-relative paths resolve into an ephemeral compile directory rather than
 * the mount. main/index.ts forwards all env vars to each worker it spawns.
 */
function loadCanonicalFlow(): unknown[] {
  const raw = Deno.env.get("NODERED_FLOW_JSON");

  if (!raw) {
    throw new Error(
      "NODERED_FLOW_JSON is not set; the supabase-functions entrypoint should " +
        `populate it from ${CANONICAL_FLOW_SOURCE}`
    );
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${CANONICAL_FLOW_SOURCE} is not a Node-RED flow array`);
  }
  return parsed;
}

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

    const body = await req.json().catch(() => ({}));

    // Resolve what to deploy.
    //   * An explicit Node-RED flow array is deployed as-is.
    //   * Anything else (the dashboard sends { commit_message }) deploys the
    //     canonical flow committed to the repository. That is the GitOps
    //     contract: git is the source of truth and this syncs Node-RED to it.
    let flow: unknown[];
    let source: string;

    if (Array.isArray(body)) {
      flow = body;
      source = "request payload";
    } else {
      try {
        flow = loadCanonicalFlow();
        source = CANONICAL_FLOW_SOURCE;
      } catch (readErr) {
        return new Response(
          JSON.stringify({
            error: "Canonical Node-RED flow is unavailable",
            details: readErr instanceof Error ? readErr.message : String(readErr),
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const nodeRedUrl = Deno.env.get("NODERED_URL") || "http://node-red:1880/flows";
    const nodeRedAdminToken = Deno.env.get("NODERED_ADMIN_TOKEN");

    // Only send credentials when Node-RED is actually secured. Requiring a token
    // unconditionally made every deploy fail with a 500 on the default stack,
    // where Node-RED runs without adminAuth.
    const nodeRedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Node-RED-Deployment-Type": "full",
    };
    if (nodeRedAdminToken) {
      nodeRedHeaders.Authorization = `Bearer ${nodeRedAdminToken}`;
    }

    const response = await fetch(nodeRedUrl, {
      method: "POST",
      headers: nodeRedHeaders,
      body: JSON.stringify(flow),
    });

    const responseText = await response.text();

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          error: "Node-RED rejected the flow deployment",
          status_code: response.status,
          details: responseText.slice(0, 500),
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        status: "DEPLOYED",
        message: `Deployed ${flow.length} Node-RED nodes from ${source}`,
        nodes_deployed: flow.length,
        source,
        commit_message: typeof body?.commit_message === "string" ? body.commit_message : null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Failed to deploy flow to Node-RED", details: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

serve(handler);
