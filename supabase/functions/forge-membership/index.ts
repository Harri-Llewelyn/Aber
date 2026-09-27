import { createClient } from "@supabase/supabase-js";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * Places a forge login in the team its Postgres role maps to, and takes it out of the one it does
 * not, on the way through the forge's door. This is the `ext_authz` step of the `forge` listener in
 * supabase/envoy.yaml: every non-static request reaches here with the caller's verified access
 * token, and this resolves their role from `user_roles` (the only source) and places them through
 * the machine account. Revocation is immediate: a token whose role has been removed is refused on
 * its next request.
 *
 * The first request finds no user, since Gitea creates it while serving that request; the page then
 * fetches `/repo/search` and `/user/events`, which come through here with the user present, so
 * placement happens before the repository list is answered.
 *
 * Answers: 200, the caller holds an admitted role and is in its team (or is not yet registered);
 * 302, the token verified but GoTrue no longer has its session, so the browser is sent to the
 * door's sign-out path; 403, the caller's role does not open the forge, with the login removed from
 * both teams first; 5xx, this could not do its job, and the listener's `failure_mode_allow` lets
 * the request through on the role the token carries, losing only placement.
 *
 * The machine account is the only Gitea credential here, and the identity acted on is always the
 * verified token's `sub`, never a parameter. A person who never returns is unseated by
 * `forge-sweep`, which re-does this placement over the forge's own member lists on a timer (0099).
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import {
  ensureOrganisation,
  ensurePlatformOrganisation,
  FORGE_TEAMS,
  type ForgeConfig,
  type ForgeTeamRole,
  forgeApi,
  forgeConfig,
  PLATFORM_READERS_TEAM,
} from "../_shared/forge.ts";

/**
 * How long a placement is believed before it is re-done: long enough that a page's dozen requests
 * cost one round of calls, short enough that a role change lands within minutes. Revocation is not
 * bounded by this; the role lookup runs on every request.
 */
const PLACEMENT_TTL_MS = 5 * 60 * 1000;

interface Placement {
  role: ForgeTeamRole;
  at: number;
}

// Per-worker, so a cold worker simply re-places. Nothing here is authoritative.
const placed = new Map<string, Placement>();
let teamIds: Record<ForgeTeamRole, number> | null = null;
/** The platform organisation's readers team, which every admitted role is seated in. */
let readersId: number | null = null;

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
 * Exactly one gateway team, or none, and the platform readers team with either. The removal runs
 * even when the addition does, so a role that moved from one team to the other leaves the first.
 */
async function placeInTeams(
  cfg: ForgeConfig,
  ids: Record<ForgeTeamRole, number>,
  readers: number,
  username: string,
  role: ForgeTeamRole | null,
): Promise<void> {
  const seats: { id: number; team: string; wanted: boolean }[] = [
    ...(Object.keys(FORGE_TEAMS) as ForgeTeamRole[]).map((candidate) => ({
      id: ids[candidate],
      team: FORGE_TEAMS[candidate],
      wanted: candidate === role,
    })),
    { id: readers, team: PLATFORM_READERS_TEAM, wanted: role !== null },
  ];
  for (const { id, team, wanted } of seats) {
    if (wanted) {
      const added = await forgeApi(cfg, "PUT", `/teams/${id}/members/${username}`);
      if (!added.ok) {
        throw new Error(`could not place '${username}' in '${team}' (${added.status})`);
      }
    } else {
      const removed = await forgeApi(cfg, "DELETE", `/teams/${id}/members/${username}`);
      // 404 is "was not a member", which is what almost every request answers.
      if (!removed.ok && removed.status !== 404) {
        throw new Error(`could not remove '${username}' from '${team}' (${removed.status})`);
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
    // A dead session is sent back through the door, not refused: the listener accepted this token,
    // and only GoTrue knows the session behind it is gone. A 401 would leave the browser stuck on a
    // cookie the door still honours, so the answer is a redirect to the door's own sign-out path,
    // which clears every cookie and starts a fresh login. Envoy forwards a denied response's status
    // and its `location` header.
    console.log(`forge-membership: ${userError?.message ?? "no user"}; sending the browser back through the door`);
    return new Response(
      JSON.stringify({ error: "Session ended", details: userError?.message, next: "/oauth2/signout" }),
      { status: 302, headers: { ...corsHeaders, "Content-Type": "application/json", Location: "/oauth2/signout" } },
    );
  }

  // Authorisation: user_roles, read with the service key -- a lookup, not a decision made by the
  // caller's own access. A failed lookup is not evidence of a role; it is a 5xx below.
  const asService = serviceRoleClient(supabaseUrl, serviceKey);
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
    if (readersId === null) readersId = await ensurePlatformOrganisation(cfg);

    if (!(await forgeUserExists(cfg, username))) {
      // The first request through the door: Gitea has not created the user yet. The next request
      // will find them. NOT cached, for exactly that reason.
      placed.delete(username);
      if (!admitted) {
        return json({ error: `Role '${role ?? "none"}' does not open the forge` }, 403);
      }
      return json({ sub: username, role, team: FORGE_TEAMS[role], placed: false, reason: "not yet registered" }, 200);
    }

    await placeInTeams(cfg, teamIds, readersId, username, admitted ? role : null);

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
    readersId = null;
    placed.delete(username);
    console.error(`forge-membership: placement FAILED for ${user.email} (${username}): ${err instanceof Error ? err.message : err}`);
    return json({ error: "Could not place the caller in a forge team", details: err instanceof Error ? err.message : String(err) }, 502);
  }
}

Deno.serve(handler);
