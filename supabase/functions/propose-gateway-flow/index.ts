import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { corsHeaders } from "../_shared/cors.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { forgeConfig, proposeFlow, repositoryNameFor } from "../_shared/forge.ts";

/**
 * Propose a Node-RED flow for a gateway: a commit on a branch, and a pull request to review it.
 *
 * THIS IS THE UPLOAD BECOMING A COMMIT (roadmap 7). `FlowBackupUploader` puts a `flows.json` in a
 * private bucket, where it is a backup and nothing else -- no diff, no history, no review. The same
 * file sent here lands on a branch in the gateway's own repository with a pull request open against
 * it, which is what makes the forge's three states mean something: an open request is *pending
 * approval*, a merge is *approved*, and a revert commit is *undo*.
 *
 * -------------------------------------------------------------------------------------------------
 * IT NEVER WRITES TO `main`, AND THAT IS THE WHOLE SECURITY ARGUMENT.
 *
 * The appliance converges to whatever `main` holds. A function that could commit there directly
 * would deploy an unreviewed flow the moment somebody pressed a button -- which is precisely the
 * `deploy-nodered` endpoint this item retired, rebuilt with a friendlier name. A Node-RED `function`
 * node is arbitrary JavaScript running in a container that holds the MQTT credential, so "deploy
 * only what is committed" has to mean "committed AND merged by somebody who may merge".
 *
 * MERGING IS NOT HERE. It is `gitops:manage`'s act and belongs with the approvals page (6). Nothing
 * in this function can approve anything, which is what keeps proposing and approving two privileges
 * rather than one.
 *
 * -------------------------------------------------------------------------------------------------
 * WHO MAY PROPOSE, AND WHY IT INCLUDES `Operator`.
 *
 * Roadmap 7 is explicit that a review step whose proposals can only come from the two roles that may
 * already merge them is a formality rather than a gate. `Operator` is the role this exists for: it
 * looks at gateways all day, cannot edit them, and -- since 0086 -- has exactly one write, which is
 * to a queue. This is the flow lane of that idea, with the forge holding the queue.
 *
 * `Auditor` is deliberately absent. It reads.
 *
 * -------------------------------------------------------------------------------------------------
 * THE FLOW IS VALIDATED HERE AND NOT ONLY IN THE BROWSER.
 *
 * `api.uploadGatewayBackup` already refuses `flows_cred.json` BY SHAPE rather than by filename,
 * because both files sit side by side in /data and an operator can rename either. That check is
 * repeated here because a browser check is a convenience and this is the boundary -- and because the
 * consequence is worse on this side: the credential file is encrypted with a secret that exists only
 * on the appliance, and a repository keeps forever what a bucket would let you delete.
 */

/** Proposing, not approving. Approving is `gitops:manage` and is not reachable from this function. */
const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager", "Operator"];

/** A generous ceiling on a flow, matching the storage bucket's own 5 MiB limit. */
const MAX_FLOW_BYTES = 5 * 1024 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Is this a Node-RED flow export, and specifically NOT a credentials file?
 *
 * The same two tests the browser makes, in the same order and for the same reasons: a flow export is
 * a JSON array of nodes, and `flows_cred.json` decrypted is an object map whose values carry no
 * `type`. An empty array is a valid flow -- it is what a blank editor exports -- so it is accepted.
 */
function flowRejectionReason(flow: unknown): string | null {
  if (!Array.isArray(flow)) {
    return "A Node-RED flow export is a JSON array of nodes. This is not one.";
  }
  if (flow.length && flow.every((n) => typeof n === "object" && n !== null && !("type" in n))) {
    return "That looks like flows_cred.json, not flows.json. Credential files are never committed.";
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") || "";

  // CHECKED BEFORE THE CALLER IS, so a deployment with no forge answers the same way whoever asks,
  // and names the end that is unconfigured rather than reporting a permission problem.
  const forge = forgeConfig();
  if (!forge) {
    return json(503, {
      error: "This deployment has no forge",
      details:
        "Proposing a flow needs GITEA_INTERNAL_URL, GITEA_MACHINE_USER and " +
        "GITEA_MACHINE_PASSWORD. Until then the flow backup bucket is the only place a flow is kept.",
    });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  let gatewayId: string;
  let flow: unknown;
  try {
    const body = await req.json();
    gatewayId = String(body?.gateway_id ?? "");
    flow = body?.flow;
  } catch {
    return json(400, { error: "Malformed request", details: "Expected a JSON body." });
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gatewayId)) {
    return json(400, {
      error: "Malformed request",
      details: "`gateway_id` must be the gateway's UUID.",
    });
  }

  const rejection = flowRejectionReason(flow);
  if (rejection) {
    return json(400, { error: "That is not a flow", details: rejection });
  }

  const flowJson = `${JSON.stringify(flow, null, 4)}\n`;
  if (flowJson.length > MAX_FLOW_BYTES) {
    return json(413, {
      error: "That flow is too large",
      details: `Flows are limited to ${MAX_FLOW_BYTES / (1024 * 1024)} MiB.`,
    });
  }

  // AS THE CALLER, so RLS decides which gateways are visible and resolveUserRole sees a role at all.
  // There is no service-role key in this function's registry entry, deliberately: it makes no
  // privileged write, and the only row it reads is one the caller can already read.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth
    .getUser(authHeader.replace("Bearer ", ""));
  if (userError || !user) {
    return json(401, { error: "Invalid user token", details: userError?.message });
  }

  const userRole = await resolveUserRole(supabase, user.id);
  if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
    return json(403, {
      error: "Forbidden: Insufficient privileges",
      details:
        "Proposing a flow requires Administrator, Shopfloor_Manager or Operator. Approving one is " +
        "a separate privilege, and this endpoint does not grant it.",
    });
  }

  const { data: gateway, error: gatewayError } = await supabase
    .from("gateways")
    .select("sparkplug_id,name")
    .eq("id", gatewayId)
    .maybeSingle();

  if (gatewayError) {
    console.error(`gateway lookup failed: ${gatewayError.message}`);
    return json(500, { error: "Could not read the gateway", details: gatewayError.message });
  }
  if (!gateway) {
    // INDISTINGUISHABLE FROM "not yours to see", and that is right: RLS answers an unauthorised read
    // with no rows, so this reveals nothing about which gateways exist.
    return json(404, {
      error: "No such gateway",
      details: "It does not exist, or it is not one you can see.",
    });
  }

  const repo = repositoryNameFor(gateway.sparkplug_id);
  const proposer = user.email ?? user.id;

  try {
    const proposal = await proposeFlow(forge, repo, flowJson, proposer, gateway.name);
    console.log(
      `${proposer} proposed a flow for ${gateway.sparkplug_id} as ${repo}#${proposal.number}`,
    );
    return json(201, { pull_request: proposal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`proposal failed for ${gateway.sparkplug_id}: ${message}`);

    // A GATEWAY WITH NO REPOSITORY IS A COMMON CASE RATHER THAN A FAULT: repositories are created at
    // ENROLMENT, so a virtual gateway, or a physical one whose bundle predates the forge, has none.
    // Saying so is the difference between "re-enrol this appliance" and "the forge is broken".
    if (/404/.test(message)) {
      return json(409, {
        error: "This gateway has no repository",
        details:
          `Expected '${forge.user}/${repo}'. Repositories are created when an appliance enrols ` +
          "with a deploy key, so a gateway enrolled before the forge existed has none yet.",
      });
    }
    return json(502, { error: "The forge refused the proposal", details: message });
  }
}

serve(handler);
