/**
 * The forge: the organisation that holds every gateway's repository, the two teams a person may
 * belong to in it, a gateway's own repository, and the key it reads that repository with.
 *
 * SHARED BECAUSE THE NAMES MUST AGREE. `enroll-gateway` creates `gateways/gateway-<sparkplug_id>`,
 * `forge-membership` places a login in a team of the same organisation, and the dashboard links to
 * the repository by the same path; three copies of that convention are three places for it to
 * drift, and the failure is a link to a repository that does not exist -- or, worse, a person placed
 * in a team of a different organisation. See _shared/roles.ts on why a sibling import is fine:
 * `servicePath` decides which directory is BOOTED, not what its module graph may import.
 *
 * WHY THIS LIVES BESIDE THE BROKER CREDENTIAL rather than in a later step somebody runs. Every appliance
 * holds a per-gateway READ-ONLY deploy key, and enrolment is the one moment when a
 * gateway is provably itself: it holds a single-use token bound to exactly one row. A key issued
 * later would need some other proof of identity, which is the fleet-wide credential store this
 * architecture exists to avoid.
 *
 * -------------------------------------------------------------------------------------------------
 * AN ORGANISATION, BECAUSE A REPOSITORY OWNED BY THE MACHINE ACCOUNT IS ONE NOBODY ELSE CAN SEE.
 *
 * The forge has a door now (the `forge` listener in supabase/envoy.yaml; 0094) and a person who
 * comes through it is auto-registered owning nothing. Every gateway repository used to be private
 * to the machine account, so the first login was a forge with no repositories in it. Gitea's own
 * permission model decides what a logged-in person may DO, and its unit of "these people may see
 * these repositories" is an organisation with teams -- so the machine account OWNS an organisation,
 * creates each gateway's repository in it, and `forge-membership` places each login in the team its
 * Postgres role maps to. The machine account is still not a site administrator: owning one
 * organisation is exactly the authority needed to create a repository in it, attach a key to it and
 * place a member in a team, and nothing more.
 *
 * TWO TEAMS, BOTH WRITE, AND THE DIFFERENCE IS BRANCH PROTECTION. `administrators` and `managers`
 * can both open a pull request and push a branch; `main` is protected on every gateway repository
 * with pushes disabled and one approval required from `administrators`. That is where
 * "approving is `gitops:manage`, Administrator only" is enforced INSIDE the forge: a manager may
 * open and review, and only an administrator's approval lets a merge through. The forge never
 * learns the name `gitops:manage`; it learns which team a verified role lands in.
 *
 * A LEGACY REPOSITORY IS TRANSFERRED, NOT RECREATED. Repositories created before the organisation
 * existed live under the machine account's own namespace, with history a re-flashed appliance is
 * entitled to get back. On re-enrolment `ensureRepository` finds one there and transfers it into
 * the organisation -- measured: the machine account owns both ends, so the transfer completes at
 * once with no acceptance step -- rather than creating an empty twin beside it.
 *
 * -------------------------------------------------------------------------------------------------
 * THE PRIVATE KEY IS NEVER SEEN HERE, AND THAT IS THE WHOLE SHAPE OF IT.
 *
 * The appliance generates its own keypair in bootstrap.mjs and sends the PUBLIC half up with its
 * enrolment request; this function registers that half against the repository. Nothing secret
 * travels toward the plant, nothing secret is stored here, and revoking one gateway is deleting one
 * key from one repository. It is the same decision as the editor password bootstrap generates and
 * prints once, one credential plane along.
 *
 * READ-ONLY, ALWAYS. A writable deploy key lets an appliance author the flow it will later be asked
 * to deploy, which empties the review step of its meaning -- an approved commit would no longer be
 * evidence that a person approved anything.
 *
 * -------------------------------------------------------------------------------------------------
 * FAILURE HERE IS NON-FATAL, DELIBERATELY, and it is the opposite decision from the credential
 * service's.
 *
 * By the time this runs the token is spent and the broker credential exists. Refusing the enrolment
 * would leave a working broker account no bundle can claim, to punish an appliance for a forge
 * outage it did not cause -- and telemetry, which is what a gateway is FOR, needs nothing from the
 * forge. So a failure is logged loudly, `repository` comes back null, and the appliance enrols
 * without one. What must never happen is silence: the response says so, and the log names the
 * gateway.
 */

