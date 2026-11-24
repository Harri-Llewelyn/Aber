/**
 * The forge: the organisation that holds every gateway's repository, the two teams a person may
 * belong to in it, a gateway's own repository, and the key it reads that repository with. Shared
 * because the names must agree between `enroll-gateway`, `forge-membership` and the dashboard's
 * link.
 *
 * The machine account owns an organisation, creates each gateway's repository in it, and
 * `forge-membership` places each login in the team its Postgres role maps to, with `forge-sweep`
 * re-doing both over the forge's own lists every fifteen minutes; it is not a site administrator.
 * Both teams have write; `main` is protected on every gateway repository with pushes disabled and
 * one approval required from `administrators`, which is what governs deploying a flow to an
 * appliance.
 *
 * The private key is never seen here: the appliance generates its keypair in bootstrap.mjs and
 * sends the public half, registered read-write on the gateway's own repository and nowhere else.
 * A writable key on a repository whose `main` admits no deploy key lets an appliance REPORT and
 * never DEPLOY: `main` is protected with pushes disabled and deploy keys not whitelisted, the
 * `appliance` branch admits deploy keys alone and blocks force-push, and a `**` rule closes every
 * other branch to them. Measured against gitea/gitea:1.27.3: the key can also push to the wiki,
 * which no rule covers; docs/security-model.md records that under accepted risks.
 *
 * Branch rules do not cover tags, and Git takes a short name for a tag before a branch. So tag rules
 * let a deploy key make no tag at all, and nobody but the machine account make one named as a branch
 * that is read here or on the appliance (ensureTagProtection).
 *
 * Failure here is non-fatal: by the time this runs the token is spent and the broker credential
 * exists, and telemetry needs nothing from the forge. A failure is logged loudly, `repository`
 * comes back null, and the response says so.
 */

// The trust bundle below is keyed by the same pin the appliance and the one-liner compute, so it
// is computed by the same code rather than by a second reading of the same RFC.
import { spkiPin } from "./caPin.ts";

export interface ForgeConfig {
  /**
   * The gateway's forge-api listener, which serves Gitea's API and host key with the identity
   * headers removed. Never gitea:3000, whose web routes sign in whoever one header names.
   */
  baseUrl: string;
  user: string;
  /** The machine account's API token. The account is a bot, so it has no password to send. */
  token: string;
  /** Where Gitea delivers a push (forge-events), and the secret it signs with. Empty: no hook. */
  webhookUrl: string;
  webhookSecret: string;
}

export interface ForgeRepository {
  full_name: string;
  ssh_url: string;
  default_branch: string;
}

/**
 * The organisation every gateway repository lives in, and the two teams in it. Named here and in
 * frontend/src/constants.js, and the two must agree. Lower-case because it is a URL segment.
 */
export const FORGE_ORGANISATION = "gateways";
export const FORGE_TEAMS = {
  Administrator: "administrators",
  Shopfloor_Manager: "managers",
} as const;
export type ForgeTeamRole = keyof typeof FORGE_TEAMS;

/**
 * The forge's configuration, or null when this deployment has none or its token has not arrived.
 * All three or nothing: a half-configured forge would answer 401 on every enrolment, so it is
 * reported here. The forge mints the token when it starts, and main/index.ts reads it from its
 * mount at each spawn; an empty one is a token not yet delivered, which on an install or an upgrade
 * lasts a minute or two and ends without a restart.
 */
export function forgeConfig(): ForgeConfig | null {
  const baseUrl = (Deno.env.get("GITEA_INTERNAL_URL") ?? "").replace(/\/+$/, "");
  const user = Deno.env.get("GITEA_MACHINE_USER") ?? "";
  const token = Deno.env.get("GITEA_MACHINE_TOKEN");

  if (!baseUrl && !user && token === undefined) return null;

  if (baseUrl && user && token === "") {
    console.error(
      "the forge's token has not been delivered yet, so this call skips the forge. The forge mints it " +
        "when it starts and this pod reads it about a minute later; if it persists, read the log of the " +
        "gitea pod's gitea-token container.",
    );
    return null;
  }

  if (!baseUrl || !user || !token) {
    const missing = [
      !baseUrl && "GITEA_INTERNAL_URL",
      !user && "GITEA_MACHINE_USER",
      !token && "GITEA_MACHINE_TOKEN",
    ].filter(Boolean).join(", ");
    console.error(
      `the forge is half-configured (${missing} unset), so gateway repositories are DISABLED. ` +
        "Set all three or none -- a partially configured forge answers 401 on every enrolment.",
    );
    return null;
  }

  // Optional, unlike the three above: a forge without a webhook is one the dashboard learns about
  // one tick late. Both or neither, and enrolment logs which.
  const webhookUrl = (Deno.env.get("GITEA_WEBHOOK_URL") ?? "").trim();
  const webhookSecret = Deno.env.get("GITEA_WEBHOOK_SECRET") ?? "";
  if (!!webhookUrl !== !!webhookSecret) {
    console.warn(
      `the forge's webhook is half-configured (${webhookUrl ? "GITEA_WEBHOOK_SECRET" : "GITEA_WEBHOOK_URL"} unset); ` +
        "no hook will be registered on gateway repositories until both are set",
    );
  }
  const webhook = webhookUrl && webhookSecret ? { webhookUrl, webhookSecret } : { webhookUrl: "", webhookSecret: "" };

  return { baseUrl, user, token, ...webhook };
}

/**
 * The repository name for a gateway, derived from the `sparkplug_id` rather than stored: the id is
 * generated by the database and cannot disagree with the gateway.
 */
export function repositoryNameFor(sparkplugId: string): string {
  return `gateway-${sparkplugId}`;
}

/** The inverse: a gateway's repository, and the sparkplug_id in its name. Must agree with the above. */
export const GATEWAY_REPOSITORY = /^gateway-(gwy[0-9a-f]{21})$/;

/**
 * The branch an Administrator approves and an appliance deploys, on every gateway's repository. No
 * other is ever followed: the approval is a rule on this name.
 */
export const MAIN_BRANCH = "main";

/**
 * The branch the appliance writes and nobody else does: what is running, beside `main`, which is
 * what was approved. Must agree with REPORT_BRANCH in forge/gateway-platform/appliance/flow-sync.mjs and
 * with the compare link in frontend/src/components/common/GatewayRepositoryPanel.jsx.
 */
export const APPLIANCE_BRANCH = "appliance";

/**
 * The rule that closes every branch but the two named ones to deploy keys. `**` and not `*`:
 * Gitea matches rules with a glob whose `*` stops at a slash, so `*` left `feature/x` open
 * (measured).
 */
const CATCH_ALL_RULE = "**";

/**
 * The pushes the hook delivers: every branch. `main` and `appliance` are recorded on the gateway
 * row; every other branch is a proposal, and forge-events checks the shape of its `flows.json` and
 * posts the status `main` requires. Gitea ignores what it is not asked about, so the cost of the
 * wider filter is one call per proposal push.
 *
 * `*`, NOT `**`, and this glob is not the branch rules'. A webhook filter's `*` matches across a
 * slash, so `feature/x` is delivered; a branch rule's does not, which is why CATCH_ALL_RULE above
 * has to be `**`. Both measured against gitea/gitea:1.27.3.
 */
const WEBHOOK_BRANCH_FILTER = "*";

/**
 * The commit status `main` requires before a merge. Posted by forge-events, which reads the
 * pushed `flows.json` and applies the shape checks the appliance's puller applies -- so a file
 * uploaded through the forge's own UI meets a check before it is merged rather than being refused
 * on the appliance afterwards, which is late.
 */
export const FLOW_SHAPE_CONTEXT = "aber/flow-shape";

/**
 * The platform playbook's own organisation and repository: one repository the whole fleet reads,
 * outside `gateways` so that organisation's rules (both teams may create repositories; the sweep
 * protects whatever it finds) do not apply. Its `main` admits pushes from the machine account
 * alone, because its content is this repository's forge/gateway-platform/, published by forge-sweep.
 * Named here and in forge/gateway-platform/README.md.
 */
export const PLATFORM_ORGANISATION = "platform";
export const PLATFORM_REPOSITORY = "gateway-platform";
/**
 * The example custom gateway repository, in the same organisation and published the same way. A
 * template rather than a tagged release: it is copied once, when somebody makes a gateway that
 * needs code of its own, and nothing converges to it.
 */
export const CUSTOM_EXAMPLE_REPOSITORY = "gateway-custom-example";
/** Both dashboard teams read the platform repository through this team; nobody writes it. */
export const PLATFORM_READERS_TEAM = "readers";
/** The file in a gateway's repository naming the tag its appliance converges to. */
export const PLATFORM_POINTER_PATH = "platform.yml";
/** The digest of what the published repository holds, so a sweep compares in one read. */
const PLATFORM_MANIFEST_PATH = ".aber/manifest.json";
/**
 * The roots an appliance should trust, on `main` of the platform repository and nowhere else.
 *
 * EVERYTHING ELSE IN THAT REPOSITORY IS A TAG. An appliance converges to the tag its own
 * platform.yml names, so a fleet spread across three platform versions reads three different
 * trees -- and a re-issued root has to reach all of them, including the ones nobody is upgrading.
 * A directory on `main`, fetched separately from the tagged checkout, is the one thing every
 * appliance can read whatever it is pinned to. It is written by the sweep and excluded from what
 * the published tree manages, so publishing a new playbook neither deletes it nor tags it.
 */
export const TRUST_PREFIX = "trust/";
export const TRUST_BUNDLE_PATH = `${TRUST_PREFIX}ca-bundle.pem`;
export const TRUST_MANIFEST_PATH = `${TRUST_PREFIX}manifest.json`;

/**
 * The platform's version, from ABER_PLATFORM_VERSION (the chart's appVersion), or null when unset
 * or not a version. The tag is `v<version>`, the same form the release workflow tags this
 * repository with.
 */
export function platformVersion(): string | null {
  const raw = (Deno.env.get("ABER_PLATFORM_VERSION") ?? "").trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw) ? raw : null;
}

export function platformTag(version: string): string {
  return `v${version}`;
}

/**
 * The public half of an OpenSSH key, or null. Shape-checked and confined to the two algorithms
 * bootstrap.mjs can generate, so this endpoint cannot write arbitrary strings into another system's
 * authorised-keys list.
 */
export function validPublicKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length > 4096) return null;
  return /^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [^\n\r]*)?$/.test(key) ? key : null;
}

/** The machine account's token. Gitea checks the token's scopes on every call. */
function authHeader(cfg: ForgeConfig): string {
  return `token ${cfg.token}`;
}

