import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";

/**
 * Mint a broker credential for a VIRTUAL gateway and reveal it exactly once.
 *
 * THE THIRD CALLER OF ONE VERB, AND DELIBERATELY NOT A SECOND VERB. `gateway-credential-service`
 * can add a Mosquitto account and do nothing else -- it cannot read a password back, delete an
 * account, or reach the database -- and its own header warns that "it is not a general credential
 * API and must not become one." Nothing is added to it here. What changes is who may ask, and how
 * they prove it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MIRROR IMAGE OF enroll-gateway, WHICH IS WHY IT IS A SEPARATE FUNCTION
 *
 * That function has NO USER: the caller is an appliance holding a single-use token, and possession
 * of the token is the authorisation. This one has no token and a real session, so it is authorised
 * by ROLE -- the same arrangement `gateway-bundle` uses for the other half of the same feature.
 *
 * Folding the two together would mean one function accepting two unrelated proofs of authority for
 * one act, and choosing between them on the shape of the request body. That is exactly the sort of
 * branch a reader has to hold entirely in their head to know whether a path is guarded.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL: THE WORKFLOW 0025 WAS WRITTEN TO ELIMINATE, STILL IN PLACE
 *
 * A gateway created in the dashboard gets a random UUID, so its `sparkplug_id` is not known in
 * advance -- and `mosquitto.acl` pins the topic's edge-node segment to the connecting username, so
 * the account can only be minted after the row and must be named exactly that id. For a PHYSICAL
 * gateway an enrolment bundle solves it. For a VIRTUAL one both halves of that path refuse outright
 * (0025), correctly: there is no appliance to carry a bundle to.
 *
 * So what was left for a virtual gateway was 0025's own description of the pre-enrolment world:
 * "create a row in the UI, then have an operator with shell access run a script and hand the
 * password over by some other means." Five steps, one of them a shell, for a gateway that runs on
 * the machine already running the stack.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT AUTHORITY THIS HOLDS, STATED PLAINLY BECAUSE IT IS MORE THAN gateway-bundle's
 *
 * `gateway-bundle` holds NO secret at all -- it mints through a SECURITY DEFINER RPC as the caller,
 * and its ceiling is what that caller could already do through PostgREST. This function cannot
 * match that, and pretending otherwise would be the wrong lesson to take from it: the broker's
 * password file is not reachable from SQL, so minting requires calling out, and calling out
 * requires MQTT_CREDENTIAL_SERVICE_TOKEN.
 *
 * What it does preserve is the part that matters: NO SERVICE-ROLE KEY. The registry entry in
 * main/index.ts grants it the credential token and nothing else, so it cannot read a table, cannot
 * write one outside the caller's RLS context, and cannot see any other function's secrets. The
 * authority it holds is "add one confined account to a password file", which is the narrowest
 * credential in the stack that can do this job at all.
 *
 * AND THE DECISION IS STILL THE DATABASE'S. `authorize_virtual_gateway_credential()` (0041) is
 * SECURITY DEFINER and checks `has_role()` itself, so the role check below is not the security
 * boundary -- it exists so a refusal answers 403 with a usable message rather than surfacing an
 * `insufficient_privilege` raise as a 500.
 */

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed", details: "Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const credentialUrl = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
  const credentialToken = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";

  const missing = [
    !supabaseUrl && "SUPABASE_URL",
    !anonKey && "SUPABASE_ANON_KEY",
    !credentialUrl && "MQTT_CREDENTIAL_SERVICE_URL",
    !credentialToken && "MQTT_CREDENTIAL_SERVICE_TOKEN",
  ].filter(Boolean);

  if (missing.length > 0) {
    // NAMED, not summarised. A misconfigured deployment is the likeliest reason this ever fails,
    // and "not configured" without the variable sends an operator reading source.
    console.error(`gateway-credential: missing ${missing.join(", ")}`);
    return json(500, {
      error: "Credential minting is not configured",
      details: `The server is missing: ${missing.join(", ")}.`,
    });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  let gatewayId: string;
  try {
    const body = await req.json();
    gatewayId = String(body?.gateway_id ?? "");
  } catch {
    return json(400, { error: "Malformed request", details: "Expected a JSON body." });
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gatewayId)) {
    return json(400, {
      error: "Malformed request",
      details: "`gateway_id` must be the gateway's UUID.",
    });
  }

  // AS THE CALLER, NOT AS THE SERVICE. The anon key plus the caller's Authorization header is what
  // makes `auth.uid()` resolve inside the RPCs below -- which is what attributes the audit row to a
  // person rather than to a machine credential, and what lets has_role() see a role at all.
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
    // Operator and Auditor land here, and NOTHING HAS BEEN MINTED -- the check is ahead of both the
    // RPC and the credential service, so a refused request cannot leave an account in the broker's
    // password file that no gateway row accounts for.
    return json(403, {
      error: "Forbidden: Insufficient privileges",
      details:
        "Minting a broker credential requires Administrator or Shopfloor_Manager. It adds an " +
        "account to the broker that the gateway then authenticates as.",
    });
  }

  // 1. THE AUTHORITY DECISION, made by the database. Refuses a physical gateway (use a bundle), an
  //    archived one (0037's hole), and a caller without the role -- and returns the GENERATED
  //    sparkplug_id, which is the only thing the account may be named.
  const { data: authorized, error: authError } = await supabase
    .rpc("authorize_virtual_gateway_credential", { p_gateway_id: gatewayId });

  if (authError) {
    console.error(`gateway-credential: authorisation refused: ${authError.message}`);
    // The RPC's ERRCODEs carry the distinction the HTTP status should: a privilege refusal is 403,
    // a bad subject is 400, and anything else is ours rather than the caller's.
    const status = authError.code === "42501" ? 403
      : authError.code === "22023" || authError.code === "23503" ? 400
        : 500;
    return json(status, { error: "Cannot mint a credential", details: authError.message });
  }

  const identity = Array.isArray(authorized) ? authorized[0] : authorized;
  if (!identity?.sparkplug_id) {
    console.error("gateway-credential: authorisation returned no identity");
    return json(500, {
      error: "Cannot mint a credential",
      details: "The gateway was authorised but returned no wire identity.",
    });
  }

  // 1b. MAY THE PASSWORD BE DELIVERED TO THE PLAYBACK WORKER? (0078)
  //
  // A SECOND CALL RATHER THAN A COLUMN ON THE GATE ABOVE, and the reason is the migration model
  // rather than the design. 0001 redeclares that function on every boot with CREATE OR REPLACE,
  // which cannot change a return type -- so adding a column to it aborted the entire chain at file
  // one on the second boot, with the FDW server already dropped by CASCADE. See 0078's header.
  //
  // STILL THE DATABASE'S ANSWER, which is the part that matters: `is_simulated`, the same predicate
  // start_playback_job() gates on. Computing it here from the gateway row would make it a second
  // definition of "is this a playback target", and two definitions eventually disagree -- the
  // disagreement being a real machine's broker password written into a file the replay worker reads.
  //
  // FALSE ON ERROR, NEVER TRUE. A failure here must not fail the issue: the operator asked for a
  // credential and is entitled to one. It must also not deliver on a guess -- so an unreachable
  // answer means the password is shown once and placed by hand, which is the behaviour before this
  // change and is safe.
  let deliverToPlayback = false;
  const { data: isPlaybackTarget, error: deliveryError } = await supabase
    .rpc("gateway_is_playback_delivery_target", { p_gateway_id: gatewayId });

  if (deliveryError) {
    console.error(`gateway-credential: delivery predicate unavailable: ${deliveryError.message}`);
  } else {
    deliverToPlayback = isPlaybackTarget === true;
  }

  // 2. THE MINT. No password is supplied: the credential service generates it at the point of use,
  //    which is one fewer copy in transit and keeps the alphabet guarantee (base64url, an injection
  //    boundary) with the code that depends on it. Same call enroll-gateway makes.
  let credential: {
    password?: string;
    applied_to_running_broker?: boolean;
    playback_delivery?: { delivered?: boolean } | null;
  };
  try {
    const response = await fetch(`${credentialUrl.replace(/\/+$/, "")}/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentialToken}`,
      },
      body: JSON.stringify({
        sparkplug_id: identity.sparkplug_id,
        deliver_to_playback: deliverToPlayback,
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      console.error(`credential service answered ${response.status}: ${detail}`);
      return json(503, {
        error: "Could not issue a broker credential",
        details: "The broker credential service is unavailable. Nothing was changed -- retry.",
      });
    }

    credential = await response.json();
  } catch (err) {
    console.error(`credential service unreachable: ${err instanceof Error ? err.message : err}`);
    return json(503, {
      error: "Could not issue a broker credential",
      details: "The broker credential service is unreachable. Nothing was changed -- retry.",
    });
  }

  if (!credential.password) {
    console.error("credential service returned no password");
    return json(503, {
      error: "Could not issue a broker credential",
      details: "The broker credential service returned no password.",
    });
  }

  // 3. THE AUDIT ROW, written only now that the password is real. See 0041 for why this is a
  //    separate call and not folded into the authorisation above.
  //
  //    A FAILURE HERE DOES NOT WITHHOLD THE PASSWORD. The account now EXISTS in the broker, and the
  //    service stores only a hash -- so refusing to return it would strand an account nobody can
  //    ever authenticate as, and the only repair would be minting again. The response says the
  //    record failed instead, which is the one outcome an operator can actually act on.
  let auditRecorded = true;
  const { error: auditError } = await supabase
    .rpc("record_gateway_credential_issued", { p_gateway_id: gatewayId });

  if (auditError) {
    auditRecorded = false;
    console.error(`gateway-credential: audit row not written: ${auditError.message}`);
  }

  return json(200, {
    gateway_name: identity.gateway_name,
    sparkplug_id: identity.sparkplug_id,
    // THE USERNAME IS THE sparkplug_id AND CANNOT BE ANYTHING ELSE: mosquitto.acl pins the topic's
    // edge-node segment to it. Returned under its own name so the dashboard can label the field
    // without the reader having to know they are the same string.
    mqtt_username: identity.sparkplug_id,
    password: credential.password,
    applied_to_running_broker: credential.applied_to_running_broker ?? false,
    audit_recorded: auditRecorded,
    // WHETHER THE OPERATOR STILL HAS WORK TO DO, which is the difference between "issued" and
    // "issued, and playback will now work". Three distinct states and the page must not merge them:
    //
    //   true   delivered -- the worker picks it up within its poll interval, nothing else to do
    //   false  this IS a playback target and delivery FAILED -- the password must be placed by hand
    //   null   not a playback target, so there was nothing to deliver
    //
    // `false` and `null` would collapse into "not delivered" if this were a plain boolean, and the
    // first of those is the one that needs an operator.
    playback_delivered: deliverToPlayback
      ? (credential.playback_delivery?.delivered ?? false)
      : null,
    // The env-pair names node-red-init reconciles from, so the reveal-once panel can show the two
    // lines an operator pastes into .env rather than making them derive the naming convention.
    env_hint: {
      user_var: "MQTT_GW_<NAME>_USER",
      password_var: "MQTT_GW_<NAME>_PASSWORD",
    },
  });
});
