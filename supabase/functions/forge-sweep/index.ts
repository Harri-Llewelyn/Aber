import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * The forge, reconciled on a timer. `forge-membership` places and removes people as they pass the
 * door, so a login whose role was revoked and who never returns keeps its team membership, usable
 * over SSH if they had added a key; and a gateway repository from before the push webhook existed
 * has no hook until its gateway is re-enrolled. This is the same placement over Gitea's own member
 * lists and the same furnishing over the organisation's repositories, asked for by `sweep_forge()`
 * (0099) through pg_net every fifteen minutes.
 *
 * One pass: every member of either team whose `user_roles` row no longer maps to that team is
 * removed; every login the forge knows that holds an admitted role is placed in its team; every
 * gateway repository has its push webhook, `main` closed to pushes, the `appliance` rule that
 * admits deploy keys alone and the `**` rule that admits none, and its deploy keys reconciled
 * with the gateway row (an active gateway's keys are read-write on its own repository, an archived
 * or deleted gateway's are removed, which is the third revocation handle beside `disableClient`
 * and the enrolment token); and every other repository in the organisation -- a playbook somebody
 * made by hand -- has `main` protected the same way, without the incident template, because a
 * flow a gateway may later adopt should have been reviewed from the start. Nothing is created that
 * enrolment would not create; the only deletion is a key. A member who is not a dashboard identity
 * was put there by hand and is left alone.
 *
 * Authorised by FORGE_SWEEP_SECRET in `x-sweep-secret`, not by the anon key: the edge runtime boots
 * with VERIFY_JWT=false, and the gateway's key check proves only that the caller holds a key that
 * ships in every browser bundle. An unset secret is 503, never a pass. The identities acted on come
 * from `user_roles` and the forge's lists, never from a parameter, so a caller holding the secret
 * can only make the forge more correct, and sooner.
 */

import {
  deleteDeployKey,
  ensureApplianceProtection,
  ensureBranchProtection,
  ensureDeployKey,
  ensureOrganisation,
  ensureWebhook,
  FORGE_ORGANISATION,
  FORGE_TEAMS,
  type ForgeConfig,
  type ForgeTeamRole,
  forgeApi,
  forgeConfig,
  GATEWAY_REPOSITORY,
  listDeployKeys,
} from "../_shared/forge.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SWEEP_SECRET = Deno.env.get("FORGE_SWEEP_SECRET") ?? "";

/**
 * A login forge-membership placed is the user's id, verbatim. Anything else in a team was seated
 * by a person in the forge's own UI and is not this function's to unseat.
 */
const DASHBOARD_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gitea's page size ceiling is configurable and 50 is under every default. */
const PAGE = 50;