/** One call to the forge's API as the machine account. Shared with forge-membership. */
export async function forgeApi(
  cfg: ForgeConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: authHeader(cfg),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function refused(what: string, response: Response): Promise<Error> {
  return new Error(`${what} (${response.status}: ${(await response.text()).slice(0, 200)})`);
}

/**
 * The organisation, created if absent, and its two teams likewise. Returns the team ids by role.
 * Idempotent by inspection: a GET first, a POST only for what is missing. Private, like every
 * repository in it; `includes_all_repositories` makes a team cover every repository created later.
 * Both teams may create repositories, since a playbook repository exists before any gateway does; a
 * hand-made repository carrying a gateway's name is adopted and protected at enrolment. A found
 * team whose `can_create_org_repo` is off is patched back on.
 */
export async function ensureOrganisation(
  cfg: ForgeConfig,
): Promise<Record<ForgeTeamRole, number>> {
  const org = await forgeApi(cfg, "GET", `/orgs/${FORGE_ORGANISATION}`);
  if (org.status === 404) {
    const created = await forgeApi(cfg, "POST", "/orgs", {
      username: FORGE_ORGANISATION,
      full_name: "Gateways",
      description: "One repository per gateway. Managed by Aber.",
      visibility: "private",
      repo_admin_change_team_access: false,
    });
    if (!created.ok) throw await refused(`could not create organisation '${FORGE_ORGANISATION}'`, created);
    console.log(`forge: created organisation '${FORGE_ORGANISATION}'`);
  } else if (!org.ok) {
    throw await refused(`could not read organisation '${FORGE_ORGANISATION}'`, org);
  }

  const listed = await forgeApi(cfg, "GET", `/orgs/${FORGE_ORGANISATION}/teams?limit=50`);
  if (!listed.ok) throw await refused("could not list the organisation's teams", listed);
  const teams = await listed.json() as { id: number; name: string; can_create_org_repo: boolean }[];

  const ids = {} as Record<ForgeTeamRole, number>;
  for (const role of Object.keys(FORGE_TEAMS) as ForgeTeamRole[]) {
    const name = FORGE_TEAMS[role];
    const existing = teams.find((t) => t.name === name);
    if (existing) {
      ids[role] = existing.id;
      if (!existing.can_create_org_repo) {
        const patched = await forgeApi(cfg, "PATCH", `/teams/${existing.id}`, { can_create_org_repo: true });
        if (!patched.ok) throw await refused(`could not let team '${name}' create repositories`, patched);
        console.log(`forge: team '${name}' may now create repositories in '${FORGE_ORGANISATION}'`);
      }
      continue;
    }
    const created = await forgeApi(cfg, "POST", `/orgs/${FORGE_ORGANISATION}/teams`, {
      name,
      description: `${role.replace("_", " ")}s of the Aber dashboard, placed here by forge-membership.`,
      permission: "write",
      includes_all_repositories: true,
      can_create_org_repo: true,
      // No repo.projects: the unit is disabled forge-wide (DISABLED_REPO_UNITS in the Gitea env).
      units: ["repo.code", "repo.issues", "repo.pulls", "repo.releases", "repo.wiki"],
    });
    if (!created.ok) throw await refused(`could not create team '${name}'`, created);
    ids[role] = ((await created.json()) as { id: number }).id;
    console.log(`forge: created team '${name}' in '${FORGE_ORGANISATION}'`);
  }
  return ids;
}

/**
 * Create the gateway's repository in the organisation, or return the one already there.
 * `auto_init` matters: a repository with no default branch gives the appliance nothing to clone,
 * and git reports "remote HEAD refers to a nonexistent ref".
 */
async function ensureRepository(
  cfg: ForgeConfig,
  name: string,
  gatewayName: string,
): Promise<ForgeRepository> {
  const existing = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}`);
  if (existing.ok) return await existing.json() as ForgeRepository;
  if (existing.status !== 404) {
    throw await refused(`could not read repository '${name}'`, existing);
  }

  const created = await forgeApi(cfg, "POST", `/orgs/${FORGE_ORGANISATION}/repos`, {
    name,
    description: `Node-RED flow for gateway '${gatewayName}'. Managed by Aber.`,
    // Belt and braces: the forge sets FORCE_PRIVATE, but the intent is stated in the request too.
    private: true,
    auto_init: true,
    default_branch: "main",
  });
  if (created.ok) return await created.json() as ForgeRepository;

  // 409 here is a race between two enrolments of one gateway, and the loser reads what the winner
  // made. A repository outlives its appliance so a re-flashed gateway gets its flow history back.
  if (created.status === 409) {
    const raced = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}`);
    if (raced.ok) return await raced.json() as ForgeRepository;
  }
  throw await refused(`could not create repository '${name}'`, created);
}

/** The commit a branch is at, or null when there is none. The branches call never reads a tag. */
async function branchHead(cfg: ForgeConfig, ref: RepositoryRef, branch: string): Promise<string | null> {
  const found = await forgeApi(cfg, "GET", `/repos/${repoPath(ref)}/branches/${branch}`);
  if (found.status === 404) return null;
  if (!found.ok) throw await refused(`could not read the branch '${branch}' of '${repoPath(ref)}'`, found);
  return ((await found.json()) as { commit?: { id?: string } }).commit?.id ?? null;
}

/** One entry of a tree, by the tree's id or its commit's, or null when it has none of that name. */
async function treeEntry(
  cfg: ForgeConfig,
  ref: RepositoryRef,
  id: string,
  name: string,
): Promise<{ type: string; sha: string } | null> {
  for (let page = 1;; page += 1) {
    const listed = await forgeApi(cfg, "GET", `/repos/${repoPath(ref)}/git/trees/${id}?page=${page}&per_page=1000`);
    if (!listed.ok) throw await refused(`could not read the tree ${id.slice(0, 12)} of '${repoPath(ref)}'`, listed);
    const { tree, truncated } = await listed.json() as {
      tree?: { path: string; type: string; sha: string }[] | null;
      truncated?: boolean;
    };
    const entry = tree?.find((e) => e.path === name);
    if (entry) return entry;
    if (!truncated) return null;
  }
}

/**
 * A file at a commit, with its blob's id, or null when the commit has no such file. Found by object
 * id at every step, because Gitea's contents and raw calls take a branch or a tag NAMED as the
 * commit's id ahead of the commit, and both teams can push a branch of any name. Measured against
 * gitea/gitea:28.3.0.
 */
export async function fileAtCommit(
  cfg: ForgeConfig,
  ref: RepositoryRef,
  path: string,
  commit: string,
): Promise<{ sha: string; bytes: Uint8Array } | null> {
  const segments = path.split("/");
  let sha = commit;
  for (const [i, segment] of segments.entries()) {
    const entry = await treeEntry(cfg, ref, sha, segment);
    if (entry?.type !== (i === segments.length - 1 ? "blob" : "tree")) return null;
    sha = entry.sha;
  }
  const blob = await forgeApi(cfg, "GET", `/repos/${repoPath(ref)}/git/blobs/${sha}`);
  if (!blob.ok) throw await refused(`could not read '${path}' of '${repoPath(ref)}'`, blob);
  // Gitea leaves the content out above its blob limit, 10 MiB by default.
  const { content } = await blob.json() as { content?: string | null };
  if (typeof content !== "string") throw new Error(`'${path}' of '${repoPath(ref)}' is larger than the forge's API gives`);
  return { sha, bytes: Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) };
}

/** A file on `main` of a gateway's repository, or null when `main` has no such file. */
async function fileOnMain(cfg: ForgeConfig, name: string, path: string) {
  const commit = await branchHead(cfg, { name }, MAIN_BRANCH);
  return commit === null ? null : await fileAtCommit(cfg, { name }, path, commit);
}

const INCIDENT_LABEL = "incident";
const INCIDENT_TEMPLATE_PATH = ".gitea/ISSUE_TEMPLATE/incident.md";

/**
 * An issue template and its label, committed to `main` in the one moment the machine account still
 * may: while the rule on it is open to that account alone (`enable_push: false` binds it too; the
 * contents API answers 403 afterwards). Issues are the gateway's incident log. Idempotent on the
 * file and the label.
 */
async function seedIssueTemplate(cfg: ForgeConfig, name: string): Promise<void> {
  const label = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/labels`, {
    name: INCIDENT_LABEL,
    color: "#b60205",
    description: "Something this gateway did, or failed to do, that somebody had to look at.",
  });
  // 409 and 422 are both Gitea's "that label exists".
  if (!label.ok && label.status !== 409 && label.status !== 422) {
    throw await refused(`could not create the '${INCIDENT_LABEL}' label on '${name}'`, label);
  }

  if (await fileOnMain(cfg, name, INCIDENT_TEMPLATE_PATH)) return;

  const template = [
    "---",
    "name: Incident",
    "about: Something this gateway did, or failed to do, that somebody had to look at",
    'title: "Incident: "',
    `labels: ${INCIDENT_LABEL}`,
    "---",
    "",
    "**What happened**",
    "",
    "",
    "**When it was first noticed, and how** (an alert, a person on the floor, the dashboard)",
    "",
    "",
    "**What the appliance was running** (the commit on `main` at the time; the dashboard shows the",
    "flow hash the appliance last reported)",
    "",
    "",
    "**What was done**",
    "",
    "",
    "**What should change** (a pull request here, a wiki page, or nothing)",
    "",
  ].join("\n");
  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/contents/${INCIDENT_TEMPLATE_PATH}`, {
    content: btoa(String.fromCharCode(...new TextEncoder().encode(template))),
    message: "Add the incident template",
    branch: "main",
  });
  if (!created.ok) throw await refused(`could not commit '${INCIDENT_TEMPLATE_PATH}' to '${name}'`, created);
  console.log(`forge: '${name}' carries the incident template`);
}

/**
 * Remove `.aber/manifest.json` from a gateway's repository, in the same window as the template
 * above. A repository generated from `platform/gateway-custom-example` carries a copy of it
 * (measured against gitea/gitea:1.27.3: `POST /generate` copies the whole tree), and that file
 * states the digest and publication date of the *example*, about a repository that is now one
 * gateway's own. Nothing reads it here -- the sweep only reads manifests in the platform
 * organisation -- so this is about the repository being the record rather than about correctness.
 * Absent on every repository not seeded from the template, which is the ordinary case.
 */
