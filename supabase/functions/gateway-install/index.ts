import { strToU8 } from "fflate";

import { serviceRoleClient } from "../_shared/serviceClient.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { installerTransport } from "../_shared/installer.ts";
import { newCredentialSecret, renderGatewayEnv } from "../_shared/gatewayEnv.ts";
import { GATEWAY_PLATFORM_FILES } from "../_shared/gatewayPlatform.generated.ts";
import { zip } from "../_shared/zip.ts";

/**
 * What the one-liner fetches, each authorised by the enrolment token in `X-Enrolment-Token`: the
 * installer script, the platform playbook as a zip, and the appliance's .env. The mirror of
 * gateway-bundle's ZIP, served in pieces to a machine rather than as one archive to a person, on
 * enroll-gateway's model rather than gateway-bundle's: the dashboard minted the token (role-gated),
 * the appliance fetches with it (token-gated), and only enrolment consumes it.
 * `peek_gateway_enrollment_token()` (0105) is the check: the same four refusals as redemption,
 * answered identically, and no UPDATE.
 *
 * The token rides in a header, never the query string, so it lands in no access log. Nothing here
 * is cacheable, and the .env's credential secret is generated per fetch: the installer writes it
 * only when the appliance holds none, so a retry before enrolment costs nothing and a fetch after
 * enrolment changes nothing.
 *
 * HTTPS or nothing. The token and the credential secret cross this route, so a deployment whose
 * public URL is plain HTTP is refused, unless ABER_INSTALLER_ALLOW_HTTP says otherwise, which the
 * development values do and nothing else should.
 */

const REJECTION = {
  error: "Enrolment token is not valid",
  details:
    "The token is unknown, expired, or has already been redeemed. Generate a new install command " +
    "from the gateway's page in the dashboard.",
};

/** The installer, as the platform playbook ships it; published under the same tag in the forge. */
const INSTALLER_PATH = "install.sh";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...NO_STORE },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceRoleKey) {
    console.error("gateway-install is not configured: SUPABASE_SERVICE_ROLE_KEY unset");
    return json(503, { error: "The installer is not configured on this deployment" });
  }
  const transport = installerTransport();
  if (!transport.ok) {
    console.error(`gateway-install refused: ${transport.reason}`);
    return json(503, { error: "The installer is not available on this deployment", details: transport.reason });
  }

  const token = (req.headers.get("X-Enrolment-Token") ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return json(401, REJECTION);

  const admin = serviceRoleClient(supabaseUrl, serviceRoleKey, { "X-Aber-Actor": "service" });
  const { data, error } = await admin.rpc("peek_gateway_enrollment_token", { p_token: token });
  if (error) {
    console.error(`gateway-install: the token check failed: ${error.message}`);
    return json(503, { error: "The installer is temporarily unavailable", details: "The enrolment record could not be read. Retry in a few seconds." });
  }
  const identity = (data as { gateway_id: string; sparkplug_id: string; gateway_name: string; expires_at: string }[] | null)?.[0];
  if (!identity) {
    console.warn("gateway-install: refused a fetch with an invalid token");
    return json(401, REJECTION);
  }

  const file = new URL(req.url).searchParams.get("file") ?? "";

  if (file === "env") {
    const text = renderGatewayEnv({
      gatewayName: identity.gateway_name,
      sparkplugId: identity.sparkplug_id,
      publicUrl: transport.publicUrl,
      publishableKey: gatewayKey(),
      token,
      expiresAt: identity.expires_at,
      credentialSecret: newCredentialSecret(),
      via: "installer",
    });
    console.log(`gateway-install: served the .env for ${identity.sparkplug_id}`);
    return new Response(text, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
  }

  if (file === "platform.zip") {
    const files: Record<string, Uint8Array> = {};
    for (const [path, text] of Object.entries(GATEWAY_PLATFORM_FILES)) files[path] = strToU8(text);
    const archive = zip(files, { level: 6, mtime: new Date() });
    console.log(`gateway-install: served the platform playbook to ${identity.sparkplug_id}`);
    return new Response(archive, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="platform.zip"', ...NO_STORE },
    });
  }

  if (file !== "") return json(404, { error: `No such file '${file}'`, details: "The installer fetches 'env' and 'platform.zip'." });

  const template = GATEWAY_PLATFORM_FILES[INSTALLER_PATH];
  if (!template) {
    console.error(`gateway-install: the platform module carries no ${INSTALLER_PATH}`);
    return json(503, { error: "The installer is not available on this deployment", details: `${INSTALLER_PATH} is missing from the platform playbook module` });
  }
  // The public values, substituted; the token rides in the environment the pasted command sets,
  // never in the script's text.
  const script = template
    .replaceAll("__PLATFORM_URL__", transport.publicUrl)
    .replaceAll("__PUBLISHABLE_KEY__", gatewayKey())
    .replaceAll("__GATEWAY_NAME__", identity.gateway_name.replace(/[^A-Za-z0-9 ._-]/g, "_"))
    .replaceAll("__SPARKPLUG_ID__", identity.sparkplug_id);
  console.log(`gateway-install: served the installer to ${identity.sparkplug_id} (${identity.gateway_name})`);
  return new Response(script, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/x-shellscript; charset=utf-8", ...NO_STORE },
  });
}

Deno.serve(handler);