export interface ForgeConfig {
  baseUrl: string;
  user: string;
  password: string;
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
 * The organisation every gateway repository lives in, and the two teams in it.
 *
 * NAMED HERE AND IN frontend/src/constants.js, and the two must agree: the dashboard builds the
 * link to a gateway's repository from its copy. Lower-case because it is a URL segment.
 */
export const FORGE_ORGANISATION = "gateways";
export const FORGE_TEAMS = {
  Administrator: "administrators",
  Shopfloor_Manager: "managers",
} as const;
export type ForgeTeamRole = keyof typeof FORGE_TEAMS;

/**
 * The forge's configuration, or null when this deployment has none.
 *
 * ALL THREE OR NOTHING. A half-configured forge is the case worth being loud about: it looks
 * enabled and answers 401 on every enrolment, so it is reported here rather than discovered one
 * appliance at a time.
 */
export function forgeConfig(): ForgeConfig | null {
  const baseUrl = (Deno.env.get("GITEA_INTERNAL_URL") ?? "").replace(/\/+$/, "");
  const user = Deno.env.get("GITEA_MACHINE_USER") ?? "";
  const password = Deno.env.get("GITEA_MACHINE_PASSWORD") ?? "";

  if (!baseUrl && !user && !password) return null;

  if (!baseUrl || !user || !password) {
    const missing = [
      !baseUrl && "GITEA_INTERNAL_URL",
      !user && "GITEA_MACHINE_USER",
      !password && "GITEA_MACHINE_PASSWORD",
    ].filter(Boolean).join(", ");
    console.error(
      `the forge is half-configured (${missing} unset), so gateway repositories are DISABLED. ` +
        "Set all three or none -- a partially configured forge answers 401 on every enrolment.",
    );
    return null;
  }

  // OPTIONAL, unlike the three above: a forge without a webhook is a forge the dashboard learns
  // about one tick late, not a forge that cannot be used. Both or neither, and enrolment logs
  // which.
  const webhookUrl = (Deno.env.get("GITEA_WEBHOOK_URL") ?? "").trim();
  const webhookSecret = Deno.env.get("GITEA_WEBHOOK_SECRET") ?? "";
  if (!!webhookUrl !== !!webhookSecret) {
    console.warn(
      `the forge's webhook is half-configured (${webhookUrl ? "GITEA_WEBHOOK_SECRET" : "GITEA_WEBHOOK_URL"} unset); ` +
        "no hook will be registered on gateway repositories until both are set",
    );
  }
  const webhook = webhookUrl && webhookSecret ? { webhookUrl, webhookSecret } : { webhookUrl: "", webhookSecret: "" };

  return { baseUrl, user, password, ...webhook };
}

/**
 * The repository name for a gateway.
 *
 * DERIVED, NOT STORED, and that is a decision worth stating: a stored pointer
 * would be a second copy of a derivable fact. Deriving the name from the `sparkplug_id` needs no
 * column and no migration, and it cannot disagree with the gateway it belongs to: that id is
 * generated by the database, and mosquitto.acl already matches the topic's edge-node segment
 * against it.
 */
export function repositoryNameFor(sparkplugId: string): string {
  return `gateway-${sparkplugId}`;
}

/**
 * The public half of an OpenSSH key, or null.
 *
 * SHAPE-CHECKED HERE so a malformed value never reaches the forge, and CONFINED to the two
 * algorithms bootstrap.mjs can generate. Forwarding whatever arrived would make this endpoint a way
 * to write arbitrary strings into another system's authorised-keys list.
 */
export function validPublicKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length > 4096) return null;
  return /^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [^\n\r]*)?$/.test(key) ? key : null;
}