async function dropCopiedManifest(cfg: ForgeConfig, name: string): Promise<void> {
  let present;
  try {
    present = await fileOnMain(cfg, name, PLATFORM_MANIFEST_PATH);
  } catch (err) {
    console.warn(`forge: could not check '${PLATFORM_MANIFEST_PATH}' on '${name}' (${err instanceof Error ? err.message : err}); leaving it`);
    return;
  }
  if (!present) return;
  const removed = await forgeApi(cfg, "DELETE", `/repos/${FORGE_ORGANISATION}/${name}/contents/${PLATFORM_MANIFEST_PATH}`, {
    sha: present.sha,
    message: "Remove the manifest copied from the template; this repository is this gateway's own",
    branch: "main",
  });
  // NOT FATAL. A repository that keeps a stray file is worse reading and works identically; closing
  // the branch matters more and must still happen.
  if (!removed.ok) {
    console.warn(`forge: could not remove '${PLATFORM_MANIFEST_PATH}' from '${name}' (${removed.status}); leaving it`);
    return;
  }
  console.log(`forge: '${name}' was seeded from a template; removed the copied ${PLATFORM_MANIFEST_PATH}`);
}

/**
 * What a person may do in a gateway's repository comes from their team, so anybody who holds it by
 * name is removed from it. Gitea makes whoever creates a repository its administrator and keeps them
 * so, after enrolment adopts it and after their role has gone: their own API token still changes its
 * rules. Returns who was removed, and who the forge would not remove. Measured against
 * gitea/gitea:28.3.0.
 */
export async function ensureHeldByTeams(
  cfg: ForgeConfig,
  name: string,
): Promise<{ removed: string[]; kept: string[] }> {
  const path = `/repos/${FORGE_ORGANISATION}/${name}/collaborators`;
  const holders: string[] = [];
  for (let page = 1;; page += 1) {
    const listed = await forgeApi(cfg, "GET", `${path}?page=${page}&limit=50`);
    if (!listed.ok) throw await refused(`could not list who holds '${name}'`, listed);
    const batch = await listed.json() as { login: string }[];
    holders.push(...batch.map(({ login }) => login));
    if (batch.length < 50) break;
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const login of holders) {
    const gone = await forgeApi(cfg, "DELETE", `${path}/${encodeURIComponent(login)}`);
    const is = gone.ok || gone.status === 404 ? "removed from it" : `the forge would not remove them (${gone.status})`;
    console.warn(`forge: '${name}' was held by '${login}' beside the teams; ${is}`);
    (gone.ok || gone.status === 404 ? removed : kept).push(login);
  }
  return { removed, kept };
}

/**
 * Dismiss every approval on the proposals open against a branch. Gitea counts an approval by what the
 * rule said when it was given, so one given while the rule was looser would still merge (measured).
 */
async function dismissApprovals(cfg: ForgeConfig, name: string, branch: string): Promise<void> {
  const path = `/repos/${FORGE_ORGANISATION}/${name}/pulls`;
  const pages = async <T>(of: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1;; page += 1) {
      const listed = await forgeApi(cfg, "GET", `${of}${of.includes("?") ? "&" : "?"}page=${page}&limit=50`);
      if (!listed.ok) throw await refused(`could not read the proposals of '${name}'`, listed);
      const batch = await listed.json() as T[];
      all.push(...batch);
      if (batch.length < 50) return all;
    }
  };
  for (const { number, base } of await pages<{ number: number; base: { ref: string } }>(`${path}?state=open`)) {
    if (base.ref !== branch) continue;
    const reviews = await pages<{ id: number; state: string; official: boolean; dismissed: boolean }>(`${path}/${number}/reviews`);
    for (const { id } of reviews.filter((r) => r.state === "APPROVED" && r.official && !r.dismissed)) {
      const dismissed = await forgeApi(cfg, "POST", `${path}/${number}/reviews/${id}/dismissals`, {
        message: `The rule on \`${branch}\` asked for less than an Administrator's approval when this was given. Please approve again.`,
        priors: false,
      });
      if (!dismissed.ok) throw await refused(`could not dismiss an approval on #${number} of '${name}'`, dismissed);
      console.warn(`forge: dismissed an approval on #${number} of '${name}', given while the rule on '${branch}' was looser`);
    }
  }
}

interface BranchRule {
  rule_name: string;
  priority?: number;
  enable_push?: boolean;
  enable_push_whitelist?: boolean;
  push_whitelist_usernames?: string[] | null;
  push_whitelist_teams?: string[] | null;
  push_whitelist_deploy_keys?: boolean;
  required_approvals?: number;
  enable_approvals_whitelist?: boolean;
  approvals_whitelist_username?: string[] | null;
  approvals_whitelist_teams?: string[] | null;
  enable_bypass_allowlist?: boolean;
  dismiss_stale_approvals?: boolean;
  enable_status_check?: boolean;
  status_check_contexts?: string[] | null;
  unprotected_file_patterns?: string;
}

/** Rules are matched by ascending priority and the first match decides, so the catch-all sits behind every other. */
const CATCH_ALL_PRIORITY = 1000;

/** The approval on a gateway's `main`: an Administrator's, on what is merged, and round it no way. */
const APPROVAL = {
  enable_approvals_whitelist: true,
  approvals_whitelist_teams: [FORGE_TEAMS.Administrator] as string[],
  approvals_whitelist_username: [] as string[],
  dismiss_stale_approvals: true,
};

/** What a rule asks less than `main`'s does: the ways past an Administrator's approval it leaves open. */
function looser(rule: BranchRule): { open: boolean; unapproved: boolean; passable: boolean } {
  const approvers = [...(rule.approvals_whitelist_teams ?? []), ...(rule.approvals_whitelist_username ?? [])];
  return {
    open: Boolean(rule.enable_push || rule.push_whitelist_deploy_keys),
    unapproved: !(Number(rule.required_approvals) >= 1) || !rule.enable_approvals_whitelist ||
      !rule.dismiss_stale_approvals || approvers.join() !== APPROVAL.approvals_whitelist_teams.join(),
    passable: Boolean(rule.enable_bypass_allowlist) || (rule.unprotected_file_patterns ?? "").trim() !== "",
  };
}

/** Whether the rule on `main` is as it is made: open to the machine account alone, to be seeded and closed. */
function openToTheMachineAccount(cfg: ForgeConfig, rule: BranchRule): boolean {
  const [only, ...others] = rule.push_whitelist_usernames ?? [];
  return rule.enable_push === true && rule.enable_push_whitelist === true && !rule.push_whitelist_deploy_keys &&
    (rule.push_whitelist_teams ?? []).length === 0 && others.length === 0 &&
    only?.toLowerCase() === cfg.user.toLowerCase();
}

/**
 * Protect `main`: no direct pushes, one approval from `administrators` before a merge.
 * `enable_push: false` is what makes "deploy only what is committed" mean "deploy only what was
 * reviewed"; merging stays allowed to anyone with write once approvals are met, so a manager can
 * merge after an administrator approves. `dismiss_stale_approvals` means a change pushed after
 * approval needs approving again. `main` also requires the `aber/flow-shape` status, so a
 * `flows.json` that the appliance would refuse cannot be merged in the first place.
 *
 * `gateway` is a gateway's repository, whose rule is made open to the machine account alone, for
 * finishBranchRules() to seed and close: `main` is never without its rule. A found rule has what
 * makes the approval real put back where it is looser -- no push, no bypass, no unprotected file, an
 * approval from `administrators` and from nobody else, stale ones dismissed, ahead of the catch-all --
 * and keeps what only tightens it: more approvals, and other required checks beside the shape check.
 * An approval already given under a looser rule is dismissed.
 *
 * A playbook made by hand is protected the same way, and a found rule on one is left as an
 * administrator may have tuned it but for pushes and the shape check. Returns whether anything changed.
 */
export async function ensureBranchProtection(
  cfg: ForgeConfig,
  name: string,
  options: { gateway: boolean } = { gateway: true },
): Promise<boolean> {
  const path = `/repos/${FORGE_ORGANISATION}/${name}/branch_protections`;
  const existing = await forgeApi(cfg, "GET", `${path}/${MAIN_BRANCH}`);
  if (existing.ok) {
    const rule = await existing.json() as BranchRule;
    const found = looser(rule);
    const open = found.open && !(options.gateway && openToTheMachineAccount(cfg, rule));
    const required = rule.status_check_contexts ?? [];
    const unchecked = !rule.enable_status_check || !required.includes(FLOW_SHAPE_CONTEXT);
    const unapproved = options.gateway && found.unapproved;
    const behind = Number(rule.priority) >= CATCH_ALL_PRIORITY;
    const passable = options.gateway && (found.passable || behind);
    if (!open && !unchecked && !unapproved && !passable) return false;
    const held = await forgeApi(cfg, "PATCH", `${path}/${MAIN_BRANCH}`, {
      ...(open ? { enable_push: false, push_whitelist_deploy_keys: false } : {}),
      // The contexts already required are kept: an administrator may have added one, and this is
      // about `aber/flow-shape` being among them rather than about it being the only one.
      ...(unchecked ? { enable_status_check: true, status_check_contexts: [...new Set([...required, FLOW_SHAPE_CONTEXT])] } : {}),
      // Stale approvals last: a pass that dies before they are all dismissed leaves the next to do it.
      ...(unapproved
        ? { ...APPROVAL, required_approvals: Math.max(1, Number(rule.required_approvals) || 0), dismiss_stale_approvals: false }
        : {}),
      ...(passable ? { enable_bypass_allowlist: false, unprotected_file_patterns: "", ...(behind ? { priority: 1 } : {}) } : {}),
    });
    if (!held.ok) throw await refused(`could not hold the rule on 'main' of '${name}'`, held);
    if (open) console.warn(`forge: 'main' on '${name}' admitted pushes; closed again`);
    if (unchecked) console.log(`forge: 'main' on '${name}' now requires ${FLOW_SHAPE_CONTEXT}`);
    if (unapproved) console.warn(`forge: 'main' on '${name}' asked for less than an Administrator's approval; put back`);
    if (passable) console.warn(`forge: 'main' on '${name}' had a way past its approval; put back`);
    if (unapproved) {
      await dismissApprovals(cfg, name, MAIN_BRANCH);
      const last = await forgeApi(cfg, "PATCH", `${path}/${MAIN_BRANCH}`, { dismiss_stale_approvals: true });
      if (!last.ok) throw await refused(`could not hold the rule on 'main' of '${name}'`, last);
    }
    return true;
  }
  if (existing.status !== 404) {
    throw await refused(`could not read the branch protection on '${name}'`, existing);
  }
  const created = await forgeApi(cfg, "POST", path, {
    branch_name: MAIN_BRANCH,
    priority: 1,
    ...(options.gateway
      ? { enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [cfg.user] }
      : { enable_push: false }),
    ...APPROVAL,
    required_approvals: 1,
    block_on_rejected_reviews: true,
    // The shape check forge-events posts. Measured against gitea/gitea:1.27.3: a merge is refused
    // 405 "Not all required status checks successful" both when no such status exists and when it
    // is `failure`, and succeeds on `success`. The pull request's own `mergeable` field stays true
    // throughout -- it reports conflicts, not checks -- so the merge endpoint is the enforcement.
    enable_status_check: true,
    status_check_contexts: [FLOW_SHAPE_CONTEXT],
  });
  if (!created.ok) throw await refused(`could not protect 'main' on '${name}'`, created);
  console.log(`forge: 'main' on '${name}' is protected and requires ${FLOW_SHAPE_CONTEXT}`);
  return true;
}

