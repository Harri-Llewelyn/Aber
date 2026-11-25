import { serviceRoleClient } from "../_shared/serviceClient.ts";
import { serverError } from "../_shared/failure.ts";

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
 * admits deploy keys alone, the `**` rule that admits none, the rule on the machine account's own
 * branches that admits nobody else, and its deploy keys reconciled with the gateway row (an active
 * Remote gateway's keys are read-write on its own repository; the keys of one that is archived,
 * deleted or no longer Remote are removed, which is the third revocation handle beside
 * `disableClient` and the enrolment token); an archived gateway's repository is put into the forge's
 * archive and a restored one taken back out (#197), which is what stops a retired gateway reading,
 * in the forge's own listing, exactly like one in service; and every other repository in the
 * organisation -- a playbook somebody made by hand -- has `main` protected the same way, without the
 * incident template, because a flow a gateway may later adopt should have been reviewed from the
 * start.
 *
 * Last, each Remote gateway in service whose `main` names an older platform release than this one
 * is proposed the move: one pull request from the machine account, for an Administrator to approve.
 * That pull request and its branch are the one thing a pass makes that enrolment would not, and one
 * a person closed is not made again. Nothing is ever deleted but a key: a repository outlives its
 * gateway row on purpose, because its wiki is where a plant's notes about that gateway live. A
 * member who is not a dashboard identity was put there by hand and is left alone.
 *
 * A gateway's repository is the exception. It is held by the two teams, so anybody who holds it by
 * name is removed first. Its branch rules and tag rules are Aber's and no others, each put right in
 * place before another is removed, so `main` is never without its own. Its default branch is `main`.
 * And a tag named as a branch the appliance reads is deleted, with the release made from it.
 *
 * Authorised by FORGE_SWEEP_SECRET in `x-sweep-secret`, not by the anon key: the edge runtime boots
 * with VERIFY_JWT=false, and the gateway's key check proves only that the caller holds a key that
 * ships in every browser bundle. An unset secret is 503, never a pass. The identities acted on come
 * from `user_roles` and the forge's lists, never from a parameter, so a caller holding the secret
 * can only make the forge more correct, and sooner.
 *
 * One pass at a time (0156): every step reads the forge and then writes, so two passes at once
 * both write. A call that finds another pass holding the lease answers 200 `already_sweeping`.
 */

import {
  CUSTOM_EXAMPLE_REPOSITORY,
  deleteDeployKey,
  DEPLOY_KEY_TITLE,
  deployKeyTitle,
  ensureApplianceProtection,
  ensureBranchProtection,
  ensureBumpProtection,
  ensureDefaultBranch,
  ensureDeployKey,
  ensureHeldByTeams,
  ensureOrganisation,
  ensurePlatformOrganisation,
  ensureProposals,
  ensureTagProtection,
  ensureWebhook,
  findRepository,
  finishBranchRules,
  FORGE_ORGANISATION,
  FORGE_TEAMS,
  type ForgeConfig,
  type ForgeRepository,
  type ForgeTeamRole,
  forgeApi,
  forgeConfig,
  GATEWAY_REPOSITORY,
  listDeployKeys,
  PLATFORM_ORGANISATION,
  PLATFORM_READERS_TEAM,
  PLATFORM_REPOSITORY,
  platformTag,
  platformTagExists,
  platformVersion,
  proposePlatformBump,
  type PublishSpec,
  publishToForge,
  publishTrust,
  refuseMirror,
  repositoryNameFor,
  setRepositoryArchived,
  TRUST_PREFIX,
  type TrustRoot,
} from "../_shared/forge.ts";
import { GATEWAY_CUSTOM_EXAMPLE_DIGEST, GATEWAY_CUSTOM_EXAMPLE_FILES } from "../_shared/gatewayCustomExample.generated.ts";
import { GATEWAY_PLATFORM_DIGEST, GATEWAY_PLATFORM_FILES } from "../_shared/gatewayPlatform.generated.ts";
import { releaseTag } from "../_shared/platformBump.ts";
import { holdsDeployKey, type KeyedGateway } from "./keys.ts";

/** The platform repository, as the key functions address it. */
const PLATFORM_REF = { owner: PLATFORM_ORGANISATION, name: PLATFORM_REPOSITORY };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SWEEP_SECRET = Deno.env.get("FORGE_SWEEP_SECRET") ?? "";
const CREDENTIAL_URL = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
const CREDENTIAL_TOKEN = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";

/**
 * A login forge-membership placed is the user's id, verbatim. Anything else in a team was seated
 * by a person in the forge's own UI and is not this function's to unseat.
 */
const DASHBOARD_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gitea's page size ceiling is configurable and 50 is under every default. */
const PAGE = 50;

/**
 * How long a pass holds the sweep lease. Above the 60 seconds the edge runtime gives a worker
 * (main/index.ts) and pg_net gives the call, so it outlasts a pass only when the pass died
 * holding it. Raise it with either limit.
 */
const LEASE_SECONDS = 300;

/**
 * What one pass spends on proposing platform bumps: this many pull requests, and none begun this
 * far into the worker's 60 seconds. The next pass carries on where it stopped.
 */
const BUMPS_PER_PASS = 10;
const BUMP_BEFORE_MS = 30_000;

/** A holder id as claim_forge_sweep() returns it. */
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Summary {
  placed: string[];
  removed: string[];
  hooked: string[];
  protected: string[];
  /** A tag removed because it was named as a branch the appliance reads, and the commit it named. */
  untagged: string[];
  /** Keys re-registered read-write on an active gateway's repository. */
  rekeyed: string[];
  /** Keys removed from the repository of a gateway that is archived, deleted or no longer Remote. */
  revoked: string[];
  /** A repository put into the forge's archive, because its gateway is archived or its row is gone. */
  archived: string[];
  /** A repository taken out of the archive, because its gateway was restored. */
  restored: string[];
  /** A repository the platform publishes -- the playbook, the custom example -- committed or tagged. */
  published: string[];
  /** A gateway row taught that its repository exists (`forge_repository_at`). */
  recorded: string[];
  /** A platform bump's pull request opened on a gateway's repository, or an older one closed for it. */
  proposed: string[];
  /**
   * Something the sweep declined to do and was right to decline, so no retry clears it and nothing
   * failed: a released tag found at other content than this build ships, or a platform.yml it
   * cannot propose a bump of. Separate from `errors` because an operator watching `errors` is
   * watching for a forge it could not reach or a key it could not re-register, and this is neither.
   */
  warnings: string[];
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
  readersId: number,
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

  // The platform readers team: every admitted role, whichever gateway team it maps to.
  const reading = new Set<string>();
  for (const { login } of await listAll<{ login: string }>(cfg, `/teams/${readersId}/members`, `members of '${PLATFORM_READERS_TEAM}'`)) {
    if (!DASHBOARD_IDENTITY.test(login)) continue;
    if (wanted.has(login)) {
      reading.add(login);
      continue;
    }
    const removed = await forgeApi(cfg, "DELETE", `/teams/${readersId}/members/${login}`);
    if (!removed.ok && removed.status !== 404) {
      summary.errors.push(`could not remove ${login} from '${PLATFORM_READERS_TEAM}' (${removed.status})`);
      continue;
    }
    summary.removed.push(`${login} from '${PLATFORM_READERS_TEAM}'`);
  }

  for (const [login, role] of wanted) {
    if (seated.get(login) === role && reading.has(login)) continue;
    // A person who has never passed the door has no forge login to place, and the door places
    // them when they do. 404 is that, and is the ordinary answer for most of user_roles.
    const exists = await forgeApi(cfg, "GET", `/users/${login}`);
    if (exists.status === 404) continue;
    if (!exists.ok) {
      summary.errors.push(`could not look up ${login} in the forge (${exists.status})`);
      continue;
    }
    const seatsWanted = [
      ...(seated.get(login) === role ? [] : [{ id: teamIds[role], team: FORGE_TEAMS[role] }]),
      ...(reading.has(login) ? [] : [{ id: readersId, team: PLATFORM_READERS_TEAM }]),
    ];
    for (const { id, team } of seatsWanted) {
      const added = await forgeApi(cfg, "PUT", `/teams/${id}/members/${login}`);
      if (!added.ok) {
        summary.errors.push(`could not place ${login} in '${team}' (${added.status})`);
        continue;
      }
      summary.placed.push(`${login} in '${team}'`);
    }
  }
}

/**
 * The keys on a gateway's repository, against its row. An active Remote gateway holds its key
 * read-write (an enrolment from before the appliance branch registered it read-only, and Gitea has
 * no edit, so it is re-registered from the material the forge lists). One that is archived, is no
 * longer Remote, or whose row is gone holds none (holdsDeployKey): the key its old appliance still
 * carries must open nothing. Changed back to Remote, it is given a new key when it enrols.
 */
async function sweepDeployKeys(
  cfg: ForgeConfig,
  name: string,
  sparkplugId: string,
  gateway: KeyedGateway | undefined,
  platform: boolean,
  summary: Summary,
): Promise<void> {
  const keys = await listDeployKeys(cfg, { name });
  if (!holdsDeployKey(gateway)) {
    for (const key of keys) {
      await deleteDeployKey(cfg, { name }, key);
      summary.revoked.push(`${name}: '${key.title}'`);
    }
    return;
  }
  for (const key of keys) {
    // Aber has titled every gateway's key this way. Another was added by a person who held the
    // repository, and would be registered for writing below.
    if (key.title !== deployKeyTitle(sparkplugId)) {
      await deleteDeployKey(cfg, { name }, key);
      summary.revoked.push(`${name}: '${key.title}'`);
      continue;
    }
    if (key.read_only) {
      await ensureDeployKey(cfg, { name }, sparkplugId, key.key, false);
      summary.rekeyed.push(`${name}: '${key.title}'`);
    }
    // The second link an active gateway holds: the same key, read-only, on the platform repository.
    if (platform && await ensureDeployKey(cfg, PLATFORM_REF, sparkplugId, key.key, true) !== "kept") {
      summary.rekeyed.push(`${PLATFORM_ORGANISATION}/${PLATFORM_REPOSITORY}: '${key.title}' (read-only)`);
    }
  }
}

/**
 * A gateway's key on a repository that is no gateway's: the repository was the gateway's under another
 * name, which nothing here holds as one. Removed, so that no appliance deploys from it.
 */
async function sweepStrayKeys(cfg: ForgeConfig, name: string, summary: Summary): Promise<void> {
  for (const key of await listDeployKeys(cfg, { name })) {
    if (!DEPLOY_KEY_TITLE.test(key.title)) continue;
    await deleteDeployKey(cfg, { name }, key);
    summary.revoked.push(`${name}: '${key.title}'`);
  }
}

/**
 * The platform repository's keys against the gateway rows: a key titled for a gateway that is
 * archived, gone or no longer Remote is removed. A key somebody titled by hand is left alone.
 */
async function sweepPlatformKeys(
  cfg: ForgeConfig,
  gateways: Map<string, KeyedGateway>,
  summary: Summary,
): Promise<void> {
  for (const key of await listDeployKeys(cfg, PLATFORM_REF)) {
    const named = DEPLOY_KEY_TITLE.exec(key.title);
    if (!named) continue;
    if (holdsDeployKey(gateways.get(named[1]))) continue;
    await deleteDeployKey(cfg, PLATFORM_REF, key);
    summary.revoked.push(`${PLATFORM_ORGANISATION}/${PLATFORM_REPOSITORY}: '${key.title}'`);
  }
}

/**
 * `forge_repository_at` for a gateway whose row does not carry it. enroll-gateway sets it in step 4,
 * so this is for the two cases that function cannot cover: a fleet enrolled before the column
 * existed, and an enrolment whose own write failed after the repository was created. Seeing the
 * repository in the organisation is the proof -- nothing else on the row distinguishes a gateway
 * with no repository from one on a deployment with no forge, which is why the dashboard needs the
 * column at all (#237).
 *
 * NEVER CLEARED HERE. A sweep that could not reach the forge, or one racing a repository's creation,
 * would otherwise read as "the repository is gone" and withhold links that work.
 */
async function recordRepository(
  admin: ReturnType<typeof serviceRoleClient>,
  repository: string,
  sparkplugId: string,
  gateway: { forge_repository_at: string | null } | undefined,
  summary: Summary,
): Promise<void> {
  if (!gateway || gateway.forge_repository_at) return;
  const { error } = await admin
    .from("gateways")
    .update({ forge_repository_at: new Date().toISOString() })
    .eq("sparkplug_id", sparkplugId)
    // Guards an enrolment landing between the read above and this write: the row keeps the
    // enrolment's own timestamp, which is the accurate one.
    .is("forge_repository_at", null);
  if (error) throw new Error(`could not record its repository: ${error.message}`);
  summary.recorded.push(repository);
}

/**
 * `forge_archived_at`: whether this gateway's repository is in the forge's archive, as the sweep
 * last saw it. Written here rather than stamped by the trigger that asks for the sweep, because
 * this is the only code that has spoken to the forge -- an optimistic stamp would say the
 * repository was archived on a deployment that has no forge at all.
 *
 * CLEARED on the way back, which `forge_repository_at` deliberately never is: that column answers
 * "does a repository exist", where a failed pass must not read as "it is gone", and this one
 * answers "is it read-only right now", where the sweep has just made it so either way.
 */
async function recordArchived(
  admin: ReturnType<typeof serviceRoleClient>,
  sparkplugId: string,
  gateway: { forge_archived_at: string | null } | undefined,
  archived: boolean,
): Promise<void> {
  // A repository whose row is gone has nowhere to record it. That is the delete case, and the
  // repository outliving the row is the point of it.
  if (!gateway) return;
  if (archived === Boolean(gateway.forge_archived_at)) return;
  const { error } = await admin
    .from("gateways")
    .update({ forge_archived_at: archived ? new Date().toISOString() : null })
    .eq("sparkplug_id", sparkplugId);
  if (error) throw new Error(`could not record the archive state of its repository: ${error.message}`);
}

/**
 * Who holds a gateway's repository beside its teams (ensureHeldByTeams): nobody. One the forge will
 * not remove is an error on every pass.
 */
async function sweepHolders(cfg: ForgeConfig, name: string, summary: Summary): Promise<void> {
  const { removed, kept } = await ensureHeldByTeams(cfg, name);
  for (const login of removed) summary.removed.push(`${login} from '${name}'`);
  for (const login of kept) summary.errors.push(`${name}: the forge would not take it from '${login}'`);
}

/**
 * The tags of a gateway's repository (ensureTagProtection). A tag that was there under a name the
 * appliance reads is reported with its commit, since an appliance may have followed it; one the
 * forge will not remove is an error on every pass until it is gone.
 */
async function sweepTags(cfg: ForgeConfig, name: string, summary: Summary): Promise<boolean> {
  const { changed, found } = await ensureTagProtection(cfg, name);
  for (const { tag, commit, removed } of found) {
    if (removed) summary.untagged.push(`${name}: '${tag}' at ${commit}`);
    else summary.errors.push(`${name}: the forge would not remove the tag '${tag}' at ${commit}`);
  }
  return changed;
}

/**
 * The repository half. A gateway's repository gets what enrolment gives one, or the forge's
 * archive if its gateway has been archived; any other repository in the organisation gets `main`
 * protected. A repository that already has everything costs a handful of reads. Returns the
 * repositories of the Remote gateways in service, less any that failed.
 *
 * THE ARCHIVE IS WHAT MAKES A RETIRED GATEWAY LOOK RETIRED (#197). Archiving already revoked the
 * thing that matters -- the broker account -- and the sweep already removes the deploy key, so
 * what was left was a repository that read, in the forge's own listing, exactly like one in
 * service. Gitea's archive mark makes it read-only and badges it, keeping every branch: the
 * `appliance` branch, the last thing the gateway reported, is a better record than the heartbeat
 * table, which stops. Nothing here deletes a repository, ever -- a plant's notes about a gateway
 * live in its wiki, and a delete is a decision a person takes in the forge.
 */
async function sweepRepositories(
  cfg: ForgeConfig,
  admin: ReturnType<typeof serviceRoleClient>,
  platform: boolean,
  summary: Summary,
): Promise<string[]> {
  const { data, error } = await admin
    .from("gateways")
    .select("sparkplug_id, is_archived, deployment, forge_repository_at, forge_archived_at");
  if (error) throw new Error(`could not read gateways: ${error.message}`);
  const gateways = new Map(
    (data ?? []).map((
      g: {
        sparkplug_id: string;
        is_archived: boolean;
        deployment: string;
        forge_repository_at: string | null;
        forge_archived_at: string | null;
      },
    ) => [g.sparkplug_id, g]),
  );

  // `archived` comes from the listing, so the reconciliation below costs a PATCH only where the
  // forge and the row disagree. Gitea puts it on every repository it lists.
  const listed = await listAll<ForgeRepository>(
    cfg,
    `/orgs/${FORGE_ORGANISATION}/repos`,
    `the repositories of '${FORGE_ORGANISATION}'`,
  );
  const inService: string[] = [];
  const repositories = new Map(listed.map((r) => [r.id, r]));
  const names = new Set(listed.map(({ name }) => name));
  // A gateway's repository that is not listed under its name may be there under another.
  for (const [sparkplugId, { forge_repository_at }] of gateways) {
    const name = repositoryNameFor(sparkplugId);
    if (!forge_repository_at || names.has(name)) continue;
    try {
      const found = await findRepository(cfg, name);
      if (!found) continue;
      if (repositories.has(found.id)) summary.protected.push(`${name} (name)`);
      repositories.set(found.id, found);
    } catch (err) {
      summary.errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const { name, archived, default_branch, mirror, has_pull_requests } of repositories.values()) {
    // A name is the same to Gitea in any case. One whose gateway is gone has no row to be renamed by.
    const named = GATEWAY_REPOSITORY.exec(name.toLowerCase());
    const gateway = named ? gateways.get(named[1]) : undefined;
    try {
      // A repository somebody made by hand: `main` protected and nothing else. One they also
      // archived is left entirely alone -- protecting a branch is a write, and Gitea refuses
      // writes to an archived repository, so the attempt would be an error on every pass.
      // `gateway: false` is not a default: a playbook is not a gateway, so its rule is made closed,
      // nothing is seeded into it and a rule somebody tuned stays.
      if (!named) {
        if (archived) continue;
        if (await ensureBranchProtection(cfg, name, { gateway: false })) summary.protected.push(name);
        await sweepStrayKeys(cfg, name, summary);
        continue;
      }

      // Archived, or a repository whose row is gone. THE KEYS COME OFF BEFORE THE ARCHIVE GOES
      // ON: a key left on it is a key the appliance can still clone with, and it must not be the
      // thing the archive prevents this pass from removing. A pass that dies between the two
      // leaves the keys gone and the archive to the next one.
      if (!gateway || gateway.is_archived) {
        // Somebody who holds it could take it out of the archive. Gitea removes one from an archived
        // repository too (measured).
        await sweepHolders(cfg, name, summary);
        await sweepDeployKeys(cfg, name, named[1], gateway, platform, summary);
        await recordRepository(admin, name, named[1], gateway, summary);
        if (await setRepositoryArchived(cfg, name, true, archived)) summary.archived.push(name);
        await recordArchived(admin, named[1], gateway, true);
        // No furnishing. Every call below is a write, and this repository is now read-only.
        continue;
      }

      // Out of the archive FIRST, for the same reason in reverse: a restored gateway's repository
      // is still read-only until this call, and everything after it is a write.
      if (await setRepositoryArchived(cfg, name, false, archived)) summary.restored.push(name);
      await recordArchived(admin, named[1], gateway, false);
      await sweepHolders(cfg, name, summary);
      await refuseMirror(cfg, name, mirror);
      // Each by itself: one that fails leaves the others done. Nothing is registered unless all are.
      let held = true;
      const hold = async (what: string, step: () => Promise<boolean>) => {
        try {
          if (await step()) summary.protected.push(what);
        } catch (err) {
          held = false;
          summary.errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
        }
      };
      await hold(`${name} (proposals)`, () => ensureProposals(cfg, name, has_pull_requests));
      await hold(`${name} (tags)`, () => sweepTags(cfg, name, summary));
      await hold(name, () => ensureBranchProtection(cfg, name, { gateway: true }));
      await hold(`${name} (appliance)`, () => ensureApplianceProtection(cfg, name));
      await hold(`${name} (platform bumps)`, () => ensureBumpProtection(cfg, name));
      await hold(`${name} (rules)`, () => finishBranchRules(cfg, name));
      await hold(`${name} (default branch)`, () => ensureDefaultBranch(cfg, name, default_branch));
      if (!held) continue;
      if (await ensureWebhook(cfg, name)) summary.hooked.push(name);
      await sweepDeployKeys(cfg, name, named[1], gateway, platform, summary);
      await recordRepository(admin, name, named[1], gateway, summary);
      if (gateway.deployment === "remote") inService.push(name);
    } catch (err) {
      summary.errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (platform) {
    try {
      await sweepPlatformKeys(cfg, gateways, summary);
    } catch (err) {
      summary.errors.push(`${PLATFORM_ORGANISATION}/${PLATFORM_REPOSITORY}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return inService;
}

/** The repositories whose platform.yml this worker has already logged as one it cannot propose for. */
const saidDeclined = new Set<string>();

/**
 * The platform bump, for each gateway repository in service: after everything a pass must do, so a
 * fleet to be proposed for never holds up a key to be revoked. Only a release tag that is published
 * is proposed, so a development build and a forge the playbook has not reached propose nothing.
 */
async function sweepBumps(cfg: ForgeConfig, inService: string[], started: number, summary: Summary): Promise<void> {
  const version = platformVersion();
  const tag = version && platformTag(version);
  if (!tag || !releaseTag(tag)) return;
  try {
    if (!(await platformTagExists(cfg, tag))) return;
  } catch (err) {
    summary.errors.push(`no platform bump was proposed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  let opened = 0;
  for (const name of inService) {
    if (opened >= BUMPS_PER_PASS || Date.now() - started > BUMP_BEFORE_MS) {
      console.log("forge-sweep: stopped proposing platform bumps for this pass; the next one carries on");
      return;
    }
    try {
      const bump = await proposePlatformBump(cfg, name, tag);
      if (bump.opened !== null) {
        opened += 1;
        summary.proposed.push(`${name}: opened #${bump.opened} for ${tag}`);
      }
      for (const number of bump.closed) summary.proposed.push(`${name}: closed #${number}, which was for an older tag`);
      if (bump.declined) {
        summary.warnings.push(`${name}: ${bump.declined}`);
        if (!saidDeclined.has(name)) console.warn(`forge-sweep: ${name}: ${bump.declined}`);
        saidDeclined.add(name);
      }
    } catch (err) {
      summary.errors.push(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

let saidNoRoot = false;

/**
 * The root the broker presents, from the credential service, which is the one component that reads
 * the file the broker actually loads. Null rather than an error on every failure: a stack with no
 * root, or a credential service that is down for a pass, must not stop the sweep placing people or
 * protecting branches, and the bundle already on `main` is still valid while this is unknown.
 */
async function brokerRoot(summary: Summary): Promise<TrustRoot | null> {
  if (!CREDENTIAL_URL || !CREDENTIAL_TOKEN) {
    if (!saidNoRoot) {
      console.log("forge-sweep: no credential service configured, so no trust bundle is published");
      saidNoRoot = true;
    }
    return null;
  }
  try {
    const response = await fetch(`${CREDENTIAL_URL.replace(/\/+$/, "")}/ca`, {
      headers: { Authorization: `Bearer ${CREDENTIAL_TOKEN}` },
    });
    // 404 is a deployment with no root at all -- a plaintext-only stack -- and is not an error.
    if (response.status === 404) {
      if (!saidNoRoot) {
        console.log("forge-sweep: this deployment presents no root, so no trust bundle is published");
        saidNoRoot = true;
      }
      return null;
    }
    if (!response.ok) {
      summary.errors.push(`could not read the broker's root (${response.status})`);
      return null;
    }
    const root = await response.json() as TrustRoot;
    if (!root.ca_cert || !root.spki_sha256) {
      summary.errors.push("the credential service returned a root with no certificate or no pin");
      return null;
    }
    return root;
  } catch (err) {
    summary.errors.push(`the credential service is unreachable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

let saidNoVersion = false;

/**
 * What the platform publishes into its own organisation: the playbook every appliance converges
 * to, tagged per platform version, and the example custom repository a person copies when a
 * gateway needs code of its own. The example is untagged and marked as a template, because it is
 * copied once rather than converged to, and it is never handed to an appliance.
 *
 * Then the trust bundle onto `main` of the playbook repository. It is published here rather than
 * shipped in the playbook's tree because it is not this repository's to state: the root is what
 * the broker presents today, and it changes without a release. An appliance fetches `trust/` from
 * `main` whatever tag it is converged to, which is why the tree that carries the tags must neither
 * manage nor delete it.
 */
async function sweepPlatform(cfg: ForgeConfig, summary: Summary): Promise<boolean> {
  const version = platformVersion();
  if (!version) {
    if (!saidNoVersion) {
      console.warn("forge-sweep: ABER_PLATFORM_VERSION is unset, so the platform playbook is not published");
      saidNoVersion = true;
    }
    return false;
  }

  const specs: PublishSpec[] = [
    {
      name: PLATFORM_REPOSITORY,
      description: "The playbook every gateway appliance converges to, at the tag its own platform.yml names. Published by Aber.",
      files: GATEWAY_PLATFORM_FILES,
      digest: GATEWAY_PLATFORM_DIGEST,
      version,
      unmanaged: [TRUST_PREFIX],
    },
    {
      name: CUSTOM_EXAMPLE_REPOSITORY,
      description: "An example custom gateway repository: what a gateway that needs code of its own looks like. Copy it with 'Use this template'. Published by Aber.",
      files: GATEWAY_CUSTOM_EXAMPLE_FILES,
      digest: GATEWAY_CUSTOM_EXAMPLE_DIGEST,
      version: null,
      template: true,
    },
  ];

  for (const spec of specs) {
    const publication = await publishToForge(cfg, spec);
    if (publication.published) {
      summary.published.push(
        `${PLATFORM_ORGANISATION}/${spec.name} at ${spec.digest.slice(0, 12)}`
          + (publication.tag ? ` (${publication.tag})` : ""),
      );
    }
    if (publication.warning) summary.warnings.push(publication.warning);
  }

  // AFTER the playbook, so the first pass on a new forge creates the repository before the bundle
  // is written into it. A failure here leaves the fleet on the bundle it already has.
  const root = await brokerRoot(summary);
  if (root) {
    try {
      const trust = await publishTrust(cfg, PLATFORM_REPOSITORY, root);
      if (trust.published) {
        summary.published.push(
          `${PLATFORM_ORGANISATION}/${PLATFORM_REPOSITORY} ${TRUST_PREFIX} `
            + `(${trust.roots.length} root(s), current ${root.spki_sha256.slice(0, 12)})`,
        );
      }
    } catch (err) {
      summary.errors.push(`could not publish ${TRUST_PREFIX}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return true;
}

/** The lease RPC failed, so whether another pass is running is unknown and none is started. */
function leaseUnreadable(req: Request, error: unknown): Response {
  return serverError(req, "forge-sweep", error, { status: 502, error: "Could not read the sweep lease" });
}

/** A pass's counts, and its errors in full, for the log. */
function tally(summary: Summary): string {
  return `placed ${summary.placed.length}, removed ${summary.removed.length}, ` +
    `hooked ${summary.hooked.length}, protected ${summary.protected.length}, untagged ${summary.untagged.length}, ` +
    `rekeyed ${summary.rekeyed.length}, revoked ${summary.revoked.length}, ` +
    `archived ${summary.archived.length}, restored ${summary.restored.length}, ` +
    `published ${summary.published.length}, recorded ${summary.recorded.length}, ` +
    `proposed ${summary.proposed.length}, ` +
    `warnings ${summary.warnings.length}, errors ${summary.errors.length}` +
    (summary.errors.length ? `: ${summary.errors.join("; ")}` : "");
}

/** Never throws: the pass has already answered for itself, and a lease left held lapses. */
async function releaseLease(admin: ReturnType<typeof serviceRoleClient>, holder: string): Promise<void> {
  try {
    const { data, error } = await admin.rpc("release_forge_sweep", { p_holder: holder });
    if (error) throw new Error(error.message);
    if (!data) console.warn("forge-sweep: this pass outlived its lease, which another pass then took");
  } catch (err) {
    console.error(
      `forge-sweep: could not release the sweep lease (${err instanceof Error ? err.message : err}); ` +
        `it lapses within ${LEASE_SECONDS}s`,
    );
  }
}

let saidNoForge = false;

export default async function handler(req: Request): Promise<Response> {
  const started = Date.now();
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
    // A deployment without the forge is asked every fifteen minutes and has nothing to sweep. A
    // forge whose token has not arrived is said so by forgeConfig() on every call.
    if (!saidNoForge) {
      console.log("forge-sweep: this deployment has no forge configured, or not yet its token; nothing to sweep");
      saidNoForge = true;
    }
    return json({ error: "This deployment has no forge configured, or its token has not arrived yet" }, 503);
  }

  const admin = serviceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // A caller that holds the lease itself names it in x-sweep-lease: the pass runs under it and
  // leaves it held, so nothing else sweeps between that caller's changes and its own pass.
  const named = req.headers.get("x-sweep-lease");
  let holder: string | null = null;
  if (named !== null) {
    const renewed = LEASE_ID.test(named)
      ? await admin.rpc("renew_forge_sweep", { p_holder: named, p_seconds: LEASE_SECONDS })
      : { data: false, error: null };
    if (renewed.error) return leaseUnreadable(req, renewed.error);
    if (!renewed.data) return json({ error: "The lease named in x-sweep-lease is not held" }, 409);
  } else {
    const claimed = await admin.rpc("claim_forge_sweep", { p_seconds: LEASE_SECONDS });
    if (claimed.error) return leaseUnreadable(req, claimed.error);
    // 200, not an error status: pg_net records the status, and nothing failed. The pass holding
    // the lease, or the one its release queues, sees whatever this call was asked about.
    if (!claimed.data) {
      console.log("forge-sweep: another pass holds the lease; this call did nothing");
      return json({ already_sweeping: true }, 200);
    }
    holder = claimed.data as string;
  }

  const summary: Summary = { placed: [], removed: [], hooked: [], protected: [], untagged: [], rekeyed: [], revoked: [], archived: [], restored: [], published: [], recorded: [], proposed: [], warnings: [], errors: [] };
  try {
    const teamIds = await ensureOrganisation(cfg);
    const readersId = await ensurePlatformOrganisation(cfg);
    await sweepMembership(cfg, admin, teamIds, readersId, summary);
    // The platform repository before the gateway repositories, so the keys have somewhere to go.
    const platform = await sweepPlatform(cfg, summary);
    const inService = await sweepRepositories(cfg, admin, platform, summary);
    if (platform) await sweepBumps(cfg, inService, started, summary);
  } catch (err) {
    return serverError(req, "forge-sweep", err, {
      status: 502,
      error: "The sweep could not complete",
      context: `the pass stopped after: ${tally(summary)}`,
    });
  } finally {
    // Before the answer, so a caller that has it can claim at once.
    if (holder) await releaseLease(admin, holder);
  }

  // A warning is not a change, so it does not make a quiet sweep speak: nothing was done, and the
  // one thing declined already said so through console.warn where it was decided. It is counted
  // rather than repeated here for the same reason -- unlike an `errors` entry, which is raised in a
  // catch block that logs nothing of its own and would otherwise reach only the response body.
  const changed = summary.placed.length + summary.removed.length + summary.hooked.length + summary.protected.length + summary.untagged.length +
    summary.rekeyed.length + summary.revoked.length + summary.archived.length + summary.restored.length +
    summary.published.length + summary.recorded.length + summary.proposed.length;
  if (changed || summary.errors.length) console.log(`forge-sweep: ${tally(summary)}`);
  return json(summary, 200);
}

Deno.serve(handler);