/** Basic auth as the machine account. Gitea accepts it on the API, and it needs no token exchange. */
function authHeader(cfg: ForgeConfig): string {
  return `Basic ${btoa(`${cfg.user}:${cfg.password}`)}`;
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
 * The organisation, created if it is absent, and its two teams likewise. Returns the team ids by
 * role, which is what placing a member needs.
 *
 * IDEMPOTENT BY INSPECTION: a GET first, a POST only for what is missing. Both are the ordinary
 * state on every call after the first, and neither is reported as anything.
 *
 * PRIVATE, so that only members see the organisation exists -- the same reason every repository in
 * it is private. `includes_all_repositories` is what makes a team created once cover every
 * repository created later, so enrolment never has to touch a team.
 *
 * BOTH TEAMS MAY CREATE REPOSITORIES IN THE ORGANISATION. The first cut said no -- creating a
 * repository was enrolment's act and nobody else's -- and the first administrator to try it in the
 * UI found the "New repository" form refusing the organisation as an owner. The design has
 * repositories that exist BEFORE a gateway does (a playbook a class of gateway is provisioned
 * from), and those are made by people. What a hand-made repository does NOT get is what enrolment
 * applies to the one it names: branch protection on `main` and a deploy key. `ensureRepository`
 * below adopts a repository that already carries a gateway's name, so a hand-made one becomes a
 * gateway's on enrolment and is protected then.
 *
 * RECONCILED, NOT ONLY CREATED: a team found rather than made is patched if its flag disagrees, so
 * a forge whose teams predate this decision catches up on the next call, without anybody deleting
 * a team that has members in it.
 */
export async function ensureOrganisation(
  cfg: ForgeConfig,
): Promise<Record<ForgeTeamRole, number>> {
  const org = await forgeApi(cfg, "GET", `/orgs/${FORGE_ORGANISATION}`);
  if (org.status === 404) {
    const created = await forgeApi(cfg, "POST", "/orgs", {
      username: FORGE_ORGANISATION,
      full_name: "Gateways",
      description: "One repository per gateway. Managed by ACS-Cymru.",
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
      description: `${role.replace("_", " ")}s of the ACS-Cymru dashboard, placed here by forge-membership.`,
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
 * Create the gateway's repository in the organisation, or return the one that is already there --
 * transferring it in first if it was created before the organisation existed.
 *
 * `auto_init` MATTERS. An empty repository has no branch, and a deploy key against a repository with
 * no default branch gives the appliance nothing to clone -- git reports "remote HEAD refers to a
 * nonexistent ref", which reads as a broken key rather than as an empty repository.
 */
async function ensureRepository(
  cfg: ForgeConfig,
  name: string,
  gatewayName: string,
): Promise<ForgeRepository> {
  // THE ORGANISATION FIRST, then the machine account's own namespace, and only then create. The
  // order is the whole correctness of this: a repository name is unique per OWNER, so creating
  // in the organisation while `acs_platform/<name>` still exists does not conflict -- it quietly
  // makes an empty twin, and the appliance's history stays stranded where no login can see it.
  // Found by the suite, which planted a legacy repository and got a copy back.
  const existing = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}`);
  if (existing.ok) return await existing.json() as ForgeRepository;
  if (existing.status !== 404) {
    throw await refused(`could not read repository '${name}'`, existing);
  }

  const legacy = await forgeApi(cfg, "GET", `/repos/${cfg.user}/${name}`);
  if (legacy.ok) {
    const transferred = await forgeApi(cfg, "POST", `/repos/${cfg.user}/${name}/transfer`, {
      new_owner: FORGE_ORGANISATION,
    });
    if (!transferred.ok) {
      throw await refused(`could not transfer '${cfg.user}/${name}' into '${FORGE_ORGANISATION}'`, transferred);
    }
    console.log(`forge: transferred '${cfg.user}/${name}' into '${FORGE_ORGANISATION}'`);
    return await transferred.json() as ForgeRepository;
  }
  if (legacy.status !== 404) {
    throw await refused(`could not read '${cfg.user}/${name}'`, legacy);
  }

  const created = await forgeApi(cfg, "POST", `/orgs/${FORGE_ORGANISATION}/repos`, {
    name,
    description: `Node-RED flow for gateway '${gatewayName}'. Managed by ACS-Cymru.`,
    // Belt and braces: the forge sets FORCE_PRIVATE, so a public repository cannot be created
    // here even by mistake. Asking for private anyway means the intent is in the request rather
    // than only in the server's configuration.
    private: true,
    auto_init: true,
    default_branch: "main",
  });
  if (created.ok) return await created.json() as ForgeRepository;

  // 409 HERE IS A RACE -- two enrolments of one gateway in the same instant -- and the loser reads
  // what the winner made. A repository outliving its appliance is the point rather than an
  // accident: a gateway re-flashed after a failed SD card gets its flow history back.
  if (created.status === 409) {
    const raced = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}`);
    if (raced.ok) return await raced.json() as ForgeRepository;
  }
  throw await refused(`could not create repository '${name}'`, created);
}

const INCIDENT_LABEL = "incident";
const INCIDENT_TEMPLATE_PATH = ".gitea/ISSUE_TEMPLATE/incident.md";

/**
 * An issue template and its label, committed to `main` in the one moment the machine account still
 * may: before the branch is protected.
 *
 * ISSUES ARE THE GATEWAY'S INCIDENT LOG, and a template is what turns a tracker that is on by
 * default into one somebody uses: the questions an incident on a plant floor needs answered are the
 * same every time, and the one that matters most -- what the appliance was running when it happened
 * -- is the one people forget to write down. The template lives in `.gitea/ISSUE_TEMPLATE/`, which
 * the appliance clones along with everything else and flow-sync.mjs never reads: it reads
 * `flows.json` and nothing else.
 *
 * ONLY BEFORE PROTECTION. `enable_push: false` binds the machine account too -- measured: the
 * contents API answers 403 once `main` is protected -- so a repository from before this cannot be
 * given a template by enrolment, and is not. An administrator can add one there by pull request,
 * which is the right path for a change to a repository that already has a history.
 *
 * Idempotent on the file and on the label, because a legacy repository transferred in may carry
 * either already.
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

  const present = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}/contents/${INCIDENT_TEMPLATE_PATH}`);
  if (present.ok) return;
  if (present.status !== 404) throw await refused(`could not read '${INCIDENT_TEMPLATE_PATH}' on '${name}'`, present);

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
 * Protect `main`: no direct pushes, one approval from `administrators` before a merge.
 *
 * THIS IS THE REVIEW GATE, and it is worth being exact about what each field buys. `enable_push:
 * false` is what makes "deploy only what is committed" mean "deploy only what was REVIEWED": the
 * appliance converges to `main`, so a branch anyone with write could push to is a branch anyone
 * with write could deploy from. Merging is a different act from pushing in Gitea and stays allowed
 * to anyone with write once the approvals are met -- so a manager can merge, after an administrator
 * has approved. `dismiss_stale_approvals` means a change pushed after the approval needs approving
 * again, which is the difference between reviewing a diff and reviewing a branch name. A force-push
 * is refused by `enable_push: false` too, which is the forge's half of flow-sync.mjs's refusal to
 * follow a rewritten history.
 *
 * Applied once: a protection that already exists is left exactly as an administrator may have
 * tuned it, rather than reset to this file's idea on every re-enrolment.
 */
async function ensureBranchProtection(cfg: ForgeConfig, name: string): Promise<void> {
  const existing = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}/branch_protections/main`);
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw await refused(`could not read the branch protection on '${name}'`, existing);
  }
  // THE LAST MOMENT ANYTHING CAN BE COMMITTED TO `main` DIRECTLY. The protection below binds the
  // machine account too, so what the repository is to carry from the start goes in here, first.
  await seedIssueTemplate(cfg, name);
  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/branch_protections`, {
    branch_name: "main",
    enable_push: false,
    enable_approvals_whitelist: true,
    approvals_whitelist_teams: [FORGE_TEAMS.Administrator],
    required_approvals: 1,
    block_on_rejected_reviews: true,
    dismiss_stale_approvals: true,
  });
  if (!created.ok) throw await refused(`could not protect 'main' on '${name}'`, created);
}