/** Every branch rule a gateway's repository has. Each is put right in place, and any other is removed. */
const GATEWAY_BRANCH_RULES: string[] = [MAIN_BRANCH, APPLIANCE_BRANCH, CATCH_ALL_RULE];

/** Whether a name is one branch's to Gitea's rules, and none of ours: it matches a plain name without case. */
function anotherBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !READ_BRANCHES.includes(name.toLowerCase());
}

/** Whether another rule can stay: it is on one other branch and asks of it what `main`'s rule asks. */
function loosensNothing(rule: BranchRule): boolean {
  const { open, unapproved, passable } = looser(rule);
  return anotherBranch(rule.rule_name) && !open && !unapproved && !passable;
}

/**
 * The last of the branch rules, once each of ours is in place. Any other that could loosen one is
 * removed: the first match by priority decides, so one that matches `main` ahead of ours would be the
 * rule on it. Then a `main` just made is given what the repository carries from the start, which only
 * the machine account may commit while its rule is in that state, and closed to it too. A pass that
 * dies between leaves the rule in that state for the next. Returns whether anything was changed.
 */
export async function finishBranchRules(cfg: ForgeConfig, name: string): Promise<boolean> {
  const path = `/repos/${FORGE_ORGANISATION}/${name}/branch_protections`;
  const listed = await forgeApi(cfg, "GET", path);
  if (!listed.ok) throw await refused(`could not list the branch rules on '${name}'`, listed);
  const rules = await listed.json() as BranchRule[];
  let changed = false;
  for (const { rule_name } of rules.filter((r) => !GATEWAY_BRANCH_RULES.includes(r.rule_name) && !loosensNothing(r))) {
    const removed = await forgeApi(cfg, "DELETE", `${path}/${encodeURIComponent(rule_name)}`);
    if (!removed.ok && removed.status !== 404) throw await refused(`could not remove the '${rule_name}' rule from '${name}'`, removed);
    console.warn(`forge: removed the branch rule '${rule_name}' from '${name}', which is not one of Aber's`);
    changed = true;
  }

  const main = rules.find((r) => r.rule_name === MAIN_BRANCH);
  if (!main || !openToTheMachineAccount(cfg, main)) return changed;
  // Nothing was asked of an approval given before the rule was there.
  await dismissApprovals(cfg, name, MAIN_BRANCH);
  await dropCopiedManifest(cfg, name);
  await seedIssueTemplate(cfg, name);
  const version = platformVersion();
  if (version) await seedPlatformPointer(cfg, name, platformTag(version));
  const closed = await forgeApi(cfg, "PATCH", `${path}/${MAIN_BRANCH}`, {
    enable_push: false,
    push_whitelist_usernames: [],
  });
  if (!closed.ok) throw await refused(`could not close 'main' on '${name}' to the machine account`, closed);
  return true;
}

/**
 * The default branch of a gateway's repository is `main`: a person who administered it could have
 * moved it, and before 1.9.1 enrolment told the appliance to follow the default. That appliance still
 * does, so the branch found there is given the rule `main` has, and then `main` is the default again.
 * A branch that cannot be given one, `appliance` among them, leaves the old key as what must go.
 * Returns whether it was moved back.
 */
export async function ensureDefaultBranch(cfg: ForgeConfig, name: string, current: string | undefined): Promise<boolean> {
  if (current === undefined || current === MAIN_BRANCH) return false;
  const path = `/repos/${FORGE_ORGANISATION}/${name}`;
  const ruled = anotherBranch(current);
  if (!ruled) {
    for (const key of await listDeployKeys(cfg, { name })) await deleteDeployKey(cfg, { name }, key);
  }
  const rule = {
    enable_push: false,
    ...APPROVAL,
    required_approvals: 1,
    block_on_rejected_reviews: true,
    enable_bypass_allowlist: false,
    unprotected_file_patterns: "",
    enable_status_check: true,
    status_check_contexts: [FLOW_SHAPE_CONTEXT],
    priority: 1,
  };
  const held = ruled ? await forgeApi(cfg, "PATCH", `${path}/branch_protections/${encodeURIComponent(current)}`, rule) : null;
  const made = held?.status === 404
    ? await forgeApi(cfg, "POST", `${path}/branch_protections`, { branch_name: current, ...rule })
    : held;
  if (made && !made.ok) throw await refused(`could not protect '${current}' on '${name}'`, made);
  if (made) await dismissApprovals(cfg, name, current);

  const moved = await forgeApi(cfg, "PATCH", path, { default_branch: MAIN_BRANCH });
  if (!moved.ok) throw await refused(`could not make 'main' the default branch of '${name}'`, moved);
  if (((await moved.json()) as { default_branch?: string }).default_branch !== MAIN_BRANCH) {
    throw new Error(`'${name}' has no branch 'main' to be its default branch`);
  }
  console.warn(
    `forge: the default branch of '${name}' was '${current}'; it is 'main' again. An appliance that enrolled while it was ` +
      `'${current}' follows that branch until it is set up again; ` +
      (ruled ? "a change to it now needs the approval 'main' needs" : "its key was removed, so that it cannot"),
  );
  return true;
}

/**
 * Post a commit status. `sha` must be a COMMIT: Gitea answers 500 to a blob's sha (measured), which
 * is easy to reach because a contents-API response carries both. Never fatal -- a status that
 * cannot be posted leaves the merge blocked, which is the safe direction, and the caller says so.
 */
export async function postCommitStatus(
  cfg: ForgeConfig,
  repository: string,
  sha: string,
  state: "success" | "failure" | "error" | "pending",
  description: string,
): Promise<boolean> {
  const posted = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${repository}/statuses/${sha}`, {
    context: FLOW_SHAPE_CONTEXT,
    state,
    // Gitea truncates a long description in its own UI; keep it to one readable line.
    description: description.slice(0, 255),
  });
  if (!posted.ok) {
    console.warn(`forge: could not post ${FLOW_SHAPE_CONTEXT}=${state} on '${repository}' at ${sha.slice(0, 12)} (${posted.status})`);
    return false;
  }
  return true;
}

/**
 * The two rules beside `main` on a gateway's repository. `appliance`: pushes admitted from deploy
 * keys and from nobody else, force-push blocked, so the branch is append-only and written only by
 * the appliance (the machine account's contents API answers 403 on it; measured). `**`: every
 * other branch closed to deploy keys and open to both teams, which is what an appliance holding a
 * writable key must never widen. Both may be created before the branch exists. A found rule that
 * disagrees on the fields that matter is patched. Returns whether anything was changed.
 */
export async function ensureApplianceProtection(cfg: ForgeConfig, name: string): Promise<boolean> {
  const rules = [
    {
      rule: APPLIANCE_BRANCH,
      wanted: {
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_deploy_keys: true,
        push_whitelist_usernames: [],
        push_whitelist_teams: [],
        enable_force_push: false,
        unprotected_file_patterns: "",
        priority: 2,
      },
      differs: (r: Record<string, unknown>) =>
        r.enable_push !== true || r.enable_push_whitelist !== true || r.push_whitelist_deploy_keys !== true ||
        r.enable_force_push === true || Boolean(r.unprotected_file_patterns) ||
        Number(r.priority) >= CATCH_ALL_PRIORITY ||
        ((r.push_whitelist_usernames as string[] | undefined) ?? []).length !== 0 ||
        ((r.push_whitelist_teams as string[] | undefined) ?? []).length !== 0,
    },
    {
      rule: CATCH_ALL_RULE,
      wanted: {
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_deploy_keys: false,
        push_whitelist_teams: [FORGE_TEAMS.Administrator, FORGE_TEAMS.Shopfloor_Manager],
        unprotected_file_patterns: "",
        // Behind every named rule whatever order they were created in.
        priority: CATCH_ALL_PRIORITY,
      },
      differs: (r: Record<string, unknown>) =>
        r.enable_push !== true || r.enable_push_whitelist !== true || r.push_whitelist_deploy_keys === true ||
        Boolean(r.unprotected_file_patterns) || r.priority !== CATCH_ALL_PRIORITY,
    },
  ];

  let changed = false;
  for (const { rule, wanted, differs } of rules) {
    const path = `/repos/${FORGE_ORGANISATION}/${name}/branch_protections/${encodeURIComponent(rule)}`;
    const existing = await forgeApi(cfg, "GET", path);
    if (existing.ok) {
      if (!differs(await existing.json() as Record<string, unknown>)) continue;
      const patched = await forgeApi(cfg, "PATCH", path, wanted);
      if (!patched.ok) throw await refused(`could not correct the '${rule}' rule on '${name}'`, patched);
      console.warn(`forge: the '${rule}' rule on '${name}' disagreed with the policy; corrected`);
      changed = true;
      continue;
    }
    if (existing.status !== 404) throw await refused(`could not read the '${rule}' rule on '${name}'`, existing);
    const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/branch_protections`, {
      branch_name: rule,
      ...wanted,
    });
    if (!created.ok) throw await refused(`could not create the '${rule}' rule on '${name}'`, created);
    console.log(`forge: '${rule}' on '${name}' is protected`);
    changed = true;
  }
  return changed;
}

/**
 * The branches the appliance and the platform read, which no tag may share a name with: Git takes a
 * short name for a tag before a branch, and so do Gitea's contents and trees calls.
 */
const READ_BRANCHES = [MAIN_BRANCH, APPLIANCE_BRANCH];

/**
 * The patterns of the two tag rules: one matches the given names in any case, the other every other
 * name. Exact complements, because Gitea admits whoever any matching rule admits. Spelt out, because
 * Go's regular expressions have no negative lookahead, and Gitea matches a rule with case. The
 * slashes are how Gitea takes a regular expression rather than a glob.
 */
