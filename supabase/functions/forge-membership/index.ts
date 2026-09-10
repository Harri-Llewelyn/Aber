import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Places a forge login in the team its Postgres role maps to -- and takes it out of the one it
 * does not -- on the way through the forge's door.
 *
 * =================================================================================================
 * WHY THIS EXISTS, AND WHY IT IS CALLED FROM THE GATEWAY RATHER THAN FROM A PAGE
 *
 * The forge's login is the `forge` listener in supabase/envoy.yaml (0094): Envoy runs the OAuth
 * flow, verifies the token, admits Administrator and Shopfloor_Manager, and hands the identity to
 * Gitea as reverse-proxy headers. Gitea then auto-registers the user -- and stops. An
 * auto-registered user owns nothing, every gateway repository is private to the `gateways`
 * organisation, and nothing native to Gitea adds a person to an organisation. So the first login
 * was a forge with no repositories in it.
 *
 * This is the `ext_authz` step of that listener. Every non-static request through the door reaches
 * here first with the caller's verified access token; this resolves their role from `user_roles`
 * -- the only source, for the reason nodered-userinfo gives -- and ensures they are in exactly the
 * team that role warrants, through the machine account that owns the organisation. Roadmap 7
 * chose this over a reconciler on a timer because it is one request per login, the role decision
 * is made by the same code that makes it for Node-RED and Grafana, and REVOCATION IS IMMEDIATE:
 * a token whose role has since been removed from `user_roles` is refused here on its next request,
 * where the listener's own RBAC would have honoured it until the token expired.
 *
 * =================================================================================================
 * THE FIRST REQUEST FINDS NO USER, AND THAT IS FINE
 *
 * Gitea creates the user while serving the first request, which is after this has answered it. So
 * on that request the lookup answers 404 and this returns 200 having placed nobody. The page Gitea
 * then renders fetches `/repo/search` and `/user/events` before it is finished drawing, each of
 * which comes through here again with the user now present -- so the placement happens before the
 * repository list is answered, and the first page a person sees is complete. Measured, not hoped.
 *
 * =================================================================================================
 * WHAT A FAILURE MEANS, AND THE THREE ANSWERS THIS GIVES
 *
 *   200  the caller holds an admitted role and is in its team (or is not yet registered).
 *   302  the token verified but GoTrue no longer has its session -- a dashboard sign-out, a
 *        global sign-out, a timebox. Redirects to the door's sign-out path, which clears the
 *        cookies and starts a fresh login; a 401 would leave the browser stuck on a cookie the
 *        door still honours.
 *   403  the caller's role does not open the forge. The listener's RBAC already refused the two
 *        roles that never had one; this catches the role that was REMOVED since the token was
 *        signed -- and takes the login out of both teams first, so a revoked administrator's SSH
 *        key stops working on the same request rather than at the next sweep.
 *   5xx  this could not do its job -- the forge is unreachable, the role lookup failed. The
 *        listener runs with `failure_mode_allow`, so a 5xx lets the request THROUGH: the RBAC
 *        filter has already admitted the role in the token, and a forge outage should not take
 *        the forge's web UI down with it. What is lost is placement, and the log says so.
 *
 * Denying on 5xx would be the tidier rule and the wrong one: it makes every forge page depend on
 * the edge runtime and on Postgres, for a decision the token already carries.
 *
 * =================================================================================================
 * THE MACHINE ACCOUNT IS THE ONLY GITEA CREDENTIAL HERE, and its authority is bounded by what it
 * owns. It can place a member in a team of its own organisation; it cannot make anyone a site
 * administrator, and it cannot read a repository outside the organisation. A caller cannot make
 * this function act on anyone but themselves: the identity is the verified token's `sub`, never a
 * parameter.
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import {
  ensureOrganisation,
  FORGE_TEAMS,
  type ForgeConfig,
  type ForgeTeamRole,
  forgeApi,
  forgeConfig,
} from "../_shared/forge.ts";

/**
 * How long a placement is believed before it is re-done. Long enough that a page's dozen
 * requests cost one round of calls; short enough that a role change lands within minutes for a
 * person who keeps the forge open. Revocation is NOT bounded by this: the role lookup below runs
 * on every request, and a removed role is refused at once -- only the Gitea-side placement is
 * cached.
 */
const PLACEMENT_TTL_MS = 5 * 60 * 1000;

interface Placement {
  role: ForgeTeamRole;
  at: number;
}

// Per-worker, so a cold worker simply re-places. Nothing here is authoritative.
const placed = new Map<string, Placement>();
let teamIds: Record<ForgeTeamRole, number> | null = null;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isAdmitted(role: string | null): role is ForgeTeamRole {
  return role !== null && Object.hasOwn(FORGE_TEAMS, role);
}

/** Whether Gitea has registered this login yet. 404 on the first request is the ordinary case. */
async function forgeUserExists(cfg: ForgeConfig, username: string): Promise<boolean> {
  const response = await forgeApi(cfg, "GET", `/users/${username}`);
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`could not look up '${username}' in the forge (${response.status})`);
}

/**
 * Exactly one team, or none. The removal runs even when the addition does, so a role that moved
 * from one team to the other leaves the first.
 */
