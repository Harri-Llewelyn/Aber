import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { brokerPublicHost, platformPublicUrl } from "../_shared/publicAddresses.ts";
import { BUNDLE_VERSION, newCredentialSecret, renderGatewayEnv } from "../_shared/gatewayEnv.ts";
import { platformRootPem, spkiPin } from "../_shared/caPin.ts";
import { installerTransport } from "../_shared/installer.ts";
import { GATEWAY_PLATFORM_FILES } from "../_shared/gatewayPlatform.generated.ts";

/**
 * Package the Remote gateway bootstrap bundle as a ZIP, with a freshly minted enrolment token,
 * or mint the token and hand back the one-liner an operator pastes on the appliance instead
 * (`format: "command"`). The mirror image of enroll-gateway: no token, authorised by role
 * (Administrator or Shopfloor_Manager). The token is minted through
 * `issue_gateway_enrollment_token()`, SECURITY DEFINER and checking `public.has_role()` itself, as
 * the caller and not with the service-role key, so the role check below exists only so a refusal
 * answers 403 with a usable message. This function holds no service-role key; its ceiling is what
 * the caller could already do through PostgREST.
 *
 * The bundle carries a claim, never a credential: there is no broker password in the archive, and
 * the appliance obtains one at first boot. `NODERED_CREDENTIAL_SECRET` is generated per bundle, so
 * one appliance's credential file cannot be decrypted with another bundle's .env.
 *
 * The command is two stages in one line (docs/remote-gateways.md). Stage 0 carries no secret:
 * it fetches the platform's root over plain HTTP from the dashboard's host, checks its public
 * key against the pin minted here beside the token over the authenticated browser session, which
 * is the trusted channel, and installs it. Stage 1 fetches the installer from gateway-install over
 * TLS that pin has verified, with the token in a header, and runs it with the token and the pin
 * in its environment.
 */

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

/**
 * The appliance's files, from the platform playbook's `appliance/` (forge/gateway-platform),
 * which reaches this worker as a generated module because an edge worker has no filesystem. The
 * same files the installer's playbook lays down, so a bundle-installed appliance runs what a
 * command-installed one does. Every name the compose file relies on must be here: a service whose
 * script is not in the archive fails at `docker compose up`.
 */
const APPLIANCE_PREFIX = "appliance/";
const APPLIANCE_FILES = [
  "docker-compose.yml",
  "Dockerfile",
  "bootstrap.mjs",
  "flows.template.json",
  "flow-sync.mjs",
  "README.md",
];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * A filesystem- and header-safe slug, constrained to [\w.-] because it lands in a
 * Content-Disposition filename and in a directory name inside the archive.
 */
function slug(name: string): string {
  return (name || "gateway")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48) || "gateway";
}

/**
 * Whether stage 0 would actually get the root, asked by fetching it the way the appliance does.
 *
 * WHY THIS IS WORTH A REQUEST. Stage 0 is `curl -fsSL <ACS_CA_URL>` over plain HTTP, and `curl`
 * here follows no redirect: a deployment that redirects HTTP to HTTPS on the dashboard's host --
 * which is an ordinary thing for somebody to put in front of this -- makes that fetch stop with
 * nothing fetched. The command then fails on its first clause, on the appliance, in front of
 * whoever is commissioning it, and says only that a certificate could not be installed. The chart
 * adds no such redirect; something else may.
 *
 * Redirects are disabled rather than followed, because following one would report success for a
 * command that cannot follow it. Anything but a 200 is a reason, including the request failing:
 * every one of them breaks stage 0 the same way, and the consequence of being wrong here is that
 * the modal offers the bundle, which works everywhere.
 *
 * BOUNDED, BECAUSE THIS SITS IN AN ANSWER A PAGE WAITS ON. The two failures measured on k3d --
 * a 301 and a name that does not resolve -- both answer in under a second, but a connect to an
 * address that silently drops packets does not, and a firewall between the functions and the
 * dashboard's host is exactly the deployment this check exists for. Three seconds is generous for
 * a request to a Service in the same cluster and short enough that a caller waits rather than
 * gives up.
 */
