import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

/**
 * Package the physical gateway bootstrap bundle as a ZIP, with a freshly minted enrolment token.
 *
 * THE MIRROR IMAGE OF enroll-gateway. That function has no user and is authorised by a token; this
 * one has no token and is authorised by a ROLE. Issuing a bundle mints a claim that an appliance
 * exchanges for a broker credential, so it carries the same authority as every other
 * gateway-management act: Administrator or Shopfloor_Manager, and nothing else.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TOKEN IS MINTED THROUGH THE RPC, AS THE CALLER, NOT WITH THE SERVICE-ROLE KEY.
 *
 * `issue_gateway_enrollment_token()` is SECURITY DEFINER and checks `public.has_role()` itself, so
 * the database makes the authority decision -- once, in the same place the RLS policies make it.
 * The role check below is therefore not the security boundary; it exists so a refusal answers 403
 * with a usable message instead of surfacing an `insufficient_privilege` raise as a 500.
 *
 * This function holds NO service-role key. It cannot read the token table, cannot reach the
 * credential service, and cannot enrol anything. Its ceiling is what the caller could already do
 * through PostgREST.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS IN THE BUNDLE, AND WHAT IS DELIBERATELY NOT.
 *
 * A CLAIM, NEVER A CREDENTIAL. There is no broker password anywhere in the archive -- the appliance
 * obtains one for itself at first boot, which is the entire reason a short-lived single-use token is
 * used instead. A password in a file that travels through a downloads folder, a USB stick and
 * probably an email would have no revocation story at all.
 *
 * The `NODERED_CREDENTIAL_SECRET` is generated PER BUNDLE. It encrypts the appliance's local
 * flows_cred.json once enrolment has produced a password to put in it. A constant here would mean
 * one appliance's credential file could be decrypted with any other bundle's .env.
 */

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

/**
 * The bundle's own version. Stamped into .env, sent back in a header, and recorded on the gateway
 * at enrolment.
 *
 * A bundle generated once lives on somebody's hardware indefinitely, so "which vintage is this
 * appliance running" has to be answerable from the dashboard rather than by getting a shell on it.
 * Bump this when the template changes in a way an already-deployed appliance would care about.
 */
const BUNDLE_VERSION = "1.0.0";

/**
 * The template files, delivered through the environment.
 *
 * READ BY THE ENTRYPOINT, NOT BY THIS WORKER, and that is the same constraint deploy-nodered
 * documents: an edge-runtime USER WORKER has no filesystem access to the mounted volumes, so these
 * files cannot be opened here even though they are on disk in the container. main/index.ts forwards
 * every env var to each worker it spawns, so the entrypoint reads them once at start-up.
 *
 * Module IMPORTS are unaffected (see _shared/roles.ts) -- reading FILES at runtime is a different
 * mechanism and a different permission.
 */