export function tagPatterns(names: string[]): { named: string; others: string } {
  const either = (c: string) => `${c.toUpperCase()}${c}`;
  const named = names.map((name) => [...name].map((c) => `[${either(c)}]`).join(""));
  // What may follow, given what is left of each name that reads the same so far.
  const others = (rest: string[]): string => {
    const heads = [...new Set(rest.filter(Boolean).map((r) => r[0]))];
    const branches = [
      heads.length ? `[^${heads.map(either).join("")}].*` : ".+",
      ...heads.map((c) => `[${either(c)}]${others(rest.filter((r) => r[0] === c).map((r) => r.slice(1)))}`),
    ];
    return `(?:${branches.join("|")})${rest.includes("") ? "" : "?"}`;
  };
  return { named: `/^(?:${named.join("|")})$/`, others: `/^${others(names)}$/` };
}

interface TagRule {
  id: number;
  name_pattern: string;
  whitelist_usernames?: string[] | null;
  whitelist_teams?: string[] | null;
}

/** A tag found under a name none may carry, and whether it is gone. */
export interface FoundTag {
  tag: string;
  /** The commit it named, or the object itself where that is not a commit. */
  commit: string;
  removed: boolean;
}

export interface TagProtection {
  /** Whether a rule was made, corrected or removed. */
  changed: boolean;
  found: FoundTag[];
}

/**
 * The commit a tag names, or null when there is no such tag. Asked of the refs: Gitea's tags call
 * answers 404 for a tag on a file or a folder, and its list answers 500 beside one (measured).
 */
async function tagCommit(cfg: ForgeConfig, path: string, tag: string): Promise<string | null> {
  const listed = await forgeApi(cfg, "GET", `${path}/git/refs/tags/${tag}`);
  if (listed.status === 404) return null;
  if (!listed.ok) throw await refused(`could not look for the tag '${tag}' at '${path}'`, listed);
  // Every ref under that prefix, so the exact one is picked out.
  const refs = await listed.json() as { ref: string; object: { type: string; sha: string } }[];
  const object = refs.find(({ ref }) => ref === `refs/tags/${tag}`)?.object;
  if (!object) return null;
  if (object.type !== "tag") return object.sha;
  const annotated = await forgeApi(cfg, "GET", `${path}/tags/${tag}`);
  if (!annotated.ok) return object.sha;
  return ((await annotated.json()) as { commit?: { sha?: string } }).commit?.sha ?? object.sha;
}

/**
 * Remove a tag, and the release made from it, which Gitea will not let a tag go without. Asked more
 * than once because Gitea looks a tag up without case, so one that also exists in another case is
 * the one it may take first (measured). Returns whether it is gone.
 */
async function removeTag(cfg: ForgeConfig, path: string, tag: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const deleted = await forgeApi(cfg, "DELETE", `${path}/tags/${tag}`);
    if (deleted.status === 409) await forgeApi(cfg, "DELETE", `${path}/releases/tags/${tag}`);
    if ((await tagCommit(cfg, path, tag)) === null) return true;
  }
  return false;
}

/**
 * The two tag rules on a gateway's repository, and no other. A tag named as a branch in
 * READ_BRANCHES, in any case, is the machine account's to make and to delete and nobody else's, an
 * administrator's and a site administrator's included; every other tag is both teams' and no deploy
 * key's. Any other rule could only open what these close, since Gitea admits whoever any matching
 * rule admits, so one is removed. Then a tag already under such a name is removed, in its exact
 * spelling alone, because Git matches a ref with case. One the forge will not remove is returned,
 * not thrown. Measured against gitea/gitea:28.3.0.
 */
export async function ensureTagProtection(cfg: ForgeConfig, name: string): Promise<TagProtection> {
  const path = `/repos/${FORGE_ORGANISATION}/${name}`;
  const { named, others } = tagPatterns(READ_BRANCHES);
  const wanted: { name_pattern: string; whitelist_usernames: string[]; whitelist_teams: string[] }[] = [
    { name_pattern: named, whitelist_usernames: [cfg.user], whitelist_teams: [] },
    { name_pattern: others, whitelist_usernames: [], whitelist_teams: Object.values(FORGE_TEAMS) },
  ];
  const listRules = async (): Promise<TagRule[]> => {
    const listed = await forgeApi(cfg, "GET", `${path}/tag_protections`);
    if (!listed.ok) throw await refused(`could not list the tag rules on '${name}'`, listed);
    return await listed.json() as TagRule[];
  };
  const spelt = (list: string[] | null | undefined) => (list ?? []).map((n) => n.toLowerCase()).sort().join(" ");
  const agrees = (rule: TagRule | undefined, want: typeof wanted[number]) =>
    rule !== undefined && spelt(rule.whitelist_usernames) === spelt(want.whitelist_usernames) &&
    spelt(rule.whitelist_teams) === spelt(want.whitelist_teams);

  let changed = false;
  const rules = await listRules();
  const kept = new Set<number>();
  for (const want of wanted) {
    const mine = rules.filter((r) => r.name_pattern === want.name_pattern);
    const rule = mine.find((r) => agrees(r, want)) ?? mine[0];
    if (rule) kept.add(rule.id);
    if (agrees(rule, want)) continue;
    const written = rule
      ? await forgeApi(cfg, "PATCH", `${path}/tag_protections/${rule.id}`, want)
      : await forgeApi(cfg, "POST", `${path}/tag_protections`, want);
    // A sweep and an enrolment at once: the other may have made it first.
    if (!written.ok && !(await listRules()).some((r) => r.name_pattern === want.name_pattern && agrees(r, want))) {
      throw await refused(`could not set a tag rule on '${name}'`, written);
    }
    changed = true;
  }
  for (const rule of rules.filter((r) => !kept.has(r.id))) {
    const removed = await forgeApi(cfg, "DELETE", `${path}/tag_protections/${rule.id}`);
    if (!removed.ok && removed.status !== 404) throw await refused(`could not remove a tag rule from '${name}'`, removed);
    console.warn(`forge: removed the tag rule '${rule.name_pattern}' from '${name}', which could only admit more people`);
    changed = true;
  }
  if (changed) console.log(`forge: the tags of '${name}' are protected`);

  const found: FoundTag[] = [];
  for (const tag of READ_BRANCHES) {
    const commit = await tagCommit(cfg, path, tag);
    if (commit === null) continue;
    // Said before it is done, so a pass that dies here has still named the commit.
    console.warn(
      `forge: '${name}' carries a tag named '${tag}' at ${commit}, which an appliance could follow in place of the branch; removing it`,
    );
    const removed = await removeTag(cfg, path, tag);
    if (!removed) console.warn(`forge: the tag '${tag}' on '${name}' could not be removed`);
    found.push({ tag, commit, removed });
  }
  return { changed, found };
}

interface DeployKey {
  id: number;
  key: string;
  title: string;
  read_only: boolean;
}