const ROOT_PROBE_TIMEOUT_MS = 3000;

async function rootIsFetchable(caUrl: string): Promise<string | null> {
  try {
    const response = await fetch(caUrl, {
      redirect: "manual",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(ROOT_PROBE_TIMEOUT_MS),
    });
    // Drain the body: an unread response body keeps the connection open in Deno.
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) {
      return `${caUrl} answers ${response.status}, and stage 0 follows no redirect, so the command `
        + "would stop before anything was sent. Serve the root on plain HTTP at that path, or use the bundle";
    }
    if (!response.ok) return `${caUrl} answers ${response.status}, so an appliance has no root to fetch`;
    return null;
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError"
      ? `did not answer within ${ROOT_PROBE_TIMEOUT_MS} ms`
      : `could not be fetched (${err instanceof Error ? err.message : err})`;
    return `${caUrl} ${why}, so an appliance has no root to fetch`;
  }
}

/**
 * Whether this deployment can mint the one-liner, and why not: the installer route must be served
 * over TLS (or the development switch set), the pin needs the root, and the root has to be
 * fetchable the way stage 0 fetches it. Without the root the command is still minted on a
 * deployment whose public URL is plain HTTP under the switch, with no stage 0, which is what a
 * laptop cluster gets and nothing else should.
 */
async function installerAvailability(): Promise<{ available: boolean; reason: string | null; pin: string | null; caUrl: string | null }> {
  const transport = installerTransport();
  if (!transport.ok) return { available: false, reason: transport.reason, pin: null, caUrl: null };
  const caUrl = (Deno.env.get("ACS_CA_URL") ?? "").trim() || null;
  const pem = platformRootPem();
  const pin = pem ? await spkiPin(pem) : null;
  if (transport.publicUrl.startsWith("https://") && (!pin || !caUrl)) {
    return {
      available: false,
      reason: !pin
        ? "the platform's root is not mounted into the functions (ingress TLS issued after the pod started: restart supabase-functions)"
        : "ACS_CA_URL is unset, so an appliance has nowhere to fetch the root from",
      pin,
      caUrl,
    };
  }
  // Only where there is a stage 0 to break. A command minted without one fetches no root.
  if (pin && caUrl) {
    const unreachable = await rootIsFetchable(caUrl);
    if (unreachable) return { available: false, reason: unreachable, pin, caUrl };
  }
  return { available: true, reason: null, pin, caUrl };
}

/**
 * When the root the BROKER presents expires, and its pin. A different root from the one the
 * one-liner pins, which signs the API's certificate and is allowed to differ.
 *
 * WHY THE DASHBOARD WANTS IT. Every appliance reports the expiry of the root it holds. On its own
 * that says when a gateway will drop off; beside the platform's own it also says whether a
 * re-issued root has reached that gateway yet, which is the question between re-issuing the root
 * and switching the broker's leaf to it.
 *
 * Null on anything that fails, including a deployment with no root: the readiness answer is about
 * whether an appliance can be enrolled, and this does not bear on that.
 */
