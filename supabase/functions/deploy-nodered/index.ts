import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

/**
 * Resolve the caller's RBAC role from public.user_roles, or null.
 *
 * public.user_roles IS THE ONLY SOURCE, and the absence of a row means no role.
 *
 * This used to fall back to the `app_metadata.role` claim in the caller's JWT whenever the
 * lookup produced nothing -- which inverted the meaning of a revocation. Deleting a user's
 * user_roles row IS how a role is revoked, so the fallback answered every revocation with the
 * privilege the user held before it, for as long as their existing token remained valid. RLS
 * was unaffected (public.has_role() reads the table), so the database and the edge functions
 * disagreed about who was privileged.
 *
 * The query error is honoured rather than discarded, for the same reason: a failed lookup is
 * not evidence of a role. Both failure modes return null and the caller answers 403.
 *
 * The caller reads its own row under "user_roles_select_own_or_privileged", so an empty result
 * is a real absence and not a policy artefact.
 */
async function resolveUserRole(
  supabaseUser: SupabaseClient<any, any, any>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabaseUser
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error(`role lookup failed for user ${userId}: ${error.message}`);
    return null;
  }

  const dbRole = (data as { roles?: { name?: string } } | null)?.roles?.name;
  return typeof dbRole === "string" ? dbRole : null;
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

    const userRole = await resolveUserRole(supabaseUser, user.id);

    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      return new Response(
        JSON.stringify({ error: "Forbidden: Insufficient privileges" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));

    // ONLY the canonical flow committed to the repository is ever deployed. That is the
    // GitOps contract: git is the source of truth and this endpoint syncs Node-RED to it.
    //
    // THIS USED TO ACCEPT AN ARBITRARY FLOW ARRAY FROM THE REQUEST BODY, which negated the
    // contract stated in the line above it. A Node-RED `function` node executes arbitrary
    // JavaScript inside the Node-RED container -- which holds the MQTT credential and can
    // reach Mosquitto, Supabase and TimescaleDB -- so that branch gave every
    // `Shopfloor_Manager` remote code execution on the edge automation host, and gave it to
    // anyone who could reach the endpoint at all for as long as Kong did not authenticate.
    //
    // Deploying something other than the committed flow is not a capability this endpoint is
    // supposed to have. Editing flows is what the Node-RED editor is for; promoting an edit
    // is what a commit is for.
    const requestedInlineFlow = Array.isArray(body);
    if (requestedInlineFlow) {
      return new Response(
        JSON.stringify({
          error: "Inline flow deployment is not supported",
          details:
            `This endpoint deploys only ${CANONICAL_FLOW_SOURCE} as committed to the ` +
            "repository. Commit the flow and redeploy, or edit it directly in the Node-RED editor.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let flow: unknown[];
    const source = CANONICAL_FLOW_SOURCE;

    try {
      flow = loadCanonicalFlow();
    } catch (readErr) {
      return new Response(
        JSON.stringify({
          error: "Canonical Node-RED flow is unavailable",
          details: readErr instanceof Error ? readErr.message : String(readErr),
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nodeRedUrl = Deno.env.get("NODERED_URL") || "http://node-red:1880/flows";
    const nodeRedAdminToken = Deno.env.get("NODERED_ADMIN_TOKEN");

    // THE REQUEST IS ALWAYS AUTHENTICATED. This used to attach a bearer token only when
    // NODERED_ADMIN_TOKEN was set and send the flow bare otherwise -- which was correct while
    // Node-RED ran without adminAuth, and is exactly the hole that has now been closed. An
    // "only when secured" branch here would keep working against an unsecured Node-RED, so
    // there would be nothing to notice if the settings.js guard ever regressed.
    //
    // The default path forwards THE CALLER'S OWN access token. They were checked against
    // ALLOWED_ROLES above, but Node-RED's adminAuth.tokens() does not take that on trust: it
    // re-derives the role from public.user_roles through the nodered-userinfo edge function, so
    // a revocation takes effect on both sides at once and a token obtained by any other route
    // is judged identically. No shared secret has to exist for the default stack to work.
    //
    // NODERED_ADMIN_TOKEN remains as break-glass, and takes precedence when set: it is what
    // reaches the flows when Supabase Auth, Kong or the edge runtime is down -- which is
    // precisely when the caller's token cannot be validated. Same reasoning as
    // disable_login_form = false in grafana/grafana.ini.
    const nodeRedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Node-RED-Deployment-Type": "full",
      Authorization: nodeRedAdminToken ? `Bearer ${nodeRedAdminToken}` : authHeader,
    };

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
