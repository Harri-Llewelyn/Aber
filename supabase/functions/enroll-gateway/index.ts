import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { corsHeaders } from "../_shared/cors.ts";

/**
 * Physical gateway enrolment: exchange a single-use token for a broker credential.
 *
 * THE CALLER IS AN APPLIANCE, NOT A PERSON, and everything about this function follows from that.
 * There is no user, no session and no role to resolve -- POSSESSION OF THE TOKEN IS THE
 * AUTHORISATION. That is why this is the one function in the registry that does not call
 * resolveUserRole(): asking "which role is this" of a Raspberry Pi in a machine shop has no answer,
 * and inventing one (a shared service account, say) would create a credential that outlives the
 * enrolment and can be replayed.
 *
 * The token instead is short-lived, single-use, and bound to exactly one gateway. It reaches this
 * endpoint through Kong's `key-auth` with the ANON key -- public by construction, and the same key
 * the dashboard uses. The anon key is not the security boundary here and is not meant to be; it is
 * what gets the request past the gateway, and the token is what authorises it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE DESIGN, and it is not the obvious one.
 *
 *   1. CLAIM the token atomically      (consume_gateway_enrollment_token)
 *   2. issue the broker credential     (the gateway-credential service)
 *   3. mark the gateway AWAITING_BIRTH
 *
 * Claiming FIRST looks wrong -- it means a failure in step 2 has to be undone -- but the
 * alternative is worse and is unfixable. A validate-then-issue-then-consume order lets two
 * appliances both observe an unconsumed token and both receive a credential for the same edge node;
 * and because mosquitto.acl pins the topic's edge-node segment to the connecting username, they
 * then contend for ONE identity, silently, with each rewriting the other's telemetry.
 *
 * So the claim is atomic and step 2's failure is handled by RELEASING it (see the 503 path below),
 * which turns a transient broker outage into a retry rather than into a manual re-issue per
 * appliance.
 *
 * Step 3 comes last because it is the only step that is not safely repeatable in the other order:
 * a gateway marked AWAITING_BIRTH that never received a credential looks enrolled and is not.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS FUNCTION NEVER DOES. It does not create gateways, does not mint tokens (that is the
 * dashboard's, through a SECURITY DEFINER RPC gated on has_role), and does not read anything about
 * a gateway it was not handed a token for. The service-role key it holds is used for exactly three
 * calls, all of them named below.
 */

/** Every failed redemption answers with this, whatever the reason. */
const REJECTION = {
  error: "Enrolment token is not valid",
  details:
    "The token is unknown, expired, or has already been redeemed. Enrolment tokens are " +
    "single-use and short-lived; generate a new bundle from the gateway's page in the dashboard.",
};

interface GatewayIdentity {
  gateway_id: string;
  sparkplug_id: string;
  sparkplug_group: string;
  gateway_name: string;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const credentialUrl = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
  const credentialToken = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";
  const mqttHost = Deno.env.get("MQTT_PUBLIC_HOST") ?? "";
  const mqttTlsPort = Number.parseInt(Deno.env.get("MQTT_PUBLIC_TLS_PORT") ?? "8883", 10);

  // ---------------------------------------------------------------------------------------------
  // CONFIGURATION IS CHECKED BEFORE THE TOKEN IS TOUCHED.
  //
  // A misconfigured deployment must not consume an appliance's one-shot token discovering that it
  // cannot finish. 503 with a named cause, and the bundle stays valid.
  //
  // MQTT_PUBLIC_HOST is included in that check deliberately. Its default would be `mosquitto`,
  // which resolves on the container network and nowhere a gateway lives -- so an unset value
  // produces a bundle that enrols perfectly and then cannot connect to anything, which is the
  // hardest version of this failure to diagnose. Same reasoning as AAS_MODEL_PUBLIC_BASE.
  // ---------------------------------------------------------------------------------------------
  const missing = [
    !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
    !credentialUrl && "MQTT_CREDENTIAL_SERVICE_URL",
    !credentialToken && "MQTT_CREDENTIAL_SERVICE_TOKEN",
    !mqttHost && "MQTT_PUBLIC_HOST",
  ].filter(Boolean);

