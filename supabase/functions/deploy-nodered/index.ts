import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";

// ADMINISTRATOR ALONE, since 0069. This is the enforcement point for `gitops:manage`, and it is
// the only one: there is no `deployments` table and therefore no RLS policy to narrow, so the
// permission the Directory page's Sync button is gated on means exactly what this constant says
// and nothing else. Withdrawing the permission without narrowing this list would have hidden the
// button from a role that could still POST to the endpoint.
//
// Shopfloor_Manager came off the list because deploying is a platform act rather than a shopfloor
// one -- a flow reaches the Node-RED container, which holds the MQTT credential and can address
// Mosquitto, Supabase and TimescaleDB. The inline-flow refusal below already narrowed what this
// endpoint can deploy; this narrows who can ask it to.
const ALLOWED_ROLES = ["Administrator"];

// The name of the committed flow, used only in messages -- the content arrives via the
// environment (see loadCanonicalFlow below), never off disk.
//
// This previously read "it has to live here: an edge-runtime user worker can only read files
// beneath the service path it was booted with, so a sibling directory is not visible to it".
// That reasoning does NOT hold for module imports -- `../_shared/roles.ts` above is proof -- and
// it was the stated basis for duplicating the role lookup into every function. It may still hold
// for reading FILES at runtime, which is a different mechanism and a different permission, and
// which is why the flow still travels as NODERED_FLOW_JSON rather than being read from the mount.
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
