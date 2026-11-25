import {
  ensureApplianceProtection,
  ensureBranchProtection,
  ensureDefaultBranch,
  ensureHeldByTeams,
  ensureProposals,
  findRepository,
  finishBranchRules,
  forgeApi,
  type ForgeConfig,
  listDeployKeys,
  refuseMirror,
} from "./forge.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
function equal(actual: unknown, expected: unknown, what = "") {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${what ? `${what}: ` : ""}expected ${e}, got ${a}`);
}

const CFG: ForgeConfig = {
  baseUrl: "http://forge.invalid",
  user: "aber_platform",
  token: "not-a-real-key",
  webhookUrl: "",
  webhookSecret: "",
};
const REPO = "gateway-gwy000000000000000000001";

// deno-lint-ignore no-explicit-any -- a rule as Gitea answers one, of which each test sets a few fields
type Rule = any;

interface Forge {
  rules: Rule[];
  holders: string[];
  /** Holders the forge answers 500 to removing. */
  stuck: string[];
  defaultBranch: string;
  keys: { id: number; title: string; key: string; read_only: boolean }[];
  pulls: { number: number; base: { ref: string }; reviews: { id: number; state: string; official: boolean; dismissed: boolean }[] }[];
  /** Files the machine account committed, with who could push to `main` when it did. */
  committed: { path: string; pushers: string[] }[];
  calls: string[];
  /** Every set of pushers `main` has had, in order. */
  pushers: string[][];
  /** Dismissals the forge answers 500 to before it answers one. */
  failing: number;
  /** What the repository is called now. */
  name: string;
  /** Whether the repository takes proposals: the forge answers 404 for them when it does not. */
  proposals: boolean;
}

const forge = (over: Partial<Forge> = {}): Forge => ({
  rules: [],
  holders: [],
  stuck: [],
  defaultBranch: "main",
  keys: [],
  pulls: [],
  committed: [],
  calls: [],
  pushers: [],
  failing: 0,
  name: REPO,
  proposals: true,
  ...over,
});

/** A rule as Gitea makes one. */
const rule = (name: string, over: Rule = {}): Rule => ({
  rule_name: name,
  priority: 1,
  enable_push: false,
  enable_push_whitelist: false,
  push_whitelist_usernames: [],
  push_whitelist_teams: [],
  push_whitelist_deploy_keys: false,
  enable_force_push: false,
  required_approvals: 0,
  enable_approvals_whitelist: false,
  approvals_whitelist_username: [],
  approvals_whitelist_teams: [],
  enable_bypass_allowlist: false,
  dismiss_stale_approvals: false,
  enable_status_check: false,
  status_check_contexts: [],
  unprotected_file_patterns: "",
  ...over,
});
const closed = (name: string, over: Rule = {}): Rule =>
  rule(name, {
    required_approvals: 1,
    enable_approvals_whitelist: true,
    approvals_whitelist_teams: ["administrators"],
    dismiss_stale_approvals: true,
    enable_status_check: true,
    status_check_contexts: ["aber/flow-shape"],
    ...over,
  });
const appliance = (over: Rule = {}) =>
  rule("appliance", { priority: 2, enable_push: true, enable_push_whitelist: true, push_whitelist_deploy_keys: true, ...over });
const catchAll = (over: Rule = {}) =>
  rule("**", {
    priority: 1000,
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_teams: ["administrators", "managers"],
    ...over,
  });

/** Whether a rule matches `main`, as Gitea matches one: a plain name without case, `**` and `mai?` as globs. */
const onMain = (name: string) => name.toLowerCase() === "main" || ["**", "*", "mai?"].includes(name);

/** Who could push to `main` under the rules as they are: the first match by priority decides. */
function pushersOf(rules: Rule[]): string[] {
  const order = [...rules].sort((a, b) => a.priority - b.priority || Number(/[*?]/.test(a.rule_name)) - Number(/[*?]/.test(b.rule_name)));
  const first = order.find((r) => onMain(r.rule_name));
  if (!first) return ["anyone"];
  const open = [];
  if (first.unprotected_file_patterns) open.push("anyone");
  if (first.enable_push && !first.enable_push_whitelist) open.push("anyone");
  if (first.enable_push && first.enable_push_whitelist) {
    open.push(...first.push_whitelist_usernames, ...first.push_whitelist_teams);
    if (first.push_whitelist_deploy_keys) open.push("the key");
  }
  return open;
}

/** The calls these functions make, answered as Gitea answers them behind the gateway's forge-api listener. */
async function withForge<T>(state: Forge, body: () => Promise<T>): Promise<T> {
  const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
  const nothing = () => Promise.resolve(new Response(null, { status: 204 }));
  const saved = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const asked = new URL(url).pathname;
    // The listener refuses an escaped slash or backslash, and merges slashes.
    if (/%2f|%5c/i.test(asked)) return json({}, 400);
    const [, of, rest] = /^\/api\/v1\/repos\/gateways\/([^/]+)(.*)$/.exec(asked.replace(/\/+/g, "/"))!;
    const path = decodeURIComponent(rest);
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    const sent = init.body ? JSON.parse(init.body as string) : {};
    const done = (response: Promise<Response>) => {
      if (init.method !== "GET") {
        state.calls.push(`${init.method} ${path}`);
        state.pushers.push(pushersOf(state.rules));
      }
      return response;
    };
    const paged = <I>(items: I[]) => json(items.slice((Number(query.get("page") ?? 1) - 1) * 50, Number(query.get("page") ?? 1) * 50));

    if (path === "" && init.method === "GET") {
      // Found by the name it had before, which is REPO.
      const found = of === REPO || of === state.name;
      return found ? json({ id: 1, name: state.name, full_name: `gateways/${state.name}` }) : json({}, 404);
    }
    if (path === "" && init.method === "PATCH") {
      state.name = sent.name ?? state.name;
      state.defaultBranch = sent.default_branch ?? state.defaultBranch;
      state.proposals = sent.has_pull_requests ?? state.proposals;
      return done(json({ id: 1, name: state.name, full_name: `gateways/${state.name}`, default_branch: state.defaultBranch }));
    }
    if (path === "/collaborators") return done(paged(state.holders.map((login) => ({ login }))));
    if (path.startsWith("/collaborators/")) {
      const login = path.split("/")[2];
      if (state.stuck.includes(login)) return done(json({}, 500));
      state.holders = state.holders.filter((h) => h !== login);
      return done(nothing());
    }
    if (path === "/keys") return done(paged(state.keys));
    if (path.startsWith("/keys/")) {
      state.keys = state.keys.filter((k) => `/keys/${k.id}` !== path);
      return done(nothing());
    }
    if (path === "/branch_protections" && init.method === "GET") return done(json(state.rules));
    if (path === "/branch_protections") {
      const { branch_name, ...fields } = sent;
      state.rules.push(rule(branch_name, fields));
      return done(json({}, 201));
    }
    if (path.startsWith("/branch_protections/")) {
      const name = path.slice("/branch_protections/".length);
      const found = state.rules.find((r) => r.rule_name === name);
      if (!found) return done(json({}, 404));
      if (init.method === "GET") return done(json(found));
      if (init.method === "DELETE") state.rules = state.rules.filter((r) => r !== found);
      else {
        state.rules = state.rules.map((r) =>
          r !== found ? r : {
            ...r,
            ...sent,
            // As Gitea: closing a rule to pushes turns its list and its keys off with it.
            ...(sent.enable_push === false ? { enable_push_whitelist: false, push_whitelist_deploy_keys: false } : {}),
          }
        );
      }
      return done(json({}));
    }
    if (path.startsWith("/pulls") && !state.proposals) return json({}, 404);
    if (path === "/pulls") return done(paged(state.pulls));
    const review = /^\/pulls\/(\d+)\/reviews(?:\/(\d+)\/dismissals)?$/.exec(path);
    if (review) {
      const reviews = state.pulls.find((p) => p.number === Number(review[1]))!.reviews;
      if (!review[2]) return done(paged(reviews));
      if (state.failing > 0) {
        state.failing -= 1;
        return done(json({}, 500));
      }
      reviews.find((r) => r.id === Number(review[2]))!.dismissed = true;
      return done(json({}));
    }
    // No branch to read, so everything a new repository carries is committed.
    if (path === "/branches/main") return done(json({}, 404));
    if (path === "/labels") return done(json({}, 201));
    if (path.startsWith("/contents/") && init.method === "POST") {
      state.committed.push({ path: path.slice("/contents/".length), pushers: pushersOf(state.rules) });
      return done(json({}, 201));
    }
    throw new Error(`an unexpected call: ${init.method} ${path}`);
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = saved;
  }
}

/** The branch rules as enrolment and a pass put them right. */
async function putRight(state: Forge): Promise<boolean[]> {
  return await withForge(state, async () => [
    await ensureBranchProtection(CFG, REPO),
    await ensureApplianceProtection(CFG, REPO),
    await finishBranchRules(CFG, REPO),
  ]);
}

Deno.test("a new repository is seeded under its own rule, which only the machine account passes, and closed", async () => {
  const state = forge();
  equal(await putRight(state), [true, true, true]);
  equal(state.rules.map((r) => r.rule_name), ["main", "appliance", "**"]);
  equal(state.committed.map((c) => c.pushers), [["aber_platform"]], "who could push while it was seeded");
  equal(state.pushers.filter((p) => p.join() !== "aber_platform" && p.length > 0), [], "main was open to somebody else");
  equal(pushersOf(state.rules), []);
  const [main] = state.rules;
  equal([main.required_approvals, main.approvals_whitelist_teams, main.dismiss_stale_approvals], [1, ["administrators"], true]);
  equal(await putRight(state), [false, false, false], "a second pass");
});

Deno.test("a pass that died before the repository was seeded is finished by the next", async () => {
  const state = forge({
    rules: [closed("main", { enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ["Aber_Platform"] }), appliance(), catchAll()],
  });
  equal(await putRight(state), [false, false, true]);
  equal(state.committed.length, 1);
  equal(pushersOf(state.rules), []);
});

Deno.test("a main open to the machine account and somebody else is closed, and nothing is committed", async () => {
  for (const also of [{ push_whitelist_teams: ["managers"] }, { push_whitelist_usernames: ["aber_platform", "maker"] }, { push_whitelist_deploy_keys: true }]) {
    const state = forge({
      rules: [closed("main", { enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ["aber_platform"], ...also }), appliance(), catchAll()],
    });
    equal((await putRight(state))[0], true);
    equal(state.committed, []);
    equal(pushersOf(state.rules), []);
  }
});

Deno.test("each way past the approval that a found rule leaves is put back", async () => {
  const ways: [string, Rule][] = [
    ["no approval", { required_approvals: 0 }],
    ["an approval from anyone", { enable_approvals_whitelist: false }],
    ["an approval from a manager", { approvals_whitelist_teams: ["administrators", "managers"] }],
    ["an approval from a person", { approvals_whitelist_username: ["maker"] }],
    ["an approval from nobody but a person", { approvals_whitelist_teams: [], approvals_whitelist_username: ["maker"] }],
    ["a stale approval", { dismiss_stale_approvals: false }],
    ["a bypass", { enable_bypass_allowlist: true }],
    ["files anyone may push", { unprotected_file_patterns: "**" }],
    ["a push", { enable_push: true }],
    ["a key's push", { enable_push: true, enable_push_whitelist: true, push_whitelist_deploy_keys: true }],
    ["behind the catch-all", { priority: 1000 }],
    ["no shape check", { status_check_contexts: ["site/extra"] }],
  ];
  for (const [what, over] of ways) {
    const state = forge({ rules: [closed("main", over), appliance(), catchAll()] });
    equal((await putRight(state))[0], true, what);
    const main = state.rules.find((r) => r.rule_name === "main");
    equal(
      [main.required_approvals >= 1, main.enable_approvals_whitelist, main.approvals_whitelist_teams, main.approvals_whitelist_username,
        main.dismiss_stale_approvals, main.enable_bypass_allowlist, main.unprotected_file_patterns, main.enable_push, main.priority < 1000,
        main.status_check_contexts.includes("aber/flow-shape")],
      [true, true, ["administrators"], [], true, false, "", false, true, true],
      what,
    );
    equal(pushersOf(state.rules), [], what);
    equal((await putRight(state)).some(Boolean), false, `${what}, a second pass`);
  }
});

Deno.test("what only tightens main is kept", async () => {
  const tuned = closed("main", {
    required_approvals: 2,
    status_check_contexts: ["site/extra", "aber/flow-shape"],
    block_on_outdated_branch: true,
    enable_merge_whitelist: true,
    merge_whitelist_teams: ["administrators"],
    protected_file_patterns: "custom.yml",
    priority: 7,
  });
  const state = forge({ rules: [{ ...tuned }, appliance(), catchAll()] });
  equal(await putRight(state), [false, false, false]);
  equal(state.rules[0], tuned);
  equal(state.calls, []);

  // And kept beside what is put back.
  const looser = forge({ rules: [{ ...tuned, unprotected_file_patterns: "**", dismiss_stale_approvals: false }, appliance(), catchAll()] });
  equal((await putRight(looser))[0], true);
  const main = looser.rules[0];
  equal([main.required_approvals, main.status_check_contexts, main.protected_file_patterns], [2, ["site/extra", "aber/flow-shape"], "custom.yml"]);
});

Deno.test("an approval given under a looser rule is dismissed, on a proposal for main alone", async () => {
  const review = (id: number, over = {}) => ({ id, state: "APPROVED", official: true, dismissed: false, ...over });
  const pulls = () => [
    { number: 1, base: { ref: "main" }, reviews: [review(1), review(2, { state: "COMMENT" }), review(3, { official: false })] },
    { number: 2, base: { ref: "other" }, reviews: [review(4)] },
  ];
  const state = forge({ rules: [closed("main", { enable_approvals_whitelist: false }), appliance(), catchAll()], pulls: pulls() });
  await putRight(state);
  equal(state.pulls.flatMap((p) => p.reviews.filter((r) => r.dismissed).map((r) => r.id)), [1]);

  // One the forge would not dismiss is asked for again by the next pass, under a rule already put back.
  const stuck = forge({ rules: [closed("main", { required_approvals: 0 }), appliance(), catchAll()], pulls: pulls(), failing: 1 });
  let threw = false;
  await putRight(stuck).catch(() => threw = true);
  equal([threw, stuck.rules[0].required_approvals, stuck.rules[0].dismiss_stale_approvals], [true, 1, false]);
  equal((await putRight(stuck))[0], true);
  equal([stuck.pulls[0].reviews[0].dismissed, stuck.rules[0].dismiss_stale_approvals], [true, true]);

  // And one given before the rule was there at all.
  const ruleless = forge({ rules: [appliance(), catchAll()], pulls: pulls() });
  await putRight(ruleless);
  equal(ruleless.pulls.flatMap((p) => p.reviews.filter((r) => r.dismissed).map((r) => r.id)), [1]);

  // A push put back says nothing about an approval.
  const other = forge({ rules: [closed("main", { enable_push: true }), appliance(), catchAll()], pulls: pulls() });
  await putRight(other);
  equal(other.pulls.flatMap((p) => p.reviews.filter((r) => r.dismissed)), []);
});

Deno.test("a rule that could be the rule on main is removed, and main is never without its own", async () => {
  const state = forge({
    rules: [
      rule("mai?", { priority: 0, enable_push: true }),
      rule("MAIN", { priority: 0, enable_push: true }),
      closed("release/*"),
      closed("MAIN2"),
      closed("trunk", { priority: 1 }),
      closed("main", { priority: 5 }),
      appliance(),
      catchAll(),
    ],
  });
  equal(pushersOf(state.rules), ["anyone"]);
  equal((await putRight(state))[2], true);
  // One on a single other branch that asks what main's asks loosens nothing, and stays.
  equal(state.rules.map((r) => r.rule_name), ["MAIN2", "trunk", "main", "appliance", "**"]);
  equal(pushersOf(state.rules), []);
  equal(state.calls.filter((c) => c === "DELETE /branch_protections/main"), []);
});

Deno.test("the catch-all and appliance are put behind and ahead of one another, and keep no unprotected file", async () => {
  const state = forge({
    rules: [closed("main", { priority: 2000 }), appliance({ priority: 3000, unprotected_file_patterns: "**" }), catchAll({ priority: 1, unprotected_file_patterns: "x" })],
  });
  equal(pushersOf(state.rules), ["anyone", "administrators", "managers"]);
  equal(await putRight(state), [true, true, false]);
  equal(pushersOf(state.rules), []);
  equal(state.rules.map((r) => [r.rule_name, r.priority < 1000, r.unprotected_file_patterns]), [["main", true, ""], ["appliance", true, ""], ["**", false, ""]]);
});

Deno.test("a playbook that is not a gateway's is protected closed, seeded with nothing, and its tuned rule stays", async () => {
  const state = forge();
  equal(await withForge(state, () => ensureBranchProtection(CFG, REPO, { gateway: false })), true);
  equal([pushersOf(state.rules), state.committed], [[], []]);
  const tuned = forge({ rules: [closed("main", { required_approvals: 0, unprotected_file_patterns: "*.md" })] });
  equal(await withForge(tuned, () => ensureBranchProtection(CFG, REPO, { gateway: false })), false);
});

Deno.test("everybody who holds a repository by name is removed, past the first page, and one the forge keeps is said", async () => {
  const holders = Array.from({ length: 60 }, (_, i) => `maker-${i}`);
  const state = forge({ holders, stuck: ["maker-55"] });
  const { removed, kept } = await withForge(state, () => ensureHeldByTeams(CFG, REPO));
  equal([removed.length, kept, state.holders], [59, ["maker-55"], ["maker-55"]]);
  equal(await withForge(forge(), () => ensureHeldByTeams(CFG, REPO)), { removed: [], kept: [] });
});

Deno.test("a default branch that was moved is given main's rule before main is the default again", async () => {
  const review = { id: 9, state: "APPROVED", official: true, dismissed: false };
  const state = forge({
    rules: [closed("main"), appliance(), catchAll()],
    defaultBranch: "trunk",
    pulls: [{ number: 3, base: { ref: "trunk" }, reviews: [review] }],
  });
  equal(await withForge(state, () => ensureDefaultBranch(CFG, REPO, "trunk")), true);
  equal(state.defaultBranch, "main");
  const trunk = state.rules.find((r) => r.rule_name === "trunk");
  equal([trunk.enable_push, trunk.required_approvals, trunk.approvals_whitelist_teams], [false, 1, ["administrators"]]);
  equal(state.calls.indexOf("POST /branch_protections") < state.calls.indexOf("PATCH "), true);
  equal(review.dismissed, true);
  equal((await putRight(state)).some(Boolean), false, "the rule on trunk stays");

  // One already there is replaced, whatever it asked.
  const held = forge({ rules: [closed("main"), rule("trunk", { enable_push: true }), appliance(), catchAll()], defaultBranch: "trunk" });
  await withForge(held, () => ensureDefaultBranch(CFG, REPO, "trunk"));
  equal(held.rules.find((r) => r.rule_name === "trunk").enable_push, false);
  for (const current of ["main", undefined]) equal(await withForge(forge(), () => ensureDefaultBranch(CFG, REPO, current)), false);
});

Deno.test("a default branch that no rule can close costs the old key", async () => {
  for (const current of ["appliance", "Main", "a{b}"]) {
    const state = forge({ defaultBranch: current, keys: [{ id: 1, title: "gateway x", key: "ssh-ed25519 A", read_only: false }] });
    equal(await withForge(state, () => ensureDefaultBranch(CFG, REPO, current)), true, current);
    equal([state.keys, state.rules, state.defaultBranch], [[], [], "main"], current);
  }
});

Deno.test("a rule is removed by its name, a slash and all", async () => {
  for (const name of ["{main,x/y}", "feature/**", "{main,é}", "{main,?a=b#c}", "m%61in", "{main,.}", "{main,x/}"]) {
    const state = forge({ rules: [rule(name, { enable_push: true, priority: -5 }), closed("main"), appliance(), catchAll()], keys: [{ id: 1, title: "gateway x", key: "ssh-ed25519 A", read_only: false }] });
    equal(await putRight(state), [false, false, true], name);
    equal([state.rules.map((r) => r.rule_name), state.keys.length], [["main", "appliance", "**"], 1], name);
  }
});

Deno.test("a rule whose name no path carries costs the keys, and names no other call", async () => {
  for (const name of ["..", ".", "../..", "x/../main", "{main,a//b}", "main/", "/main", "ma\\x69n", "{main,x/./y}"]) {
    const state = forge({ rules: [rule(name, { enable_push: true, priority: -5 }), closed("main"), appliance(), catchAll()], keys: [{ id: 1, title: "gateway x", key: "ssh-ed25519 A", read_only: false }] });
    let said = "";
    await putRight(state).catch((err) => said = err.message);
    equal(said.includes(JSON.stringify(name)) && said.includes("deploy keys are removed"), true, name);
    equal([state.calls, state.keys, state.rules.length], [["DELETE /keys/1"], [], 4], name);
  }
});

Deno.test("a path with a dot segment is never asked of the forge", async () => {
  for (const path of ["/repos/gateways/x/branch_protections/..", "/repos/gateways/./x", "/repos/gateways/x/../y?a=b"]) {
    const refused = await withForge(forge(), () => forgeApi(CFG, "DELETE", path)).then(() => false, () => true);
    equal(refused, true, path);
  }
  const state = forge();
  equal((await withForge(state, () => forgeApi(CFG, "GET", `/repos/gateways/${REPO}/keys?title=../x`))).ok, true, "a query is not a path");
});

Deno.test("proposals are on before an approval on one is dismissed", async () => {
  const review = { id: 9, state: "APPROVED", official: true, dismissed: false };
  const state = forge({
    rules: [rule("*", { enable_push: true, priority: -5 }), closed("main", { required_approvals: 0 }), appliance(), catchAll()],
    pulls: [{ number: 3, base: { ref: "main" }, reviews: [review] }],
    proposals: false,
  });
  equal(await withForge(state, () => ensureProposals(CFG, REPO, false)), true);
  equal(await putRight(state), [true, false, true]);
  equal([review.dismissed, pushersOf(state.rules)], [true, []]);
  for (const on of [true, undefined]) equal(await withForge(forge(), () => ensureProposals(CFG, REPO, on)), false);
});

Deno.test("a mirror is refused, and costs the keys", async () => {
  const state = forge({ keys: [{ id: 1, title: "gateway x", key: "ssh-ed25519 A", read_only: false }] });
  for (const mirror of [false, undefined]) await withForge(state, () => refuseMirror(CFG, REPO, mirror));
  equal(state.calls, []);
  const said = await withForge(state, () => refuseMirror(CFG, REPO, true)).then(() => "", (err) => err.message);
  equal([said.includes("is a mirror"), state.keys], [true, []]);
});

Deno.test("a repository is known by its own name alone, and one that was renamed has it back", async () => {
  const state = forge({ name: "line-three" });
  const found = await withForge(state, () => findRepository(CFG, REPO));
  equal([found?.name, state.name, state.calls], [REPO, REPO, ["PATCH "]]);
  equal((await withForge(state, () => findRepository(CFG, REPO)))?.name, REPO);
  equal(state.calls, ["PATCH "], "a second look changes nothing");

  const cased = forge({ name: REPO.toUpperCase() });
  equal((await withForge(cased, () => findRepository(CFG, REPO)))?.name, REPO);

  // Renamed as another gateway's, it is that gateway's: this one has none.
  const other = forge({ name: `gateway-gwy${"b".repeat(21)}` });
  equal([await withForge(other, () => findRepository(CFG, REPO)), other.calls], [null, []]);
});

Deno.test("every deploy key is read, past the first page", async () => {
  const keys = Array.from({ length: 101 }, (_, id) => ({ id, title: `key ${id}`, key: "ssh-ed25519 A", read_only: false }));
  equal((await withForge(forge({ keys }), () => listDeployKeys(CFG, { name: REPO }))).length, 101);
});

Deno.test("the rule on the branches Aber proposes from is one of ours, and another on one of them is not", async () => {
  const bumps = rule("aber-platform-*", { priority: 500, enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ["aber_platform"] });
  const state = forge({ rules: [closed("main"), appliance(), bumps, closed("aber-platform-v9.9.9"), catchAll()] });
  equal(await putRight(state), [false, false, true]);
  equal(state.rules.map((r) => r.rule_name), ["main", "appliance", "aber-platform-*", "**"]);
});
