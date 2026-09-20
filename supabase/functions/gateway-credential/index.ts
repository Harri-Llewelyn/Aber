import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

/**
 * Mint a broker credential for a host-run gateway and reveal it exactly once. The second caller of
 * the credential service's issue verb, beside enroll-gateway, and nothing is added to that verb
 * here. The mirror image of enroll-gateway, which has no user and is authorised by a token; this
 * has a session and is authorised by role, and folding the two would mean one function accepting
 * two unrelated proofs of authority. A host-run gateway needs this because its `sparkplug_id` is
 * generated from its row, so the account can only be minted after the row, and there is no
 * appliance to carry a bundle to.
 *
 * The authority is more than gateway-bundle's, which holds no secret: the broker's accounts are
 * not reachable from SQL, so minting requires MQTT_CREDENTIAL_SERVICE_TOKEN. There is still no
 * service-role key, so this cannot read or write a table outside the caller's RLS context. The
 * decision is the database's: `authorize_host_gateway_credential()` is SECURITY DEFINER and
 * checks `has_role()` itself, so the role check below exists only so a refusal answers 403 with a
 * usable message.
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
  const anonKey = gatewayKey();
  const credentialUrl = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
  const credentialToken = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";

  const missing = [
    !supabaseUrl && "SUPABASE_URL",
    !anonKey && "SUPABASE_PUBLISHABLE_KEY",
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

  // As the caller, not as the service: the anon key plus the caller's Authorization header is what
  // makes `auth.uid()` resolve inside the RPCs, attributing the audit row to a person and letting
  // has_role() see a role.
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
    // Operator and Auditor land here, and nothing has been minted: the check is ahead of the RPC
    // and the credential service, so a refused request cannot leave an unaccounted account at the
    // broker.
    return json(403, {
      error: "Forbidden: Insufficient privileges",
      details:
        "Minting a broker credential requires Administrator or Shopfloor_Manager. It adds an " +
        "account to the broker that the gateway then authenticates as.",
    });
  }

  // 1. The authority decision, made by the database. Refuses a Remote gateway (use a bundle), an
  // archived one, and a caller without the role, and returns the generated sparkplug_id, the only
  // thing the account may be named.
  const { data: authorized, error: authError } = await supabase
    .rpc("authorize_host_gateway_credential", { p_gateway_id: gatewayId });

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

  // 1b. May the password be delivered to the playback worker? A second call rather than a column on
  // the gate above, because the gate is redeclared on every boot with CREATE OR REPLACE, which
  // cannot change a return type. Still the database's answer, `is_simulated`, the same predicate
  // start_playback_job() gates on, so there is one definition of "is this a playback target". False
  // on error, never true: a failure must not fail the issue and must not deliver on a guess, so the
  // password is shown once and placed by hand.
  let deliverToPlayback = false;
  const { data: isPlaybackTarget, error: deliveryError } = await supabase
    .rpc("gateway_is_playback_delivery_target", { p_gateway_id: gatewayId });

  if (deliveryError) {
    console.error(`gateway-credential: delivery predicate unavailable: ${deliveryError.message}`);
  } else {
    deliverToPlayback = isPlaybackTarget === true;
  }

  // 2. The mint. No password is supplied: the credential service generates it at the point of use,
  // keeping the alphabet guarantee (base64url, an injection boundary) with the code that depends on
  // it. Same call enroll-gateway makes.
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

  // 3. The audit row, written only now that the password is real. A failure here does not withhold
  // the password: the account exists in the broker and the service stores only a hash, so refusing
  // to return it would strand an account nobody can authenticate as. The response says the record
  // failed instead.
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
    // The username is the sparkplug_id and cannot be anything else: the gateway's broker role
    // confines it to that edge-node segment. Returned under its own name so the dashboard can label
    // the field.
    mqtt_username: identity.sparkplug_id,
    password: credential.password,
    applied_to_running_broker: credential.applied_to_running_broker ?? false,
    audit_recorded: auditRecorded,
    // Whether the operator still has work to do. Three states the page must not merge: true,
    // delivered and the worker picks it up within its poll interval; false, this is a playback
    // target and delivery failed, so the password must be placed by hand; null, not a playback
    // target.
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