/** The algorithm and material of a public key, without its comment: what Gitea compares on. */
function keyMaterial(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** The title a gateway's key carries on every repository it is registered on. */
export function deployKeyTitle(sparkplugId: string): string {
  return `gateway ${sparkplugId}`;
}

/** The inverse: the sparkplug_id a key's title names, or null for a key somebody titled by hand. */
export const DEPLOY_KEY_TITLE = /^gateway (gwy[0-9a-f]{21})$/;

/** A repository by owner and name; the gateway organisation unless said otherwise. */
export interface RepositoryRef {
  owner?: string;
  name: string;
}

function repoPath(ref: RepositoryRef): string {
  return `${ref.owner ?? FORGE_ORGANISATION}/${ref.name}`;
}

export async function listDeployKeys(cfg: ForgeConfig, ref: RepositoryRef): Promise<DeployKey[]> {
  const listed = await forgeApi(cfg, "GET", `/repos/${repoPath(ref)}/keys?limit=50`);
  if (!listed.ok) throw await refused(`could not list the deploy keys on '${repoPath(ref)}'`, listed);
  return await listed.json() as DeployKey[];
}

export async function deleteDeployKey(cfg: ForgeConfig, ref: RepositoryRef, key: DeployKey): Promise<void> {
  const deleted = await forgeApi(cfg, "DELETE", `/repos/${repoPath(ref)}/keys/${key.id}`);
  if (!deleted.ok && deleted.status !== 404) {
    throw await refused(`could not remove deploy key '${key.title}' from '${repoPath(ref)}'`, deleted);
  }
}

/**
 * Register a public key on a repository in the wanted mode: kept if it is already there in that
 * mode, re-registered if it is there in the other (Gitea has no edit for a deploy key), added
 * otherwise. Titled by sparkplug_id so revocation has an obvious target; a key already carrying
 * that title with other material is a replaced appliance's, and goes first, because Gitea refuses
 * a second key under one title (measured). Returns what happened.
 */
export async function ensureDeployKey(
  cfg: ForgeConfig,
  ref: RepositoryRef,
  sparkplugId: string,
  publicKey: string,
  readOnly: boolean,
): Promise<"kept" | "registered" | "rewritten"> {
  const material = keyMaterial(publicKey);
  const title = deployKeyTitle(sparkplugId);
  const keys = await listDeployKeys(cfg, ref);
  const found = keys.find((k) => keyMaterial(k.key) === material);
  if (found && found.read_only === readOnly) return "kept";
  if (found) await deleteDeployKey(cfg, ref, found);
  for (const stale of keys.filter((k) => k.title === title && keyMaterial(k.key) !== material)) {
    await deleteDeployKey(cfg, ref, stale);
    console.log(`forge: removed a superseded key titled '${title}' from '${repoPath(ref)}'`);
  }

  const response = await forgeApi(cfg, "POST", `/repos/${repoPath(ref)}/keys`, {
    title,
    key: publicKey,
    read_only: readOnly,
  });
  if (!response.ok) throw await refused(`could not register the deploy key on '${repoPath(ref)}'`, response);
  console.log(`forge: ${sparkplugId}'s key is ${readOnly ? "read-only" : "read-write"} on '${repoPath(ref)}'`);
  return found ? "rewritten" : "registered";
}

// The platform repository

/**
 * The platform organisation and its readers team, created if absent. Private, like `gateways`;
 * the readers team has read on every repository in it and may create none, and both dashboard
 * teams are seated in it by forge-membership and the sweep. Returns the team's id.
 */
export async function ensurePlatformOrganisation(cfg: ForgeConfig): Promise<number> {
  const org = await forgeApi(cfg, "GET", `/orgs/${PLATFORM_ORGANISATION}`);
  if (org.status === 404) {
    const created = await forgeApi(cfg, "POST", "/orgs", {
      username: PLATFORM_ORGANISATION,
      full_name: "Platform",
      description: "The playbook every appliance converges to. Published by Aber; changed in its repository, never here.",
      visibility: "private",
      repo_admin_change_team_access: false,
    });
    if (!created.ok) throw await refused(`could not create organisation '${PLATFORM_ORGANISATION}'`, created);
    console.log(`forge: created organisation '${PLATFORM_ORGANISATION}'`);
  } else if (!org.ok) {
    throw await refused(`could not read organisation '${PLATFORM_ORGANISATION}'`, org);
  }

  const listed = await forgeApi(cfg, "GET", `/orgs/${PLATFORM_ORGANISATION}/teams?limit=50`);
  if (!listed.ok) throw await refused("could not list the platform organisation's teams", listed);
  const teams = await listed.json() as { id: number; name: string }[];
  const existing = teams.find((t) => t.name === PLATFORM_READERS_TEAM);
  if (existing) return existing.id;

  const created = await forgeApi(cfg, "POST", `/orgs/${PLATFORM_ORGANISATION}/teams`, {
    name: PLATFORM_READERS_TEAM,
    description: "Everyone the forge admits, reading the platform playbook. Placed by forge-membership.",
    permission: "read",
    includes_all_repositories: true,
    can_create_org_repo: false,
    units: ["repo.code", "repo.issues", "repo.releases", "repo.wiki"],
  });
  if (!created.ok) throw await refused(`could not create team '${PLATFORM_READERS_TEAM}'`, created);
  console.log(`forge: created team '${PLATFORM_READERS_TEAM}' in '${PLATFORM_ORGANISATION}'`);
  return ((await created.json()) as { id: number }).id;
}

/**
 * A repository the platform publishes into, created if absent, with `main` admitting pushes from
 * the machine account and from nobody else: its content comes from this repository's own tree, and
 * a change to it is a pull request here, not there. Deploy keys are not whitelisted, so every
 * appliance's read-only key reads it and none writes it.
 *
 * `template` marks it as one the forge's **Use this template** button copies. Set on an existing
 * repository too, because the flag arrived after the repository did on any forge that predates it.
 */
async function ensurePublishedRepository(
  cfg: ForgeConfig,
  name: string,
  description: string,
  template = false,
): Promise<ForgeRepository> {
  await ensurePlatformOrganisation(cfg);
  const path = `/repos/${PLATFORM_ORGANISATION}/${name}`;
  let repo: ForgeRepository & { template?: boolean };
  const existing = await forgeApi(cfg, "GET", path);
  if (existing.ok) {
    repo = await existing.json() as ForgeRepository & { template?: boolean };
  } else if (existing.status === 404) {
    const created = await forgeApi(cfg, "POST", `/orgs/${PLATFORM_ORGANISATION}/repos`, {
      name,
      description,
      private: true,
      auto_init: true,
      default_branch: "main",
    });
    if (!created.ok) throw await refused(`could not create repository '${name}'`, created);
    repo = await created.json() as ForgeRepository & { template?: boolean };
    console.log(`forge: created '${PLATFORM_ORGANISATION}/${name}'`);
  } else {
    throw await refused(`could not read repository '${name}'`, existing);
  }

  if (template && repo.template !== true) {
    const marked = await forgeApi(cfg, "PATCH", path, { template: true });
    if (!marked.ok) throw await refused(`could not mark '${name}' as a template repository`, marked);
    console.log(`forge: '${PLATFORM_ORGANISATION}/${name}' is a template repository`);
  }

  const rule = await forgeApi(cfg, "GET", `${path}/branch_protections/main`);
  if (rule.status === 404) {
    const created = await forgeApi(cfg, "POST", `${path}/branch_protections`, {
      branch_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: [cfg.user],
      push_whitelist_teams: [],
      push_whitelist_deploy_keys: false,
      enable_force_push: false,
    });
    if (!created.ok) throw await refused(`could not protect 'main' on '${name}'`, created);
    console.log(`forge: 'main' on '${PLATFORM_ORGANISATION}/${name}' admits the machine account alone`);
  } else if (!rule.ok) {
    throw await refused(`could not read the branch protection on '${name}'`, rule);
  }
  return repo;
}

/**
 * The platform repository. Enrolment calls this to be sure there is something for the appliance's
 * read-only key to be registered against; the sweep publishes its content.
 */
export async function ensurePlatformRepository(cfg: ForgeConfig): Promise<ForgeRepository> {
  return await ensurePublishedRepository(
    cfg,
    PLATFORM_REPOSITORY,
    "The playbook every gateway appliance converges to, at the tag its own platform.yml names. Published by Aber.",
  );
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/**
 * A file's text at a ref, or null when absent. For the platform organisation's repositories, where
 * nobody else can make a branch or a tag; a gateway's is read by fileAtCommit().
 */
async function fileAt(cfg: ForgeConfig, ref: RepositoryRef, path: string, at: string): Promise<string | null> {
  const raw = await forgeApi(cfg, "GET", `/repos/${repoPath(ref)}/raw/${path}?ref=${encodeURIComponent(at)}`);
  if (raw.status === 404) return null;
  if (!raw.ok) throw await refused(`could not read '${path}' of '${repoPath(ref)}' at ${at}`, raw);
  return await raw.text();
}

async function manifestDigestAt(cfg: ForgeConfig, name: string, at: string): Promise<string | null> {
  const text = await fileAt(cfg, { owner: PLATFORM_ORGANISATION, name }, PLATFORM_MANIFEST_PATH, at);
  if (text === null) return null;
  try {
    const digest = (JSON.parse(text) as { digest?: unknown }).digest;
    return typeof digest === "string" ? digest : null;
  } catch {
    return null;
  }
}

export interface PlatformPublication {
  repository: ForgeRepository;
  /** The tag this publication carries, or null for a repository published untagged. */
  tag: string | null;
  /** Whether this call committed anything. */
  published: boolean;
  /** A tag found at other content than this build ships, which is a release that cannot move. */
  warning: string | null;
}

/** What one published repository is, so the sweep declares them rather than repeating this. */
export interface PublishSpec {
  /** Repository name inside the platform organisation. */
  name: string;
  description: string;
  files: Record<string, string>;
  digest: string;
  /** The version to tag this build's content with, or null to publish untagged. */
  version: string | null;
  /** Whether the forge's **Use this template** button copies it. */
  template?: boolean;
  /**
   * Path prefixes this build does not ship and must not remove. `trust/` is written by the sweep
   * from the broker's own root rather than from this repository's tree, so without this the next
   * publication of the playbook would delete it as a file no longer shipped.
   */
  unmanaged?: string[];
}

/**
 * Publish one repository the platform owns: `main` holds what this build ships, and the tag for
 * this build's version, when it takes one, points at it. One read decides whether `main` is
 * current (the digest in the manifest file); otherwise one commit writes every file, updates what
 * changed and deletes what is no longer shipped. The tag is created once and never moved: a
 * released version's content is immutable, and a tag found at other content is reported, not
 * corrected. Bump the version, or on a development forge delete the tag by hand.
 */
export async function publishToForge(
  cfg: ForgeConfig,
  { name, description, files, digest, version, template = false, unmanaged = [] }: PublishSpec,
): Promise<PlatformPublication> {
  const repository = await ensurePublishedRepository(cfg, name, description, template);
  const ref = { owner: PLATFORM_ORGANISATION, name };
  const path = `/repos/${repoPath(ref)}`;
  const tag = version === null ? null : platformTag(version);
  let published = false;

  if ((await manifestDigestAt(cfg, name, "main")) !== digest) {
    const tree = await forgeApi(cfg, "GET", `${path}/git/trees/main?recursive=true&per_page=1000`);
    if (!tree.ok) throw await refused(`could not read the tree of '${name}'`, tree);
    const existing = new Map(
      (((await tree.json()) as { tree?: { path: string; type: string; sha: string }[] }).tree ?? [])
        .filter((e) => e.type === "blob")
        .map((e) => [e.path, e.sha]),
    );
    const wanted: Record<string, string> = {
      ...files,
      [PLATFORM_MANIFEST_PATH]: JSON.stringify({ digest, version, published_at: new Date().toISOString() }, null, 2) + "\n",
    };
    const operations = [
      ...Object.entries(wanted).map(([p, text]) => (
        existing.has(p)
          ? { operation: "update", path: p, sha: existing.get(p), content: base64(text) }
          : { operation: "create", path: p, content: base64(text) }
      )),
      ...[...existing.keys()]
        .filter((p) => !(p in wanted) && !unmanaged.some((prefix) => p.startsWith(prefix)))
        .map((p) => ({ operation: "delete", path: p, sha: existing.get(p) })),
    ];
    const committed = await forgeApi(cfg, "POST", `${path}/contents`, {
      branch: "main",
      message: tag
        ? `Publish ${name} shipped with ${tag} (${digest.slice(0, 12)})`
        : `Publish ${name} (${digest.slice(0, 12)})`,
      files: operations,
    });
    if (!committed.ok) throw await refused(`could not publish '${name}'`, committed);
    published = true;
    console.log(`forge: published ${name} (${operations.length} operations, digest ${digest.slice(0, 12)})`);
  }

  // An untagged repository is finished here: the example is copied, never converged to, so there
  // is no released version of it for an appliance to pin.
  if (tag === null) return { repository, tag: null, published, warning: null };

  let warning: string | null = null;
  const found = await forgeApi(cfg, "GET", `${path}/tags/${encodeURIComponent(tag)}`);
  if (found.status === 404) {
    const created = await forgeApi(cfg, "POST", `${path}/tags`, {
      tag_name: tag,
      target: "main",
      message: `${name} shipped with ${tag}`,
    });
    if (!created.ok) throw await refused(`could not tag '${name}' as ${tag}`, created);
    console.log(`forge: tagged ${name} ${tag}`);
  } else if (!found.ok) {
    throw await refused(`could not read tag ${tag} on '${name}'`, found);
  } else if ((await manifestDigestAt(cfg, name, tag)) !== digest) {
    warning = `${PLATFORM_ORGANISATION}/${name} is tagged ${tag} at other content than this build ships; ` +
      "a released version's content does not move. Bump the version, or on a development forge delete the tag.";
    console.warn(`forge: ${warning}`);
  }
  return { repository, tag, published, warning };
}

/**
 * One root in the bundle: the certificate, and what the credential service said about it.
 */
export interface TrustRoot {
  ca_cert: string;
  not_before: string;
  not_after: string;
  spki_sha256: string;
}

/** What `trust/manifest.json` records about each root in the bundle beside it. */
export interface TrustEntry {
  spki_sha256: string;
  not_before: string;
  not_after: string;
}

/** Every certificate block in a PEM, in the order they appear. */
function certificateBlocks(text: string): string[] {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)]
    .map((m) => m[0].trim());
}