async function brokerRoot(): Promise<{ not_after: string; spki_sha256: string } | null> {
  const url = (Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "").replace(/\/+$/, "");
  const token = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";
  if (!url || !token) return null;
  try {
    const response = await fetch(`${url}/ca`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const { not_after, spki_sha256 } = await response.json() as { not_after?: string; spki_sha256?: string };
    return not_after && spki_sha256 ? { not_after, spki_sha256 } : null;
  } catch {
    return null;
  }
}

/**
 * The readiness answer. `ready` is true only when both addresses would be accepted by the two
 * functions that check them; `addresses` names each one and the problem, so the dashboard can
 * say which variable to set rather than that something is wrong. `installer` says whether the
 * one-liner can be minted, so the dashboard offers it or the bundle; `ca` is the broker's root,
 * which the Gateways page shows beside each appliance's own.
 */
async function readiness(authHeader: string): Promise<Response> {
  const supabaseUser = createClient(Deno.env.get("SUPABASE_URL") ?? "", gatewayKey(), {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await supabaseUser.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) {
    return json(401, { error: "Invalid user token", details: error?.message });
  }
  const addresses = [platformPublicUrl(), brokerPublicHost()];
  const installer = await installerAvailability();
  return json(200, {
    ready: addresses.every((a) => !a.problem),
    addresses,
    installer: { available: installer.available, reason: installer.reason },
    ca: await brokerRoot(),
  });
}

/**
 * The pasted command. Stage 0 only when there is a root to pin, which is every deployment the
 * installer is served over TLS on. The token appears twice, in the header that authorises the
 * fetch and in the environment the script reads it from; the command travelled over the
 * authenticated browser session and is pasted, never stored.
 */
export function installCommand(input: {
  publicUrl: string;
  publishableKey: string;
  token: string;
  pin: string | null;
  caUrl: string | null;
}): string {
  const stage0 = input.pin && input.caUrl
    ? `curl -fsSL ${input.caUrl} -o /tmp/acs-cymru-ca.pem && ` +
      `[ "$(openssl x509 -in /tmp/acs-cymru-ca.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64)" = "${input.pin}" ] && ` +
      "sudo install -m 644 /tmp/acs-cymru-ca.pem /usr/local/share/ca-certificates/acs-cymru.crt && sudo update-ca-certificates >/dev/null && "
    : "";
  const stage1 = `curl -fsSL -H "apikey: ${input.publishableKey}" -H "X-Enrolment-Token: ${input.token}" ` +
    `${input.publicUrl}/functions/v1/gateway-install | sudo env ACS_ENROLMENT_TOKEN=${input.token}` +
    (input.pin ? ` ACS_CA_PIN=${input.pin}` : "") + " bash";
  return stage0 + stage1;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { error: "Missing Authorization header" });
    }

    // GET is the readiness probe: can this deployment enrol an appliance? Both addresses are
    // reported, nothing is minted and no gateway is read, so any signed-in user may ask. The
    // dashboard asks before offering a remote gateway, which is where the answer is useful.
    if (req.method === "GET") {
      return readiness(authHeader);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = gatewayKey();

    // BOUND TO THE CALLER'S TOKEN. Every read and the RPC below run as them, so RLS applies and
    // this function cannot see or do more than the operator could themselves.
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);
    if (userError || !user) {
      return json(401, { error: "Invalid user token", details: userError?.message });
    }

    const userRole = await resolveUserRole(supabaseUser, user.id);
    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      // Operator and Auditor land here, and nothing has been minted yet: the check is ahead of the
      // RPC, so a refused request cannot consume a gateway's live token.
      return json(403, {
        error: "Forbidden: Insufficient privileges",
        details:
          "Generating a gateway bundle requires Administrator or Shopfloor_Manager. It mints an " +
          "enrolment token, which an appliance exchanges for a broker credential.",
      });
    }

    const body = await req.json().catch(() => ({}));
    const gatewayId = typeof body?.gateway_id === "string" ? body.gateway_id : "";
    const ttlMinutes = Number.isInteger(body?.ttl_minutes) ? body.ttl_minutes : 30;
    // "zip" (the default) downloads the bundle; "command" answers JSON with the one-liner.
    const format = body?.format === "command" ? "command" : "zip";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gatewayId)) {
      return json(400, {
        error: "gateway_id must be a UUID",
        details: "Sparkplug ids are not accepted here; the bundle is generated from the gateway row.",
      });
    }

    // The public URL is checked before anything is minted. It is the address the appliance dials
    // and cannot be derived from SUPABASE_URL, which resolves for nothing on a shopfloor; a bundle
    // carrying it would fail at the first fetch. Checked ahead of the RPC so a deployment fault
    // does not cost a token.
    const platform = platformPublicUrl();
    if (platform.problem) {
      console.error(`SUPABASE_PUBLIC_URL is '${platform.value}', which no appliance can reach`);
      return json(503, {
        error: "Bundle generation is not configured on this deployment",
        details:
          `SUPABASE_PUBLIC_URL is ${platform.problem} -- set it to the URL Remote gateways ` +
          "reach the platform on (global.publicBaseDomain in the chart's values). " +
          "No enrolment token was minted.",
      });
    }
    const publicUrl = platform.value;

    // Read the gateway BEFORE minting anything, so a bad id or a host-run gateway costs no token.
    const { data: gateway, error: gatewayError } = await supabaseUser
      .from("gateways")
      .select("id, name, sparkplug_id, sparkplug_group, deployment")
      .eq("id", gatewayId)
      .maybeSingle();

    if (gatewayError) {
      return json(500, { error: "Could not read the gateway", details: gatewayError.message });
    }
    if (!gateway) {
      return json(404, { error: "No such gateway" });
    }
    if (gateway.deployment === "host") {
      // The RPC refuses this too; caught here so the message names the reason. A host-run gateway
      // has no appliance, so a bundle for one would mint a broker credential nothing could present.
      return json(400, {
        error: "That gateway is Host, not Remote",
        details:
          "Enrolment bundles are for Remote gateways, which run on their own hardware. Set " +
          "this gateway's Type to Remote, or create a Remote one.",
      });
    }

    // Whether the one-liner can be served, checked BEFORE minting for the same reason as the
    // address above: a refusal must not cost the gateway its live token.
    const installer = format === "command" ? await installerAvailability() : null;
    if (installer && !installer.available) {
      console.error(`the install command cannot be minted: ${installer.reason}`);
      return json(503, {
        error: "The install command is not available on this deployment",
        details: `${installer.reason}. Download the bundle instead. No enrolment token was minted.`,
      });
    }

    // Check the appliance's files are present BEFORE minting, for the third time and the same
    // reason: a build missing them must not spend a gateway's live token discovering it.
    const missing = format === "zip"
      ? APPLIANCE_FILES.filter((name) => !(`${APPLIANCE_PREFIX}${name}` in GATEWAY_PLATFORM_FILES))
      : [];

    if (missing.length) {
      console.error(`gateway-bundle is missing appliance file(s): ${missing.join(", ")}`);
      return json(503, {
        error: "The bundle template is not available on this deployment",
        details:
          `Missing: ${missing.join(", ")}. scripts/sync-gateway-platform.mjs writes them into the ` +
          "platform module from forge/gateway-platform/appliance/. No enrolment token was minted.",
      });
    }

    // Mint the token. The database decides whether this caller may.
    const { data: issued, error: issueError } = await supabaseUser
      .rpc("issue_gateway_enrollment_token", {
        p_gateway_id: gatewayId,
        p_ttl_minutes: ttlMinutes,
      });

    if (issueError) {
      // `insufficient_privilege` should be unreachable -- the role was checked above -- but a
      // revocation between the two is possible, and answering 403 is more honest than 500.
      const denied = /insufficient/i.test(issueError.message);
      return json(denied ? 403 : 400, {
        error: "Could not issue an enrolment token",
        details: issueError.message,
      });
    }

    const record = (issued as Array<{ token: string; expires_at: string }> | null)?.[0];
    if (!record?.token) {
      return json(500, { error: "The enrolment token could not be minted" });
    }

    if (installer) {
      const command = installCommand({
        publicUrl,
        publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
        token: record.token,
        pin: installer.pin,
        caUrl: installer.caUrl,
      });
      console.log(
        `issued an install command for ${gateway.name} (${gateway.sparkplug_id}) to ${user.id} ` +
        `[${userRole}]; token expires ${record.expires_at}; ${installer.pin ? "pinned" : "UNPINNED (plain HTTP, development)"}`,
      );
      return new Response(JSON.stringify({
        token: record.token,
        expires_at: record.expires_at,
        sparkplug_id: gateway.sparkplug_id,
        gateway_name: gateway.name,
        bundle_version: BUNDLE_VERSION,
        command,
        install_url: `${publicUrl}/functions/v1/gateway-install`,
        ca_url: installer.caUrl,
        ca_pin: installer.pin,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Assemble the archive. One top-level folder named for the gateway, so four downloads in one
    // place stay distinguishable and do not overwrite each other on unpacking.
    const folder = `acs-gateway-${slug(gateway.name)}-${gateway.sparkplug_id}`;

    const files: Record<string, Uint8Array> = {};
    for (const name of APPLIANCE_FILES) {
      files[`${folder}/${name}`] = strToU8(GATEWAY_PLATFORM_FILES[`${APPLIANCE_PREFIX}${name}`]);
    }

    // The .env is generated, not templated: it is the only file that differs per gateway and the
    // only one carrying the token. Rendered by _shared/gatewayEnv.ts, which the installer's
    // token-gated fetch shares.
    files[`${folder}/.env`] = strToU8(renderGatewayEnv({
      gatewayName: gateway.name,
      sparkplugId: gateway.sparkplug_id,
      publicUrl,
      publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      token: record.token,
      expiresAt: record.expires_at,
      credentialSecret: newCredentialSecret(),
      via: "bundle",
    }));

    // A per-gateway note at the top of the folder, so an unpacked bundle is self-identifying. The
    // bundle for the wrong gateway is otherwise indistinguishable from the right one until booted.
    files[`${folder}/GATEWAY.txt`] = strToU8(`Aber Remote gateway bundle
=================================

  Gateway          : ${gateway.name}
  Sparkplug node   : ${gateway.sparkplug_id}
  Sparkplug group  : ${gateway.sparkplug_group}
  Bundle version   : ${BUNDLE_VERSION}
  Generated        : ${new Date().toISOString()}
  Token expires    : ${record.expires_at}

This bundle enrols ONE appliance as the gateway named above. Copy this whole folder to that
machine and run:

    docker compose up -d --build
    docker compose logs bootstrap

The second command prints the Node-RED editor password. It is shown ONCE.

See README.md for the rest, including what to do if the token has expired.
`);

    const archive = zipSync(files, {
      // Stored, not deflated: small text files that can be read with `unzip -p` on a machine with
      // no tooling.
      level: 0,
      mtime: new Date(),
    });

    const filename = `${folder}.zip`;

    console.log(
      `issued a bundle for ${gateway.name} (${gateway.sparkplug_id}) to ${user.id} ` +
      `[${userRole}]; token expires ${record.expires_at}`
    );

    return new Response(archive, {
      status: 200,
      headers: {
        ...corsHeaders,
        // application/zip, and the caller must use a raw fetch() rather than supabase-js's
        // functions.invoke(), which decodes anything that is not JSON or octet-stream as text and
        // corrupts the archive. Same constraint as the AASX path in aas-export.
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // A binary body has nowhere to carry these. Separate headers rather than one JSON blob so a
        // caller can read the expiry without parsing anything -- the UI shows it as a countdown.
        "X-ACS-Token-Expires-At": record.expires_at,
        "X-ACS-Bundle-Version": BUNDLE_VERSION,
        "X-ACS-Sparkplug-Id": gateway.sparkplug_id,
        "Access-Control-Expose-Headers":
          "X-ACS-Token-Expires-At, X-ACS-Bundle-Version, X-ACS-Sparkplug-Id, Content-Disposition",
        // Never cached anywhere: the body carries a single-use claim.
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("gateway-bundle failed:", err);
    return json(500, { error: "Could not generate the bundle", details: err?.message });
  }
}

serve(handler);