/**
 * Attach the appliance's public key to its repository, read-only.
 *
 * TITLED BY sparkplug_id, so a human reading a repository's key list can tell which appliance holds
 * it and revocation has an obvious target.
 */
async function ensureDeployKey(
  cfg: ForgeConfig,
  repo: string,
  sparkplugId: string,
  publicKey: string,
): Promise<void> {
  const response = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${repo}/keys`, {
    title: `gateway ${sparkplugId}`,
    key: publicKey,
    // NEVER false. See the header: a writable key lets an appliance author what it will later be
    // asked to deploy.
    read_only: true,
  });

  if (response.ok) return;

  // 422 is "this key is already registered", which is what re-enrolling an appliance that kept its
  // /data volume looks like. That is a success: the key it holds is the key the repository trusts.
  if (response.status === 422) {
    console.log(`deploy key for ${sparkplugId} was already registered on '${repo}'`);
    return;
  }

  throw await refused(`could not register the deploy key on '${repo}'`, response);
}

/**
 * Seed the wiki's Home page, once.
 *
 * THE WIKI IS THE UNREVIEWED HALF OF THE REPOSITORY, AND THAT IS WHAT IT IS FOR. It is a second git
 * repository beside the first (`<name>.wiki.git`), edited in place by anyone in either team, with no
 * branch protection and no pull request -- the right shape for what a person needs to know about a
 * gateway and the appliance never reads: where it is, what it is wired to, who to call, what changed
 * and why. It is the wrong shape for anything the appliance deploys, and the page says so, because
 * the first person to find a wiki tab beside a `flows.json` will wonder which one counts.
 *
 * SEEDED ONCE. A Home page that exists is left exactly as people have edited it; Gitea would answer
 * 400 to a second creation, and this never asks. A wiki with no page at all greets its first visitor
 * with "create the first page", which is an empty room where the gateway's name should be.
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
 * Register the push webhook on the repository, once.
 *
 * ONE HOOK PER REPOSITORY RATHER THAN ONE ON THE ORGANISATION, because only a gateway's repository
 * has a gateway row to record on: a hand-made playbook repository in the organisation would deliver
 * pushes forge-events can only ignore. Registered at enrolment beside the deploy key, found again by
 * URL on re-enrolment. The secret is the one forge-events verifies with, so a delivery is proof it
 * came from a hook enrolment made and not from anything else that can reach the edge runtime.
 *
 * `branch_filter: main` is Gitea's own filter, so pushes to a proposal branch are not delivered at
 * all rather than delivered and ignored.
 */
async function ensureWebhook(cfg: ForgeConfig, name: string): Promise<void> {
  if (!cfg.webhookUrl) {
    console.log(`forge: no webhook configured, so '${name}' will not report its pushes`);
    return;
  }
  const listed = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${name}/hooks`);
  if (!listed.ok) throw await refused(`could not list the hooks on '${name}'`, listed);
  const hooks = await listed.json() as { id: number; config?: { url?: string } }[];
  if (hooks.some((h) => h.config?.url === cfg.webhookUrl)) return;

  const created = await forgeApi(cfg, "POST", `/repos/${FORGE_ORGANISATION}/${name}/hooks`, {
    type: "gitea",
    active: true,
    events: ["push"],
    branch_filter: "main",
    config: { url: cfg.webhookUrl, content_type: "json", secret: cfg.webhookSecret },
  });
  if (!created.ok) throw await refused(`could not register the push webhook on '${name}'`, created);
  console.log(`forge: '${name}' reports its pushes to ${cfg.webhookUrl}`);
}

