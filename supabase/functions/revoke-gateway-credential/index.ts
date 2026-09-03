/**
 * Revoke a decommissioned gateway's broker credential.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS AS A FUNCTION AT ALL, when the database could call the credential service
 * directly and does so in one line of pg_net.
 *
 * IT COULD ON COMPOSE AND MUST NOT ON KUBERNETES. `templates/networkpolicy.yaml` permits exactly
 * one ingress to the credential-issuing sidecar -- `supabase-functions` -- and calls it "THE ONLY
 * EDGE INTO CREDENTIAL ISSUANCE, and the first of its two layers of protection (the bearer token
 * is the second)". A trigger dialling that port itself would be a second edge, admitted for the
 * convenience of removing a hop. The chart already allows `supabase-db -> supabase-kong` for
 * "pg_net: edge functions and REST called from SQL", so routing through here is the path that
 * already exists rather than a new one.
 *
 * The alternative -- widening the policy -- would have traded a stated security property for one
 * fewer moving part, in a change whose entire subject is credential lifetime.
 *
 * ---------------------------------------------------------------------------------------------
 * REVOCATION IS A ROTATION, NOT A DELETION, and that is settled in archived migration 0038's header rather
 * than here. In short: the credential service is add-only by design and a delete verb would turn
 * "can mint a confined account" into "can stop the entire fleet publishing". So this re-provisions
 * the account with a fresh random password THE SERVICE GENERATES AND NOBODY RECORDS, and throws
 * the response away. The appliance's credential stops working; the never-lose-an-account guard in
 * mergeCredential() is untouched.
 *
 * THE PASSWORD IS NEVER RETURNED TO THE CALLER. It is the one copy that will ever exist and it
 * exists only in this worker's memory, for the length of one request. Returning it -- even to a
 * caller holding the shared secret -- would turn a revocation endpoint into an issuance one.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SECRET CHECK IS NOT OPTIONAL. The edge runtime boots with VERIFY_JWT="false" because each
 * function authorises itself, so a function that forgets to check is an open endpoint rather than
 * a 401. Kong's key-auth in front of /functions/v1/ proves only that the caller holds the anon
 * key, which ships inside every browser bundle -- it is not authorisation for anything.
 *
 * Same shape as `grafana-alert-webhook`: the caller presents a purpose-scoped shared secret, this
 * function verifies it, and only then uses the authority it holds.
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
 * Constant-time comparison.
 *
 * A `===` on a secret leaks its prefix through timing. The volume here is one call per archived
 * gateway, so an attack is impractical anyway -- which is an argument for it being cheap to do
 * correctly, not for skipping it.
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

  // NOT CONFIGURED IS 503, NOT 401. A stack that never set the secret has not refused the caller;
  // it has nothing to check against, and answering 401 would send whoever is debugging it looking
  // for a wrong value rather than a missing one.
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

  // Shape-checked before it reaches the credential service. That service creates an account for
  // whatever id it is handed, so a malformed one does not fail -- it succeeds, and adds a junk
  // account to the broker's password file that nothing will ever remove.
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

    // `replaced` is reported because it is the honest answer to "was there anything to revoke".
    // False means the account did not exist and one has now been created holding an unrecorded
    // password -- inert, but the caller should not be told that a credential was withdrawn when
    // none was outstanding. archived migration 0038 avoids reaching here in that case by checking
    // `enrolled_at`; this is the second line of that defence.
    return json(200, { revoked: true, replaced: Boolean(result.replaced) });
  } catch (err) {
    console.error(`could not reach the credential service: ${(err as Error).message}`);
    return json(503, { error: "the credential service is unreachable" });
  }
});