interface Summary {
  placed: string[];
  removed: string[];
  hooked: string[];
  protected: string[];
  /** Keys re-registered read-write on an active gateway's repository. */
  rekeyed: string[];
  /** Keys removed from an archived or deleted gateway's repository. */
  revoked: string[];
  errors: string[];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time comparison: `===` on a secret leaks its prefix through timing. */
function secretMatches(presented: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(SWEEP_SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isAdmitted(role: string | null | undefined): role is ForgeTeamRole {
  return typeof role === "string" && Object.hasOwn(FORGE_TEAMS, role);
}

/** Every page of a Gitea list. */
async function listAll<T>(cfg: ForgeConfig, path: string, what: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await forgeApi(cfg, "GET", `${path}${separator}page=${page}&limit=${PAGE}`);
    if (!response.ok) throw new Error(`could not list ${what} (${response.status})`);
    const batch = await response.json() as T[];
    all.push(...batch);
    if (batch.length < PAGE) return all;
  }
}

/**
 * The membership half. `user_roles` is the only source (roles.ts says why a token claim never
 * is); the forge's member lists are what is reconciled against it.
 */
async function sweepMembership(
  cfg: ForgeConfig,
  admin: ReturnType<typeof serviceRoleClient>,
  teamIds: Record<ForgeTeamRole, number>,
  summary: Summary,
): Promise<void> {
  const { data, error } = await admin.from("user_roles").select("user_id, roles(name)");
  if (error) throw new Error(`could not read user_roles: ${error.message}`);

  const wanted = new Map<string, ForgeTeamRole>();
  for (const row of (data ?? []) as { user_id: string; roles: { name?: string } | { name?: string }[] | null }[]) {
    const role = Array.isArray(row.roles) ? row.roles[0]?.name : row.roles?.name;
    if (isAdmitted(role)) wanted.set(row.user_id, role);
  }

  // Who is seated where. Removal runs on the list; placement runs on the roles afterwards, so a
  // person who moved from one team to the other leaves the first before joining the second.
  const seated = new Map<string, ForgeTeamRole>();
  for (const role of Object.keys(FORGE_TEAMS) as ForgeTeamRole[]) {
    const team = FORGE_TEAMS[role];
    const members = await listAll<{ login: string }>(cfg, `/teams/${teamIds[role]}/members`, `members of '${team}'`);
    for (const { login } of members) {
      if (!DASHBOARD_IDENTITY.test(login)) {
        console.log(`forge-sweep: '${login}' in '${team}' is not a dashboard identity; left alone`);
        continue;
      }
      if (wanted.get(login) === role) {
        seated.set(login, role);
        continue;
      }
      const removed = await forgeApi(cfg, "DELETE", `/teams/${teamIds[role]}/members/${login}`);
      if (!removed.ok && removed.status !== 404) {
        summary.errors.push(`could not remove ${login} from '${team}' (${removed.status})`);
        continue;
      }
      summary.removed.push(`${login} from '${team}'`);
    }
  }

  for (const [login, role] of wanted) {
    if (seated.get(login) === role) continue;
    // A person who has never passed the door has no forge login to place, and the door places
    // them when they do. 404 is that, and is the ordinary answer for most of user_roles.
    const exists = await forgeApi(cfg, "GET", `/users/${login}`);
    if (exists.status === 404) continue;
    if (!exists.ok) {
      summary.errors.push(`could not look up ${login} in the forge (${exists.status})`);
      continue;
    }
    const team = FORGE_TEAMS[role];
    const added = await forgeApi(cfg, "PUT", `/teams/${teamIds[role]}/members/${login}`);
    if (!added.ok) {
      summary.errors.push(`could not place ${login} in '${team}' (${added.status})`);
      continue;
    }
    summary.placed.push(`${login} in '${team}'`);
  }
}

/**
 * The keys on a gateway's repository, against its row. An active gateway holds its key read-write
 * (an enrolment from before the appliance branch registered it read-only, and Gitea has no edit,
 * so it is re-registered from the material the forge lists). An archived gateway, or one whose row
 * is gone, holds none: the appliance is decommissioned and the key it still carries must open
 * nothing.
 */
async function sweepDeployKeys(
  cfg: ForgeConfig,
  name: string,
  sparkplugId: string,
  gateway: { is_archived: boolean } | undefined,
  summary: Summary,
): Promise<void> {
  const keys = await listDeployKeys(cfg, name);
  if (!gateway || gateway.is_archived) {
    for (const key of keys) {
      await deleteDeployKey(cfg, name, key);
      summary.revoked.push(`${name}: '${key.title}'`);
    }
    return;
  }
  for (const key of keys) {
    if (!key.read_only) continue;
    await ensureDeployKey(cfg, name, sparkplugId, key.key, false);
    summary.rekeyed.push(`${name}: '${key.title}'`);
  }
}

/**
 * The repository half. A gateway's repository gets what enrolment gives one; any other repository
 * in the organisation gets `main` protected. A repository that already has everything costs a
 * handful of reads.
 */
async function sweepRepositories(
  cfg: ForgeConfig,
  admin: ReturnType<typeof serviceRoleClient>,
  summary: Summary,
): Promise<void> {
  const { data, error } = await admin.from("gateways").select("sparkplug_id, is_archived");
  if (error) throw new Error(`could not read gateways: ${error.message}`);
  const gateways = new Map((data ?? []).map((g: { sparkplug_id: string; is_archived: boolean }) => [g.sparkplug_id, g]));

  const repositories = await listAll<{ name: string }>(
    cfg,
    `/orgs/${FORGE_ORGANISATION}/repos`,
    `the repositories of '${FORGE_ORGANISATION}'`,
  );
  for (const { name } of repositories) {
    const named = GATEWAY_REPOSITORY.exec(name);
    try {
      if (await ensureBranchProtection(cfg, name, { seedTemplate: !!named })) summary.protected.push(name);
      if (!named) continue;
      if (await ensureApplianceProtection(cfg, name)) summary.protected.push(`${name} (appliance)`);
      if (await ensureWebhook(cfg, name)) summary.hooked.push(name);
      await sweepDeployKeys(cfg, name, named[1], gateways.get(named[1]), summary);
    } catch (err) {
      summary.errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

let saidNoForge = false;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Not configured is 503, not 401: a stack that never set the secret has nothing to check
  // against, and 401 would send whoever is debugging it looking for a wrong value.
  if (!SWEEP_SECRET) {
    console.error("forge-sweep: FORGE_SWEEP_SECRET is not configured; refusing every call");
    return json({ error: "FORGE_SWEEP_SECRET is not configured; the sweep is inert" }, 503);
  }
  if (!secretMatches(req.headers.get("x-sweep-secret") ?? "")) {
    // No detail about why. Distinguishing "no header" from "wrong value" is a hint.
    return json({ error: "unauthorized" }, 401);
  }

  const cfg = forgeConfig();
  if (!cfg) {
    // A deployment without the forge is asked every fifteen minutes and has nothing to sweep.
    if (!saidNoForge) {
      console.log("forge-sweep: this deployment has no forge configured; nothing to sweep");
      saidNoForge = true;
    }
    return json({ error: "This deployment has no forge configured" }, 503);
  }

  const summary: Summary = { placed: [], removed: [], hooked: [], protected: [], rekeyed: [], revoked: [], errors: [] };
  try {
    const teamIds = await ensureOrganisation(cfg);
    const admin = serviceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await sweepMembership(cfg, admin, teamIds, summary);
    await sweepRepositories(cfg, admin, summary);
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    console.error(`forge-sweep: the sweep could not complete: ${details}`);
    return json({ error: "The sweep could not complete", details, ...summary }, 502);
  }

  const changed = summary.placed.length + summary.removed.length + summary.hooked.length + summary.protected.length +
    summary.rekeyed.length + summary.revoked.length;
  if (changed || summary.errors.length) {
    console.log(
      `forge-sweep: placed ${summary.placed.length}, removed ${summary.removed.length}, ` +
        `hooked ${summary.hooked.length}, protected ${summary.protected.length}, ` +
        `rekeyed ${summary.rekeyed.length}, revoked ${summary.revoked.length}, ` +
        `errors ${summary.errors.length}` +
        (summary.errors.length ? `: ${summary.errors.join("; ")}` : ""),
    );
  }
  return json(summary, 200);
}

serve(handler);
