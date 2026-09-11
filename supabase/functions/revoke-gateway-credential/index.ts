/**
 * Revoke a decommissioned gateway's broker credential. A function rather than a direct pg_net call
 * from the database because on Kubernetes `templates/networkpolicy.yaml` permits exactly one
 * ingress to the credential-issuing sidecar, `supabase-functions`, and a trigger dialling that port
 * itself would be a second edge into credential issuance. Revocation is a rotation, not a deletion:
 * the credential service is add-only by design, so this re-provisions the account with a fresh
 * password the service generates and nobody records, and throws the response away. The password is
 * never returned to the caller. The secret check is not optional: the edge runtime boots with
 * VERIFY_JWT="false", and the gateway's key-auth proves only that the caller holds the anon key.
 * Same shape as `grafana-alert-webhook`.
 */
const CREDENTIAL_URL = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
const CREDENTIAL_TOKEN = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";
const REVOKE_SECRET = Deno.env.get("GATEWAY_REVOKE_SECRET") ?? "";

/** Matches gateways.sparkplug_id: 'gwy' plus 21 hex characters of the row's UUID. */
const SPARKPLUG_ID = /^gwy[0-9a-f]{21}$/;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Constant-time comparison: a `===` on a secret leaks its prefix through timing, and the mitigation
 * is cheap.
 */
function secretMatches(presented: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(REVOKE_SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  // Not configured is 503, not 401: a stack that never set the secret has nothing to check against,
  // and 401 would send whoever is debugging it looking for a wrong value rather than a missing one.
  if (!REVOKE_SECRET || !CREDENTIAL_URL || !CREDENTIAL_TOKEN) {
    const missing = [
      !REVOKE_SECRET && "GATEWAY_REVOKE_SECRET",
      !CREDENTIAL_URL && "MQTT_CREDENTIAL_SERVICE_URL",
      !CREDENTIAL_TOKEN && "MQTT_CREDENTIAL_SERVICE_TOKEN",
    ].filter(Boolean);
    console.error(`revoke-gateway-credential is not configured: ${missing.join(", ")} unset`);
    return json(503, { error: "revocation is not configured on this deployment" });
  }

  const presented = req.headers.get("x-revoke-secret") ?? "";
  if (!secretMatches(presented)) {
    // No detail about why. A response distinguishing "no header" from "wrong value" is a hint.
    return json(401, { error: "unauthorized" });
  }

  let sparkplugId = "";
  try {
    const body = await req.json();
    sparkplugId = String(body?.sparkplug_id ?? "");
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }

  // Shape-checked before it reaches the credential service, which creates an account for whatever
  // id it is handed; a malformed one would add a junk account nothing will ever remove.
  if (!SPARKPLUG_ID.test(sparkplugId)) {
    return json(400, { error: "sparkplug_id must match gwy[0-9a-f]{21}" });
  }

  try {
    // NO PASSWORD IN THE REQUEST. The service generates one when the caller supplies none, which
    // is exactly what revocation wants: a value neither this function nor the database ever sees.
    const response = await fetch(`${CREDENTIAL_URL.replace(/\/+$/, "")}/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CREDENTIAL_TOKEN}`,
      },
      body: JSON.stringify({ sparkplug_id: sparkplugId }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`credential service answered ${response.status}: ${detail.slice(0, 300)}`);
      // 502, not a pass-through of their status: the caller asked THIS function to revoke, and the
      // upstream's 401 is not the caller's 401.
      return json(502, { error: "the credential service refused the rotation" });
    }

    const result = await response.json().catch(() => ({}));
    console.log(
      `revoked ${sparkplugId} by rotation (${result.replaced ? "replaced an existing account" : "no account existed"})`,
    );

    // `replaced` is the honest answer to "was there anything to revoke": false means the account
    // did not exist and one has now been created holding an unrecorded password, inert but not a
    // withdrawal. The trigger avoids reaching here in that case by checking `enrolled_at`; this is
    // the second line of that defence.
    return json(200, { revoked: true, replaced: Boolean(result.replaced) });
  } catch (err) {
    console.error(`could not reach the credential service: ${(err as Error).message}`);
    return json(503, { error: "the credential service is unreachable" });
  }
});