  if (missing.length) {
    console.error(`enroll-gateway is not configured: ${missing.join(", ")} unset`);
    return json(503, {
      error: "Enrolment is not configured on this deployment",
      details:
        `The server is missing ${missing.join(", ")}. No token was consumed; the bundle is ` +
        "still valid once the deployment is configured.",
    });
  }

  if (mqttHost === "mosquitto" || mqttHost === "localhost" || mqttHost === "127.0.0.1") {
    console.error(`MQTT_PUBLIC_HOST is '${mqttHost}', which no appliance can resolve`);
    return json(503, {
      error: "Enrolment is not configured on this deployment",
      details:
        `MQTT_PUBLIC_HOST is '${mqttHost}' -- an address that resolves only inside the stack. ` +
        "Set it to the hostname or IP physical gateways dial, then re-issue the certificate " +
        "(mosquitto-tls-init folds it into the broker certificate's SAN). No token was consumed.",
    });
  }

  let body: { token?: unknown; agent_version?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body must be JSON" });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  // Shape-checked here as well as in the RPC, so a malformed value never reaches a database call.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return json(401, REJECTION);
  }

  const agentVersion =
    typeof body.agent_version === "string" ? body.agent_version.slice(0, 64) : null;

  // The service-role client. Its three uses are the RPCs below and one gateway UPDATE -- there is
  // no caller-scoped client here because there is no caller identity to scope one to.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: {
      // Names this function in the audit trail rather than leaving it as the generic 'service'.
      // The digital_thread trigger accepts only ingestion/service/migration from this header.
      headers: { "X-ACS-Cymru-Actor": "service" },
    },
  });

  // ---------------------------------------------------------------------------------------------
  // 1. CLAIM. One winner, decided by the database.
  // ---------------------------------------------------------------------------------------------
  const { data: claimed, error: claimError } = await admin
    .rpc("consume_gateway_enrollment_token", { p_token: token });

  if (claimError) {
    console.error(`token claim failed: ${claimError.message}`);
    return json(503, {
      error: "Enrolment is temporarily unavailable",
      details: "The enrolment record could not be read. Retry in a few seconds.",
    });
  }

  const identity = (claimed as GatewayIdentity[] | null)?.[0];
  if (!identity) {
    // Unknown, expired and already-consumed are DELIBERATELY INDISTINGUISHABLE. The RPC returns no
    // rows for all three, and reporting which would let an enumerator learn that a token value once
    // existed. The appliance can do nothing different in any of the three cases.
    console.warn("rejected an enrolment attempt with an invalid token");
    return json(401, REJECTION);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. ISSUE. The one step that can fail after the claim, and therefore the one with a rollback.
  // ---------------------------------------------------------------------------------------------
  /** Put the claim back so the same bundle can be retried, and say whether that worked. */
  const releaseClaim = async (): Promise<boolean> => {
    const { data, error } = await admin
      .rpc("release_gateway_enrollment_token", { p_token: token });
    if (error) {
      // The token stays consumed and the operator must re-issue. Logged loudly because nothing
      // else will say so -- the appliance only sees a 503 and will retry into a 401.
      console.error(
        `COULD NOT RELEASE the claim on ${identity.sparkplug_id}'s enrolment token ` +
        `(${error.message}). That bundle is now spent; re-issue it from the dashboard.`
      );
      return false;
    }
    return data === true;
  };

  let credential: { password?: string; ca_cert?: string | null; applied_to_running_broker?: boolean };
  try {
    const response = await fetch(`${credentialUrl.replace(/\/+$/, "")}/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentialToken}`,
      },
      // NO PASSWORD SUPPLIED. The credential service generates it at the point of use, which is one
      // fewer copy in transit and keeps the alphabet guarantee (base64url, an injection boundary)
      // with the code that depends on it.
      body: JSON.stringify({ sparkplug_id: identity.sparkplug_id }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      console.error(`credential service answered ${response.status}: ${detail}`);
      const retryable = await releaseClaim();
      return json(503, {
        error: "Could not issue a broker credential",
        details: retryable
          ? "The broker credential service is unavailable. Your enrolment token has been " +
            "released -- retry with the same bundle."
          : "The broker credential service is unavailable, and the enrolment token could not be " +
            "released. Generate a new bundle from the dashboard.",
        retryable,
      });
    }

    credential = await response.json();
  } catch (err) {
    console.error(`credential service unreachable: ${err instanceof Error ? err.message : err}`);
    const retryable = await releaseClaim();
    return json(503, {
      error: "Could not issue a broker credential",
      details: retryable
        ? "The broker credential service is unreachable. Your enrolment token has been " +
          "released -- retry with the same bundle."
        : "The broker credential service is unreachable, and the enrolment token could not be " +
          "released. Generate a new bundle from the dashboard.",
      retryable,
    });
  }

  if (!credential.password) {
    console.error("credential service returned no password");
    const retryable = await releaseClaim();
    return json(503, {
      error: "Could not issue a broker credential",
      details: "The credential service returned an unusable response.",
      retryable,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // NO CA MEANS NO ENROLMENT, and this is a refusal rather than a degradation.
  //
  // Physical gateways connect over MQTTS exclusively. An internal CA is in no system trust store,
  // so an appliance without it cannot verify the broker -- and the only way to proceed would be to
  // skip verification, which is indistinguishable from a successful interception. There is no such
  // switch anywhere in this stack and this is not where the first one gets added.
  //
  // The claim is released: this is a deployment fault (TLS not provisioned), not a bad token, and
  // the operator should be able to fix it and have the same bundle work.
  // ---------------------------------------------------------------------------------------------
  if (!credential.ca_cert || !credential.ca_cert.includes("BEGIN CERTIFICATE")) {
    console.error("the credential service returned no CA certificate; refusing to enrol");
    const retryable = await releaseClaim();
    return json(503, {
      error: "The broker has no certificate authority",
      details:
        "Physical gateways connect over MQTTS and must verify the broker against its CA. " +
        "Check the mosquitto-tls-init service (Compose) or mosquitto.tls.enabled (Kubernetes).",
      retryable,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 3. RECORD. Last, because a gateway marked enrolled without a credential looks fine and is not.
  // ---------------------------------------------------------------------------------------------
  const { error: statusError } = await admin
    .from("gateways")
    .update({
      status: "AWAITING_BIRTH",
      enrolled_at: new Date().toISOString(),
      agent_version: agentVersion,
    })
    .eq("id", identity.gateway_id);

  if (statusError) {
    // NOT FATAL, AND NOT ROLLED BACK. The credential exists at the broker and the appliance is
    // about to use it; failing here would leave a working account that no bundle can claim. The
    // gateway's first NBIRTH sets it ONLINE regardless -- process_node_message() writes status
    // unconditionally -- so the lifecycle self-corrects and only the intermediate label is lost.
    console.error(
      `credential issued for ${identity.sparkplug_id} but the gateway status could not be ` +
      `updated: ${statusError.message}. Its first NBIRTH will set it ONLINE.`
    );
  }

  console.log(
    `enrolled ${identity.gateway_name} (${identity.sparkplug_id}); ` +
    `applied_at_broker=${credential.applied_to_running_broker}`
  );

  return json(200, {
    status: "ENROLLED",
    gateway_name: identity.gateway_name,
    sparkplug_id: identity.sparkplug_id,
    sparkplug_group: identity.sparkplug_group,
    mqtt_host: mqttHost,
    mqtt_tls_port: mqttTlsPort,
    // The username IS the sparkplug_id and cannot be anything else: mosquitto.acl pins the topic's
    // edge-node segment to `%u`, and verify_gateway_binding() compares the same segment against the
    // gateway row. Sent explicitly rather than left for the appliance to infer.
    mqtt_username: identity.sparkplug_id,
    // RETURNED EXACTLY ONCE. mosquitto_passwd stores only a hash, so this response is the only copy
    // that will ever exist -- there is no endpoint that could re-read it.
    mqtt_password: credential.password,
    ca_cert: credential.ca_cert,
    // Whether the running broker has already been reloaded. False means the credential is durable
    // but not yet live (the Kubernetes projected-Secret sync, up to ~90s), so the appliance should
    // retry its first CONNECT rather than treat a refusal as a bad password.
    applied_to_running_broker: credential.applied_to_running_broker !== false,
  });
}

serve(handler);