export interface TrustBundle {
  bundle: string;
  manifest: string;
  roots: TrustEntry[];
  /** Whether this differs from what is on `main` and therefore has to be committed. */
  changed: boolean;
}

/**
 * The bundle an appliance should hold: the root the broker presents now, plus every root already
 * published that has not expired.
 *
 * THE OLD ROOT STAYS UNTIL IT EXPIRES, and that ordering is the whole mechanism. An appliance
 * converges hourly, so at any moment some of the fleet holds the new bundle and some the old one.
 * A bundle carrying only the new root would cut off every appliance that has not converged yet the
 * moment the broker's leaf is re-issued under it; a bundle carrying both verifies a broker
 * presenting either, which makes the two changes independent and the order of them recoverable.
 * Trusting a root whose replacement is already in the same bundle costs nothing this deployment
 * did not already accept when it issued it.
 *
 * A ROOT THE MANIFEST CANNOT DATE IS KEPT. The manifest is written here, so the case is a bundle
 * edited by hand; dropping a root that is still signing the broker's certificate takes the fleet
 * off the air, and keeping one that has expired costs nothing -- an expired root verifies nothing.
 *
 * Pure, and told the time rather than reading it, so a test can place a root either side of now.
 */
export async function mergeTrustBundle(
  bundle: string | null,
  manifest: string | null,
  root: TrustRoot,
  now: Date,
): Promise<TrustBundle> {
  const dated = new Map<string, TrustEntry>();
  let previous: TrustEntry[] = [];
  try {
    previous = ((JSON.parse(manifest ?? "null") ?? {}) as { roots?: TrustEntry[] }).roots ?? [];
    for (const entry of previous) {
      if (entry && typeof entry.spki_sha256 === "string") dated.set(entry.spki_sha256, entry);
    }
  } catch {
    // An unparseable manifest is one nobody here wrote. The bundle beside it is still read, and
    // every root in it is kept for the reason above.
  }

  const current = certificateBlocks(root.ca_cert)[0] ?? "";
  if (!current) throw new Error("the credential service returned no certificate to publish");
  const held = new Map<string, { pem: string; entry: TrustEntry }>();
  for (const pem of certificateBlocks(bundle ?? "")) {
    const pin = await spkiPin(pem);
    // A block whose public key cannot be read is not a certificate an appliance could use either.
    if (!pin || pin === root.spki_sha256) continue;
    const entry = dated.get(pin);
    if (entry && Date.parse(entry.not_after) <= now.getTime()) continue;
    held.set(pin, {
      pem,
      entry: entry ?? { spki_sha256: pin, not_before: "", not_after: "" },
    });
  }

  // The current root first, so the file reads as "this one, and these until they expire", and so
  // the bytes are stable across passes rather than following the order of a tree read.
  const ordered = [
    { pem: current, entry: { spki_sha256: root.spki_sha256, not_before: root.not_before, not_after: root.not_after } },
    ...[...held.values()].sort((a, b) => a.entry.spki_sha256.localeCompare(b.entry.spki_sha256)),
  ];
  const roots = ordered.map((r) => r.entry);
  const text = ordered.map((r) => `${r.pem}\n`).join("");
  return {
    bundle: text,
    manifest: JSON.stringify(
      { current: root.spki_sha256, roots, published_at: now.toISOString() },
      null,
      2,
    ) + "\n",
    roots,
    // THE BYTES, NOT THE SET OF KEYS. A root re-issued with the same key -- which is what
    // internal-ca.yaml's `rotationPolicy: Never` does a year before expiry -- keeps its pin and
    // changes its certificate, and that is precisely the change the fleet has to be given.
    changed: text !== (bundle ?? "") || JSON.stringify(roots) !== JSON.stringify(previous),
  };
}

/**
 * Publish the trust bundle onto `main` of a published repository, from the root the credential
 * service reports. One read of each file, one commit when they differ, nothing at all when they
 * do not -- which is every pass but the ones after a re-issue.
 */
export async function publishTrust(
  cfg: ForgeConfig,
  name: string,
  root: TrustRoot,
): Promise<{ published: boolean; roots: TrustEntry[] }> {
  const ref = { owner: PLATFORM_ORGANISATION, name };
  const path = `/repos/${repoPath(ref)}`;
  const bundle = await fileAt(cfg, ref, TRUST_BUNDLE_PATH, "main");
  const manifest = await fileAt(cfg, ref, TRUST_MANIFEST_PATH, "main");
  const merged = await mergeTrustBundle(bundle, manifest, root, new Date());
  if (!merged.changed) return { published: false, roots: merged.roots };

  const wanted: [string, string][] = [
    [TRUST_BUNDLE_PATH, merged.bundle],
    [TRUST_MANIFEST_PATH, merged.manifest],
  ];
  const operations = [];
  for (const [file, content] of wanted) {
    const present = await forgeApi(cfg, "GET", `${path}/contents/${file}?ref=main`);
    const sha = present.ok ? ((await present.json()) as { sha?: string }).sha : undefined;
    operations.push(
      sha
        ? { operation: "update", path: file, sha, content: base64(content) }
        : { operation: "create", path: file, content: base64(content) },
    );
  }
  const committed = await forgeApi(cfg, "POST", `${path}/contents`, {
    branch: "main",
    message: `Trust: ${merged.roots.length} root(s), current ${root.spki_sha256.slice(0, 12)}`,
    files: operations,
  });
  if (!committed.ok) throw await refused(`could not publish the trust bundle on '${name}'`, committed);
  console.log(`forge: published ${TRUST_PREFIX} on ${name} (${merged.roots.length} root(s))`);
  return { published: true, roots: merged.roots };
}

/**
 * The pointer file in a gateway's repository, committed to `main` in the same moment as the
 * incident template: before the branch is closed. Names the platform tag current at enrolment;
 * afterwards it is changed by pull request. A repository that already holds one keeps it.
 */
async function seedPlatformPointer(cfg: ForgeConfig, name: string, tag: string): Promise<void> {
  if (await fileOnMain(cfg, name, PLATFORM_POINTER_PATH)) return;
  const content = [
    "# The tag of platform/gateway-platform this appliance converges to. Changed by pull request:",
    "# a fleet bump is one pull request per gateway, and a canary is one gateway. `vars` are",
    "# applied to this appliance alone; forge/gateway-platform/README.md in the platform repository",
    "# says which the playbook accepts.",
    "platform:",
    `  tag: ${tag}`,
    "",
  ].join("\n");
  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/contents/${PLATFORM_POINTER_PATH}`, {
    content: base64(content),
    message: `Converge to the platform at ${tag}`,
    branch: "main",
  });
  if (!created.ok) throw await refused(`could not commit '${PLATFORM_POINTER_PATH}' to '${name}'`, created);
  console.log(`forge: '${name}' points at the platform ${tag}`);
}

/**
 * The appliance's own key on its own repository, read-write, and no other key beside it: a
 * re-enrolment is a replaced appliance, and the key the old one held would otherwise stay able to
 * write the `appliance` branch. Every other key on the repository is removed first, whoever added
 * it: Gitea refuses a second key under one title (measured), and the title is the sparkplug id.
 */
async function ensureOnlyDeployKey(
  cfg: ForgeConfig,
  repo: string,
  sparkplugId: string,
  publicKey: string,
): Promise<void> {
  const material = keyMaterial(publicKey);
  for (const key of await listDeployKeys(cfg, { name: repo })) {
    if (keyMaterial(key.key) === material) continue;
    await deleteDeployKey(cfg, { name: repo }, key);
    console.log(`forge: removed deploy key '${key.title}' from '${repo}'; a re-enrolment replaces the appliance`);
  }
  await ensureDeployKey(cfg, { name: repo }, sparkplugId, publicKey, false);
}

/**
 * Seed the wiki's Home page, once. The wiki is the unreviewed half of the repository: a second git
 * repository edited in place by anyone in either team, for what a person needs to know about a
 * gateway and the appliance never reads. A Home page that exists is left as people have edited it;
 * Gitea answers 400 to a second creation.
 */
async function ensureWikiHome(
  cfg: ForgeConfig,
  name: string,
  sparkplugId: string,
  gatewayName: string,
): Promise<void> {
  const existing = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}/wiki/page/Home`);
  if (existing.ok) return;
  if (existing.status !== 404) throw await refused(`could not read the wiki of '${name}'`, existing);

  const content = [
    `# ${gatewayName}`,
    "",
    `Gateway \`${sparkplugId}\`, enrolled ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "This wiki is for what a person needs to know about this gateway and the appliance never reads:",
    "where it is, what it is wired to, who to call, what changed and why. Pages here are edited",
    "directly and are not reviewed.",
    "",
    "The repository beside it is the reverse. `flows.json` there is what the appliance deploys,",
    "`main` is protected, and a change to it goes through a pull request that an administrator",
    "approves. Nothing the appliance deploys belongs in this wiki.",
    "",
  ].join("\n");
  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/wiki/new`, {
    title: "Home",
    content_base64: btoa(String.fromCharCode(...new TextEncoder().encode(content))),
    message: `Seed the wiki for gateway ${sparkplugId}`,
  });
  if (!created.ok) throw await refused(`could not seed the wiki of '${name}'`, created);
  console.log(`forge: seeded the wiki of '${name}'`);
}

/**
 * Register the push webhook on the repository, once. One hook per repository rather than one on the
 * organisation, because only a gateway's repository has a gateway row to record on. Found again by
 * URL on re-enrolment and by the sweep. The secret is the one forge-events verifies with. The
 * branch filter admits `main` and `appliance`, so a push to a proposal branch is not delivered; a
 * found hook with another filter (one registered before the appliance branch existed) is patched.
 * A second hook of ours, left by two registrations racing, is deleted so each push arrives once;
 * the oldest with the right filter is kept. Returns whether anything was changed.
 */
