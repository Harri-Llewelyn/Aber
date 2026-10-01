import { serviceRoleClient } from "../_shared/serviceClient.ts";

import { corsHeaders } from "../_shared/cors.ts";
import { brokerPublicHost } from "../_shared/publicAddresses.ts";
import {
  forgeConfig,
  forgeKnownHosts,
  provisionGatewayRepository,
  validPublicKey,
} from "../_shared/forge.ts";

/**
 * Remote gateway enrolment: exchange a single-use token for a broker credential. The caller is an
 * appliance, not a person, so there is no role to resolve: possession of the token is the
 * authorisation. The anon key gets the request past the gateway; the token authorises it.
 *
 * The order is the design: 1. claim the token atomically (consume_gateway_enrollment_token); 2.
 * issue the broker credential; 3. mark the gateway AWAITING_BIRTH; 4. create its repository and
 * register its deploy key. Claiming first means a failure in step 2 has to be undone (the 503 path
 * releases the claim), but validate-then-issue-then-consume would let two appliances receive a
 * credential for one edge node and contend for one identity. Step 3 is last because a gateway
 * marked AWAITING_BIRTH without a credential looks enrolled and is not. Step 4 is non-fatal and
 * skipped on a deployment with no forge; see forge.ts.
 *
 * This function does not create gateways, does not mint tokens, and does not read anything about a
 * gateway it was not handed a token for. The service-role key is used for exactly three calls,
 * named below.
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

  // Configuration is checked before the token is touched: a misconfigured deployment must not
  // consume an appliance's one-shot token. 503 with a named cause, and the bundle stays valid.
  // MQTT_PUBLIC_HOST is included because its default resolves on the container network and nowhere
  // a gateway lives.
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

  const broker = brokerPublicHost();
  if (broker.problem) {
    console.error(`MQTT_PUBLIC_HOST is '${mqttHost}', which no appliance can resolve`);
    return json(503, {
      error: "Enrolment is not configured on this deployment",
      details:
        `MQTT_PUBLIC_HOST is ${broker.problem} -- set it to the hostname or IP Remote gateways ` +
        "dial, then re-issue the certificate (mosquitto-tls-init folds it into the broker " +
        "certificate's SAN). No token was consumed.",
    });
  }

  let body: { token?: unknown; agent_version?: unknown; ssh_public_key?: unknown };
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

  // The public half of a key the appliance generated, the only thing about the forge in this
  // request. Shape-checked in forge.ts.
  const sshPublicKey = validPublicKey(body.ssh_public_key);

  // The service-role client. Its three uses are the RPCs below and one gateway UPDATE -- there is
  // no caller-scoped client here because there is no caller identity to scope one to.
  const admin = serviceRoleClient(supabaseUrl, serviceRoleKey, {
    // Names this function in the audit trail rather than leaving it as the generic 'service'.
    // The audit_trail trigger accepts only ingestion/service/migration from this header.
    "X-Aber-Actor": "service",
  });

  // 1. Claim. One winner, decided by the database.
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
    // Unknown, expired and already-consumed are deliberately indistinguishable: reporting which
    // would let an enumerator learn that a token value once existed, and the appliance can do
    // nothing different in any case.
    console.warn("rejected an enrolment attempt with an invalid token");
    return json(401, REJECTION);
  }

  // 2. Issue. The one step that can fail after the claim, and therefore the one with a rollback.
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
      // No password supplied: the credential service generates it at the point of use, which keeps
      // the alphabet guarantee (base64url, an injection boundary) with the code that depends on it.
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

  // No CA means no enrolment, and this is a refusal rather than a degradation: Remote gateways
  // connect over MQTTS only, and an appliance without the CA could only proceed by skipping
  // verification, which this stack has no switch for. The claim is released, since this is a
  // deployment fault and the same bundle should work once TLS is provisioned.
  if (!credential.ca_cert || !credential.ca_cert.includes("BEGIN CERTIFICATE")) {
    console.error("the credential service returned no CA certificate; refusing to enrol");
    const retryable = await releaseClaim();
    return json(503, {
      error: "The broker has no certificate authority",
      details:
        "Remote gateways connect over MQTTS and must verify the broker against its CA. " +
        "Check mosquitto.tls.enabled and the cert-manager issuer it names.",
      retryable,
    });
  }

  // 3. Record. Last, because a gateway marked enrolled without a credential looks fine and is not.
  const { error: statusError } = await admin
    .from("gateways")
    .update({
      status: "AWAITING_BIRTH",
      enrolled_at: new Date().toISOString(),
      agent_version: agentVersion,
    })
    .eq("id", identity.gateway_id);

  if (statusError) {
    // Not fatal, and not rolled back: the credential exists at the broker and the appliance is
    // about to use it. The gateway's first NBIRTH sets it ONLINE regardless, so only the
    // intermediate label is lost.
    console.error(
      `credential issued for ${identity.sparkplug_id} but the gateway status could not be ` +
      `updated: ${statusError.message}. Its first NBIRTH will set it ONLINE.`
    );
  }

  // 4. The forge. Non-fatal by construction; see the header and forge.ts.
  const forge = forgeConfig();
  let repository:
    | {
      ssh_url: string;
      branch: string;
      known_hosts: string | null;
      platform_ssh_url: string | null;
      platform_tag: string | null;
    }
    | null = null;

  if (forge && sshPublicKey) {
    const provisioned = await provisionGatewayRepository(
      forge,
      identity.sparkplug_id,
      identity.gateway_name,
      sshPublicKey,
    );
    if (provisioned) {
      const repo = provisioned.repository;
      // The host key travels with the clone URL, in this response, because this is the one moment
      // the appliance is provably itself; learning the forge's identity any other way would be
      // trust on first use. Null is a real answer: a forge that has not published a host key gives
      // none, and the appliance enrols and publishes but declines to converge.
      const knownHosts = await forgeKnownHosts(forge, repo.ssh_url);
      repository = {
        ssh_url: repo.ssh_url,
        branch: repo.default_branch || "main",
        known_hosts: knownHosts,
        // The platform repository the same key reads, and the tag current at enrolment, which the
        // gateway's own platform.yml carries from here on. Null on a deployment that names no
        // version: the appliance then runs the bundle alone and nothing converges its host.
        platform_ssh_url: provisioned.platform?.ssh_url ?? null,
        platform_tag: provisioned.platform?.tag ?? null,
      };
      if (!knownHosts) {
        console.warn(
          `${identity.sparkplug_id} has a repository but no host key to verify the forge with, ` +
            "so it will not converge. Restart the forge to publish one.",
        );
      }
      // The record that step 4 happened. `enrolled_at` is step 3 and is set on every path through
      // here, including the ones that reach no forge -- so a page that reads it offers links to a
      // repository that does not exist (#237). Non-fatal like the rest of step 4: the sweep writes
      // it for a repository it finds whose row has none.
      const { error: repoError } = await admin
        .from("gateways")
        .update({ forge_repository_at: new Date().toISOString() })
        .eq("id", identity.gateway_id);
      if (repoError) {
        console.error(
          `${identity.sparkplug_id} has a repository but the row could not record it: ` +
            `${repoError.message}. forge-sweep will set it on its next pass.`,
        );
      }
    }
  } else if (forge && !sshPublicKey) {
    // An appliance old enough not to send a key, or a malformed one. Neither fails an enrolment;
    // both are worth a line, since the gateway will have no repository.
    console.warn(
      `${identity.sparkplug_id} sent no usable SSH public key, so it has no repository. Its ` +
      "bundle predates the forge, or the key was malformed.",
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
    // The username is the sparkplug_id and cannot be anything else: the gateway's broker role
    // confines it to spBv1.0/+/+/<username>/#, and verify_gateway_binding() compares the same
    // segment against the gateway row.
    mqtt_username: identity.sparkplug_id,
    // RETURNED EXACTLY ONCE. The broker stores only a hash, so this response is the only copy that
    // will ever exist -- there is no endpoint that could re-read it.
    mqtt_password: credential.password,
    ca_cert: credential.ca_cert,
    // Whether the running broker has already been reloaded. False means the credential is durable
    // but not yet live (the Kubernetes projected-Secret sync, up to ~90s), so the appliance should
    // retry its first CONNECT.
    applied_to_running_broker: credential.applied_to_running_broker !== false,
    // The gateway's own repository, or null: no forge, no key sent, or provisioning failed. The
    // appliance enrols and publishes either way; without this it cannot converge to a reviewed
    // flow.
    repository,
  });
}

Deno.serve(handler);