async function placeInTeams(
  cfg: ForgeConfig,
  ids: Record<ForgeTeamRole, number>,
  username: string,
  role: ForgeTeamRole | null,
): Promise<void> {
  for (const candidate of Object.keys(FORGE_TEAMS) as ForgeTeamRole[]) {
    const id = ids[candidate];
    if (candidate === role) {
      const added = await forgeApi(cfg, "PUT", `/teams/${id}/members/${username}`);
      if (!added.ok) {
        throw new Error(`could not place '${username}' in '${FORGE_TEAMS[candidate]}' (${added.status})`);
      }
    } else {
      const removed = await forgeApi(cfg, "DELETE", `/teams/${id}/members/${username}`);
      // 404 is "was not a member", which is what almost every request answers.
      if (!removed.ok && removed.status !== 404) {
        throw new Error(`could not remove '${username}' from '${FORGE_TEAMS[candidate]}' (${removed.status})`);
      }
    }
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = authHeader.slice("Bearer ".length);

  // Authentication: the token the listener verified is verified again here, against GoTrue rather
  // than against the shared secret, which is what also catches a session signed out since.
  const asCaller = createClient(supabaseUrl, gatewayKey(), {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await asCaller.auth.getUser(token);
  if (userError || !user) {
    // A DEAD SESSION IS SENT BACK THROUGH THE DOOR, NOT REFUSED. The listener's oauth2 filter and
    // jwt_authn both accepted this token -- its signature is good and it has not expired -- and
    // only GoTrue knows the session behind it is gone: a dashboard sign-out, a global sign-out, a
    // session timebox. A 401 here would be forwarded to the browser as a JSON body and nothing
    // would restart the login, because the door still sees a cookie it minted; the person is stuck
    // until it expires, up to an hour. So the answer is a redirect to the door's own sign-out
    // path, which clears every cookie and lands on `/`, where the absence of a cookie starts a
    // fresh login. Envoy forwards a denied response's status and its `location` header. This is
    // the one place in the stack a door notices a session died, and Studio's cannot do it.
    console.log(`forge-membership: ${userError?.message ?? "no user"}; sending the browser back through the door`);
    return new Response(
      JSON.stringify({ error: "Session ended", details: userError?.message, next: "/oauth2/signout" }),
      { status: 302, headers: { ...corsHeaders, "Content-Type": "application/json", Location: "/oauth2/signout" } },
    );
  }

  // Authorisation: user_roles, read with the service key -- a lookup, not a decision made by the
  // caller's own access. A failed lookup is not evidence of a role; it is a 5xx below.
  const asService = createClient(supabaseUrl, serviceKey);
  let role: string | null;
  try {
    role = await resolveUserRole(asService, user.id);
  } catch (err) {
    console.error(`forge-membership: role lookup threw for ${user.id}: ${err instanceof Error ? err.message : err}`);
    return json({ error: "Could not resolve the caller's role" }, 503);
  }

  const cfg = forgeConfig();
  if (!cfg) {
    // A door with no forge behind it. The listener lets this through; there is nothing to place.
    return json({ error: "This deployment has no forge configured" }, 503);
  }

  const username = user.id;
  const admitted = isAdmitted(role);

  try {
    const cached = placed.get(username);
    if (admitted && cached && cached.role === role && Date.now() - cached.at < PLACEMENT_TTL_MS) {
      return json({ sub: username, role, team: FORGE_TEAMS[role], placed: true, cached: true }, 200);
    }

    if (!teamIds) teamIds = await ensureOrganisation(cfg);

    if (!(await forgeUserExists(cfg, username))) {
      // The first request through the door: Gitea has not created the user yet. The next request
      // will find them. NOT cached, for exactly that reason.
      placed.delete(username);
      if (!admitted) {
        return json({ error: `Role '${role ?? "none"}' does not open the forge` }, 403);
      }
      return json({ sub: username, role, team: FORGE_TEAMS[role], placed: false, reason: "not yet registered" }, 200);
    }

    await placeInTeams(cfg, teamIds, username, admitted ? role : null);

    if (!admitted) {
      placed.delete(username);
      console.warn(`forge-membership: ${user.email} (${username}) holds role '${role ?? "none"}' and was removed from every team`);
      return json({ error: `Role '${role ?? "none"}' does not open the forge` }, 403);
    }

    if (!cached || cached.role !== role) {
      console.log(`forge-membership: ${user.email} (${username}) placed in '${FORGE_TEAMS[role]}'`);
    }
    placed.set(username, { role, at: Date.now() });
    return json({ sub: username, role, team: FORGE_TEAMS[role], placed: true }, 200);
  } catch (err) {
    // A 5xx lets the request through (failure_mode_allow) and says why here; the person sees the
    // forge with whatever membership they already had.
    teamIds = null;
    placed.delete(username);
    console.error(`forge-membership: placement FAILED for ${user.email} (${username}): ${err instanceof Error ? err.message : err}`);
    return json({ error: "Could not place the caller in a forge team", details: err instanceof Error ? err.message : String(err) }, 502);
  }
}

serve(handler);