export async function ensureWebhook(cfg: ForgeConfig, name: string): Promise<boolean> {
  if (!cfg.webhookUrl) {
    console.log(`forge: no webhook configured, so '${name}' will not report its pushes`);
    return false;
  }
  const listed = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}/hooks`);
  if (!listed.ok) throw await refused(`could not list the hooks on '${name}'`, listed);
  const hooks = await listed.json() as { id: number; branch_filter?: string; config?: { url?: string } }[];
  const mine = hooks.filter((h) => h.config?.url === cfg.webhookUrl).sort((a, b) => a.id - b.id);
  const ours = mine.find((h) => h.branch_filter === WEBHOOK_BRANCH_FILTER) ?? mine[0];
  let changed = false;
  for (const extra of mine.filter((h) => h !== ours)) {
    const deleted = await forgeApi(cfg, "DELETE", `/repos/${FORGE_ORGANISATION}/${name}/hooks/${extra.id}`);
    // 404 is a hook something else removed first, which is the outcome wanted.
    if (!deleted.ok && deleted.status !== 404) throw await refused(`could not remove a second push webhook from '${name}'`, deleted);
    console.log(`forge: removed a second push webhook (${extra.id}) from '${name}'`);
    changed = true;
  }
  if (ours) {
    if (ours.branch_filter === WEBHOOK_BRANCH_FILTER) return changed;
    const patched = await forgeApi(cfg, "PATCH", `/repos/${FORGE_ORGANISATION}/${name}/hooks/${ours.id}`, {
      branch_filter: WEBHOOK_BRANCH_FILTER,
    });
    if (!patched.ok) throw await refused(`could not widen the push webhook on '${name}' to the appliance branch`, patched);
    console.log(`forge: the push webhook on '${name}' now delivers ${WEBHOOK_BRANCH_FILTER}`);
    return true;
  }

  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/hooks`, {
    type: "gitea",
    active: true,
    events: ["push"],
    branch_filter: WEBHOOK_BRANCH_FILTER,
    config: { url: cfg.webhookUrl, content_type: "json", secret: cfg.webhookSecret },
  });
  if (!created.ok) throw await refused(`could not register the push webhook on '${name}'`, created);
  console.log(`forge: '${name}' reports its pushes to ${cfg.webhookUrl}`);
  return true;
}

/**
 * Archive a repository, or take it out of the archive. Returns whether anything changed, so a
 * caller that already knows the current state costs one call and a caller that does not costs one
 * PATCH it did not need.
 *
 * ARCHIVING IS GITEA'S OWN READ-ONLY MARK, not a deletion and not a rename: every branch, tag,
 * issue and wiki page stays and stays readable, the repository is badged as archived in every
 * listing, and Gitea refuses writes to it -- pushes, issues, releases. The `appliance` branch, the
 * last thing the gateway reported, survives; the heartbeat table does not. Reversible by the same
 * call with `archived: false`, which is what restoring a gateway does.
 *
 * The wiki follows the repository, so there is nothing to archive separately.
 */
export async function setRepositoryArchived(
  cfg: ForgeConfig,
  name: string,
  archived: boolean,
  currently?: boolean,
): Promise<boolean> {
  if (currently === archived) return false;
  const patched = await forgeApi(cfg, "PATCH", `/repos/${FORGE_ORGANISATION}/${name}`, { archived });
  if (!patched.ok) {
    throw await refused(`could not ${archived ? "archive" : "un-archive"} '${name}'`, patched);
  }
  console.log(`forge: '${name}' is ${archived ? "archived, and read-only" : "out of the archive"}`);
  return true;
}

/** What enrolment tells the appliance about the platform repository, when this platform has one. */
export interface PlatformLink {
  ssh_url: string;
  tag: string;
}

/**
 * Provision the organisation, the repository, its protection and the key, and register the same
 * key read-only on the platform repository. Returns null on any failure, having logged it; the
 * platform half is null on its own when this deployment names no version.
 */
export async function provisionGatewayRepository(
  cfg: ForgeConfig,
  sparkplugId: string,
  gatewayName: string,
  publicKey: string,
): Promise<{ repository: ForgeRepository; platform: PlatformLink | null } | null> {
  const name = repositoryNameFor(sparkplugId);
  try {
    await ensureOrganisation(cfg);
    const repo = await ensureRepository(cfg, name, gatewayName);
    // OUT OF THE ARCHIVE BEFORE ANYTHING IS WRITTEN TO IT. Everything below is a write and Gitea
    // refuses writes to an archived repository. A gateway restored from the archive keeps a
    // read-only repository until forge-sweep's next pass (0114), and re-enrolling the appliance
    // is exactly what an operator does when the machine comes back -- so enrolment cannot be the
    // one path that finds the repository shut. An archived gateway never reaches here: archiving
    // burns its unredeemed tokens, so it has nothing to redeem.
    await setRepositoryArchived(cfg, name, false);
    // Out of its maker's hands before anything reads the repository or a key can write it: one made by
    // hand, or copied from another, arrives with an administrator, and can arrive with rules and a tag.
    const { kept } = await ensureHeldByTeams(cfg, name);
    if (kept.length) throw new Error(`the forge would not take '${name}' from ${kept.map((login) => `'${login}'`).join(", ")}`);
    const { found } = await ensureTagProtection(cfg, name);
    const left = found.filter((t) => !t.removed).map((t) => `'${t.tag}'`);
    if (left.length) throw new Error(`the forge would not remove the tag ${left.join(", ")} from '${name}'`);
    await ensureBranchProtection(cfg, name);
    // BEFORE THE KEY: a writable key on a repository whose other branches are still open would be
    // a key that can push anywhere for the moment between the two calls.
    await ensureApplianceProtection(cfg, name);
    await finishBranchRules(cfg, name);
    await ensureDefaultBranch(cfg, name, repo.default_branch);
    await ensureOnlyDeployKey(cfg, name, sparkplugId, publicKey);
    console.log(`forge: ${sparkplugId} pulls ${repo.full_name} over ${repo.ssh_url} and reports on '${APPLIANCE_BRANCH}'`);

    // The platform repository: the same key, read-only. Its content is the sweep's to publish;
    // enrolment only makes sure it exists to be cloned and that this appliance may clone it.
    let platform: PlatformLink | null = null;
    const version = platformVersion();
    if (version) {
      const platformRepo = await ensurePlatformRepository(cfg);
      await ensureDeployKey(cfg, { owner: PLATFORM_ORGANISATION, name: PLATFORM_REPOSITORY }, sparkplugId, publicKey, true);
      platform = { ssh_url: platformRepo.ssh_url, tag: platformTag(version) };
    } else {
      console.warn(`forge: ABER_PLATFORM_VERSION is unset, so ${sparkplugId} gets no platform repository to converge to`);
    }
    // After the key, and not on the path to `return null`: a wiki the forge could not seed costs a
    // log line, never the repository the appliance is about to clone.
    try {
      await ensureWikiHome(cfg, name, sparkplugId, gatewayName);
    } catch (err) {
      console.warn(`forge: the wiki of '${name}' was not seeded (${err instanceof Error ? err.message : err}); the repository is unaffected`);
    }
    // LIKEWISE the webhook: it is how the dashboard learns of a push before the appliance's next
    // tick, and a repository without it is a repository the dashboard learns about one tick late.
    try {
      await ensureWebhook(cfg, name);
    } catch (err) {
      console.warn(`forge: the push webhook on '${name}' was not registered (${err instanceof Error ? err.message : err}); the repository is unaffected`);
    }
    return { repository: { ...repo, default_branch: MAIN_BRANCH }, platform };
  } catch (err) {
    // LOUD, because nothing else will say so. The appliance sees `repository: null` and carries on
    // publishing telemetry; without this line the only symptom is a gateway that never converges.
    console.error(
      `forge provisioning FAILED for ${sparkplugId} ` +
        `(${err instanceof Error ? err.message : err}). The gateway is enrolled and its broker ` +
        "credential is live; it has no repository to pull from and will not converge until one exists.",
    );
    return null;
  }
}

/** How long to wait for the forge's asset. Short: enrolment is a person standing at an appliance. */
const HOST_KEY_TIMEOUT_MS = 5000;

/**
 * The `known_hosts` host specification for an SSH URL. OpenSSH matches a non-default port only as
 * `[host]:port` and port 22 only as a bare `host`. Gitea gives `ssh://git@host:2222/owner/repo.git`
 * when SSH_PORT is not 22 and the scp-like `git@host:owner/repo.git` when it is.
 */
export function knownHostsHost(sshUrl: string): string | null {
  const url = sshUrl.trim();

  const withScheme = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?(?:\/|$)/.exec(url);
  if (withScheme) {
    const host = withScheme[1];
    const port = withScheme[2];
    return port && port !== "22" ? `[${host}]:${port}` : host;
  }

  // Any other scheme is refused rather than parsed: the scp-like pattern below would accept
  // `https://forge/x.git` and yield the host `https`, which would be written into known_hosts as a
  // line that can never match.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;

  // scp-like: user@host:path. The colon here separates the PATH, never a port -- `git@host:2222/x`
  // means the directory `2222/x` to ssh, not a port, which is why this does not try to read one.
  const scpLike = /^(?:[^@/]+@)?([^/:]+):/.exec(url);
  if (scpLike) return scpLike[1];

  return null;
}

/**
 * Fetch the forge's published SSH host key and return the `known_hosts` line for this repository.
 * Null rather than throwing, and non-fatal like the rest of this file. Shape-checked through
 * `validPublicKey` before it is trusted, so an HTML error page or a truncated read is never written
 * into an appliance's known_hosts. The comment field is dropped: OpenSSH ignores it.
 */
export async function forgeKnownHosts(
  cfg: ForgeConfig,
  sshUrl: string,
): Promise<string | null> {
  const host = knownHostsHost(sshUrl);
  if (!host) {
    console.error(`could not read a host out of the forge's clone URL '${sshUrl}'`);
    return null;
  }

  try {
    const response = await fetch(`${cfg.baseUrl}/assets/ssh_host_key.pub`, {
      signal: AbortSignal.timeout(HOST_KEY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(
        `the forge published no SSH host key (${response.status} from /assets/ssh_host_key.pub). ` +
          "gitea-init.sh publishes it on boot; a forge that has never restarted since this was " +
          "added will not have one yet.",
      );
      return null;
    }

    const key = validPublicKey((await response.text()).trim());
    if (!key) {
      console.error(
        "the forge's /assets/ssh_host_key.pub did not contain an SSH public key. Refusing to hand " +
          "an appliance a known_hosts entry built from it.",
      );
      return null;
    }

    const [algorithm, material] = key.split(/\s+/);
    return `${host} ${algorithm} ${material}`;
  } catch (err) {
    console.error(
      `could not read the forge's SSH host key (${err instanceof Error ? err.message : err}). ` +
        "The gateway will enrol and publish telemetry; it will not converge until it has one.",
    );
    return null;
  }
}
