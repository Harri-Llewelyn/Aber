import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { brokerPublicHost, platformPublicUrl } from "../_shared/publicAddresses.ts";

/**
 * Package the physical gateway bootstrap bundle as a ZIP, with a freshly minted enrolment token.
 * The mirror image of enroll-gateway: no token, authorised by role (Administrator or
 * Shopfloor_Manager). The token is minted through `issue_gateway_enrollment_token()`, SECURITY
 * DEFINER and checking `public.has_role()` itself, as the caller and not with the service-role key,
 * so the role check below exists only so a refusal answers 403 with a usable message. This function
 * holds no service-role key; its ceiling is what the caller could already do through PostgREST.
 *
 * The bundle carries a claim, never a credential: there is no broker password in the archive, and
 * the appliance obtains one at first boot. `NODERED_CREDENTIAL_SECRET` is generated per bundle, so
 * one appliance's credential file cannot be decrypted with another bundle's .env.
 */

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

/**
 * The bundle's own version, stamped into .env, sent back in a header, and recorded on the gateway
 * at enrolment, so the dashboard can say which vintage an appliance runs. Bump when the template
 * changes in a way a deployed appliance would care about.
 */
const BUNDLE_VERSION = "1.1.0";

/**
 * The template files, delivered through the environment: an edge-runtime user worker has no
 * filesystem access to the mounted volumes, so the entrypoint reads them once at start-up and the
 * router forwards them. Module imports are unaffected (see _shared/roles.ts).
 */
const TEMPLATE_ENV: Record<string, string> = {
  "docker-compose.yml": "GW_BUNDLE_COMPOSE",
  "Dockerfile": "GW_BUNDLE_DOCKERFILE",
  "bootstrap.mjs": "GW_BUNDLE_BOOTSTRAP",
  "flows.template.json": "GW_BUNDLE_FLOWS",
  // The puller (flow-sync.mjs). Without it in this map the appliance's compose file names a service
  // whose script is not in the archive, so this entry, the entrypoint that exports it and main's
  // allowlist move together.
  "flow-sync.mjs": "GW_BUNDLE_FLOW_SYNC",
  "README.md": "GW_BUNDLE_README",
};

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
 * The readiness answer. `ready` is true only when both addresses would be accepted by the two
 * functions that check them; `addresses` names each one and the problem, so the dashboard can
 * say which variable to set rather than that something is wrong.
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
  return json(200, {
    ready: addresses.every((a) => !a.problem),
    addresses,
  });
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
          `SUPABASE_PUBLIC_URL is ${platform.problem} -- set it to the URL physical gateways ` +
          "reach the platform on, in .env on Compose. No enrolment token was minted.",
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
        error: "That gateway is virtual",
        details:
          "Enrolment bundles are for physical appliances. Clear 'Mark as Virtual Gateway' on the " +
          "gateway first, or create a physical one.",
      });
    }

    // Check the templates are present BEFORE minting, for the third time and the same reason: a
    // deployment missing its templates must not spend a gateway's live token discovering it.
    const missing = Object.entries(TEMPLATE_ENV)
      .filter(([, envVar]) => !Deno.env.get(envVar))
      .map(([name, envVar]) => `${name} (${envVar})`);

    if (missing.length) {
      console.error(`gateway-bundle is missing template file(s): ${missing.join(", ")}`);
      return json(503, {
        error: "The bundle template is not available on this deployment",
        details:
          `Missing: ${missing.join(", ")}. The supabase-functions entrypoint populates these from ` +
          "gateway-bundle-template/. No enrolment token was minted.",
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

    // Assemble the archive. One top-level folder named for the gateway, so four downloads in one
    // place stay distinguishable and do not overwrite each other on unpacking.
    const folder = `acs-gateway-${slug(gateway.name)}-${gateway.sparkplug_id}`;

    // 32 bytes of hex. Encrypts the appliance's flows_cred.json; generated per bundle so no two
    // appliances share one, and never transmitted anywhere else.
    const credentialSecret = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");

    const files: Record<string, Uint8Array> = {};
    for (const [name, envVar] of Object.entries(TEMPLATE_ENV)) {
      files[`${folder}/${name}`] = strToU8(Deno.env.get(envVar)!);
    }

    // The .env is generated, not templated: it is the only file that differs per gateway and the
    // only one carrying the token. Written as a real .env so `docker compose up` works with no
    // editing. Every name here is read by bootstrap.mjs: ACS_SUPABASE_URL,
    // ACS_SUPABASE_PUBLISHABLE_KEY, ACS_ENROLLMENT_TOKEN, ACS_AGENT_VERSION, ACS_GATEWAY_NAME and
    // NODERED_CREDENTIAL_SECRET.
    files[`${folder}/.env`] = strToU8(`# =============================================================================
# ACS-Cymru physical gateway -- ${gateway.name}
#
# GENERATED ${new Date().toISOString()} FOR ONE GATEWAY. Not reusable: the token below is
# single-use and bound to ${gateway.sparkplug_id}.
#
# THE TOKEN EXPIRES ${record.expires_at}. After that, generate a new bundle from the
# gateway's page in the dashboard -- regenerating invalidates this one.
# =============================================================================

# The platform, as reached FROM THIS APPLIANCE.
ACS_SUPABASE_URL=${publicUrl}

# Public by construction -- the same key every browser running the dashboard holds. It gets the
# enrolment request past the gateway's key check; the token below is what actually authorises it.
ACS_SUPABASE_PUBLISHABLE_KEY=${Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? ""}

# SINGLE USE. Redeemed by bootstrap.mjs on first boot and spent thereafter, whether or not that boot
# succeeded. If bootstrap reports the token was RELEASED (a transient broker outage), this same
# value works again -- just start the container.
#
# THERE IS NO BROKER PASSWORD IN THIS FILE, and there must never be one. The appliance obtains its
# own at first boot, which is the whole reason this is a short-lived claim instead of a credential.
ACS_ENROLLMENT_TOKEN=${record.token}

# Encrypts /data/flows_cred.json on the appliance, where the broker password ends up. GENERATED FOR
# THIS BUNDLE ALONE: a shared value would let one appliance's credential file be decrypted with
# another's .env. Losing it means re-enrolling -- the broker stores only a hash, so the password
# cannot be recovered from either side.
NODERED_CREDENTIAL_SECRET=${credentialSecret}

# Recorded on the gateway at enrolment, so the fleet's vintage is visible from the dashboard.
ACS_AGENT_VERSION=${BUNDLE_VERSION}

# Display name only -- used in the Node-RED editor's title and in bootstrap's output. The gateway's
# real identity is its sparkplug_id, which arrives from enrolment and cannot be set here.
ACS_GATEWAY_NAME=${gateway.name}
`);

    // A per-gateway note at the top of the folder, so an unpacked bundle is self-identifying. The
    // bundle for the wrong gateway is otherwise indistinguishable from the right one until booted.
    files[`${folder}/GATEWAY.txt`] = strToU8(`ACS-Cymru physical gateway bundle
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
