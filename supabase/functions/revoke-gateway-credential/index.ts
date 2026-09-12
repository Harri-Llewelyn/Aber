/**
 * Revoke a decommissioned gateway's broker credential. A function rather than a direct pg_net call
 * from the database because on Kubernetes `templates/networkpolicy.yaml` permits exactly one
 * ingress to the credential service, `supabase-functions`, and a trigger dialling that port itself
 * would be a second edge into credential issuance. Revocation disables the account at the broker:
 * the credential service asks the Dynamic Security plugin to `disableClient`, which drops the
 * gateway's live session and refuses its next CONNECT. The account and its hash stay, listed as
 * disabled on the Access Control page, and a later issue re-enables it. The secret check is not
 * optional: the edge runtime boots with VERIFY_JWT="false", and the gateway's key-auth proves only
 * that the caller holds the anon key. Same shape as `grafana-alert-webhook`.
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

  // Shape-checked before it reaches the credential service, which answers "not found" for an id it
  // does not hold; a malformed one should be refused here, where the caller can read why.
  if (!SPARKPLUG_ID.test(sparkplugId)) {
    return json(400, { error: "sparkplug_id must match gwy[0-9a-f]{21}" });
  }

  try {
    const response = await fetch(`${CREDENTIAL_URL.replace(/\/+$/, "")}/revocations`, {
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
      return json(502, { error: "the credential service refused the revocation" });
    }

    const result = await response.json().catch(() => ({}));
    console.log(
      `revoked ${sparkplugId} (${result.existed ? "disabled; any live session dropped" : "no account existed"})`,
    );

    // `existed` is the honest answer to "was there anything to revoke": false means the broker
    // holds no account by that name and nothing was changed. The trigger avoids reaching here in
    // that case by checking whether a credential was ever recorded; this is the second line of that
    // defence.
    return json(200, { revoked: Boolean(result.revoked), existed: Boolean(result.existed) });
  } catch (err) {
    console.error(`could not reach the credential service: ${(err as Error).message}`);
    return json(503, { error: "the credential service is unreachable" });
  }
});