const TEMPLATE_ENV: Record<string, string> = {
  "docker-compose.yml": "GW_BUNDLE_COMPOSE",
  "Dockerfile": "GW_BUNDLE_DOCKERFILE",
  "bootstrap.mjs": "GW_BUNDLE_BOOTSTRAP",
  "flows.template.json": "GW_BUNDLE_FLOWS",
  "README.md": "GW_BUNDLE_README",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * A filesystem- and header-safe slug.
 *
 * Constrained to [\w.-] because the result lands in a Content-Disposition filename and in a
 * directory name inside the archive. A gateway called `Cell 4 / Press Line` would otherwise produce
 * a path separator in a zip entry, which unpacks somewhere nobody asked for.
 */
function slug(name: string): string {
  return (name || "gateway")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48) || "gateway";
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { error: "Missing Authorization header" });
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
      // Operator and Auditor land here, and NOTHING HAS BEEN MINTED YET -- the check is ahead of
      // the RPC deliberately, so a refused request cannot consume a gateway's live token and
      // invalidate a bundle somebody else is holding.
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

    // ---------------------------------------------------------------------------------------------
    // THE PUBLIC URL IS CHECKED BEFORE ANYTHING IS MINTED.
    //
    // This is the address the APPLIANCE dials, and it cannot be derived from SUPABASE_URL: inside
    // the stack that is `supabase-kong:8000` (or a loopback address on Compose), which resolves for
    // nothing on a shopfloor. A bundle carrying it enrols... nothing -- bootstrap fails at the first
    // fetch with a connection error naming a URL that looks plausible.
    //
    // Same reasoning as AAS_MODEL_PUBLIC_BASE and as enroll-gateway's MQTT_PUBLIC_HOST guard, and
    // checked ahead of the RPC for the same reason as the role check: a deployment fault must not
    // cost a token.
    // ---------------------------------------------------------------------------------------------
    const publicUrl = (Deno.env.get("SUPABASE_PUBLIC_URL") || "").replace(/\/+$/, "");
    if (!publicUrl || /supabase-kong|127\.0\.0\.1|localhost|::1/.test(publicUrl)) {
      console.error(`SUPABASE_PUBLIC_URL is '${publicUrl}', which no appliance can reach`);
      return json(503, {
        error: "Bundle generation is not configured on this deployment",
        details:
          `SUPABASE_PUBLIC_URL is ${publicUrl ? `'${publicUrl}'` : "unset"} -- an address that ` +
          "resolves only inside the stack. Set it to the URL physical gateways reach the platform " +
          "on. No enrolment token was minted.",
      });
    }

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
      // The RPC refuses this too; caught here so the message names the reason rather than arriving
      // as a database error. A host-run gateway has no appliance, so a bundle for one would mint a
      // broker credential nothing could ever present.
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

    // ---------------------------------------------------------------------------------------------
    // Mint the token. THE DATABASE decides whether this caller may.
    // ---------------------------------------------------------------------------------------------
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

    // ---------------------------------------------------------------------------------------------
    // Assemble the archive.
    // ---------------------------------------------------------------------------------------------
    // ONE TOP-LEVEL FOLDER, NAMED FOR THE GATEWAY. Four appliances provisioned in a morning means
    // four downloads in one place, and an archive that unpacks its files into the current directory
    // is both indistinguishable from its siblings and liable to overwrite one of them.
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

    // THE .env IS GENERATED, NOT TEMPLATED -- it is the only file that differs per gateway and the
    // only one carrying the token. Written as a real .env rather than an .env.example so
    // `docker compose up` works with no editing: an appliance being commissioned by an electrician
    // should not need a text editor.
    //
    // EVERY NAME HERE IS READ BY bootstrap.mjs. They are not free-form: ACS_SUPABASE_URL,
    // ACS_SUPABASE_ANON_KEY, ACS_ENROLLMENT_TOKEN, ACS_AGENT_VERSION, ACS_GATEWAY_NAME and
    // NODERED_CREDENTIAL_SECRET are what that script looks up, and a rename on either side produces
    // an appliance that reports a missing variable at first boot with the token already spent.
    //
    // WHICH IS WHY THE NEW KEY IS ADDED RATHER THAN SUBSTITUTED. Bundles already downloaded carry
    // ACS_SUPABASE_ANON_KEY and nothing else; an appliance commissioned from one of those must
    // still boot. So both are written, bootstrap.mjs prefers the publishable one, and a bundle
    // generated on a legacy-only install simply carries an empty value for it.
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
# enrolment request past the gateway's key-auth; the token below is what actually authorises it.
#
# TWO FORMATS, AND THE APPLIANCE PREFERS THE SECOND. Supabase deprecates the anon JWT by the end
# of 2026; the platform's gateway accepts both at once, so this bundle carries whichever this
# install has. An empty publishable key here means the platform has not minted one yet.
ACS_SUPABASE_ANON_KEY=${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}
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
      // STORED, not deflated. These are small text files, the appliance unpacks them once, and a
      // stored archive can be read with anything -- including `unzip -p` on a machine with no
      // tooling, which is the situation this bundle is designed for.
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
        // application/zip, and the caller MUST use a raw fetch() rather than supabase-js's
        // functions.invoke(): invoke decodes anything that is not JSON or octet-stream as TEXT,
        // which silently corrupts the archive. Same constraint as the AASX path in aas-export.
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