/** Provision the organisation, the repository, its protection and the key. Returns null on any failure, having logged it. */
export async function provisionGatewayRepository(
  cfg: ForgeConfig,
  sparkplugId: string,
  gatewayName: string,
  publicKey: string,
): Promise<ForgeRepository | null> {
  const name = repositoryNameFor(sparkplugId);
  try {
    await ensureOrganisation(cfg);
    const repo = await ensureRepository(cfg, name, gatewayName);
    await ensureBranchProtection(cfg, name);
    await ensureDeployKey(cfg, name, sparkplugId, publicKey);
    console.log(`forge: ${sparkplugId} reads ${repo.full_name} over ${repo.ssh_url}`);
    // AFTER THE KEY, AND NOT ON THE PATH TO `return null`: the wiki is for people and is no part of
    // the appliance's contract, so a wiki the forge could not seed costs a log line, never the
    // repository the appliance is about to be told to clone.
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
    return repo;
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
 * The `known_hosts` host specification for an SSH URL.
 *
 * THE BRACKET FORM IS NOT COSMETIC. OpenSSH writes a non-default port as `[host]:port` and matches
 * on exactly that string; a bare `host` line is simply not consulted for a connection to port 2222,
 * and the appliance is then told the host is unknown while holding a file that names it. Port 22 is
 * the opposite case -- it must be bare, because that is what OpenSSH looks up.
 *
 * Gitea gives `ssh://git@host:2222/owner/repo.git` when SSH_PORT is not 22 and the scp-like
 * `git@host:owner/repo.git` when it is, so both spellings arrive here and neither is a fault.
 */
export function knownHostsHost(sshUrl: string): string | null {
  const url = sshUrl.trim();

  const withScheme = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?(?:\/|$)/.exec(url);
  if (withScheme) {
    const host = withScheme[1];
    const port = withScheme[2];
    return port && port !== "22" ? `[${host}]:${port}` : host;
  }

  // ANY OTHER SCHEME IS REFUSED RATHER THAN PARSED, and this branch exists because the scp-like
  // pattern below silently accepts one: `https://forge/x.git` matches it and yields the "host"
  // `https`, which would be written into an appliance's known_hosts as a line that can never match.
  // The appliance would then fail verification against a file that names the forge, which is the
  // most confusing failure this whole path could produce. Caught by test rather than by reading.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;

  // scp-like: user@host:path. The colon here separates the PATH, never a port -- `git@host:2222/x`
  // means the directory `2222/x` to ssh, not a port, which is why this does not try to read one.
  const scpLike = /^(?:[^@/]+@)?([^/:]+):/.exec(url);
  if (scpLike) return scpLike[1];

  return null;
}

/**
 * Fetch the forge's published SSH host key and return the `known_hosts` line for this repository.
 *
 * NULL RATHER THAN THROWING, and non-fatal for the same reason the rest of this file is: by the time
 * enrolment reaches here the token is spent and the broker credential is live. An appliance that
 * gets no host key still publishes telemetry, which is what a gateway is FOR -- it simply declines
 * to converge, which is the correct refusal rather than a degraded one.
 *
 * SHAPE-CHECKED BEFORE IT IS TRUSTED. `validPublicKey` is the same gate the appliance's own key
 * passes through, and it is what stops an HTML error page, a login redirect or a truncated read
 * being written into an appliance's known_hosts as though it were a key. The comment field is
 * dropped: OpenSSH ignores it and it carries the forge container's hostname, which is noise on an
 * appliance and one more thing that changes for no reason.
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
