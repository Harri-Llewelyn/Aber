import { ensureTagProtection, fileAtCommit, type ForgeConfig, tagPatterns } from "./forge.ts";

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

/** Whether a tag rule matches a name, as Gitea reads a pattern between slashes. */
const matches = (pattern: string, name: string) => new RegExp(pattern.slice(1, -1), "s").test(name);

Deno.test("the two patterns are exact complements over names near and far from a branch's", () => {
  const { named, others } = tagPatterns(["main", "appliance"]);
  // Gitea keeps a pattern in a 255-character column.
  equal(others.length <= 255, true, "the pattern fits its column");

  const cases = (name: string) => [name, name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`, `${name.slice(0, -1)}${name.at(-1)!.toUpperCase()}`];
  const reserved = [...cases("main"), ...cases("appliance"), "mAiN", "aPPlIaNcE"];
  const ordinary = [
    ...["main", "appliance"].flatMap((name) => [
      // Every proper prefix, every prefix with another letter after it, and the name with more after.
      ...[...name].map((_, i) => name.slice(0, i)).filter(Boolean),
      ...[...name].map((_, i) => `${name.slice(0, i)}x`),
      ...[...name].map((_, i) => `${name.slice(0, i)}/`),
      `${name}s`, `${name}/x`, `x${name}`, `x/${name}`, `${name}${name}`, `${name}-1`, `heads/${name}`, `refs/heads/${name}`,
    ]),
    "v1", "v1.9.1", "1", "Z", "release_2026", "mainappliance", "café", "中",
  ];
  for (const name of reserved) equal([matches(named, name), matches(others, name)], [true, false], name);
  for (const name of ordinary) equal([matches(named, name), matches(others, name)], [false, true], name);
});

Deno.test("a name that starts another is told from it, and so is what follows both", () => {
  const { named, others } = tagPatterns(["ab", "abc"]);
  for (const name of ["ab", "abc", "AB", "aBc"]) equal([matches(named, name), matches(others, name)], [true, false], name);
  for (const name of ["a", "abd", "abcd", "b", "ac"]) equal([matches(named, name), matches(others, name)], [false, true], name);
});

interface Rule { id: number; name_pattern: string; whitelist_usernames: string[]; whitelist_teams: string[] }

/** The calls ensureTagProtection makes, answered from a list of rules and a map of tags. */
async function withForge<T>(
  state: { rules: Rule[]; refs?: Record<string, { type: string; sha: string }>; keeps?: string[]; releases?: string[] },
  body: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
  const { rules, refs = {}, keeps = [], releases = [] } = state;
  const calls: string[] = [];
  const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
  const saved = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const path = url.slice(`${CFG.baseUrl}/api/v1/repos/gateways/${REPO}`.length);
    const sent = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push(`${init.method} ${path}`);
    const rule = path.startsWith("/tag_protections/") ? rules.find((r) => `/tag_protections/${r.id}` === path) : undefined;
    if (path === "/tag_protections" && init.method === "GET") return json(rules);
    if (path === "/tag_protections") {
      if (rules.some((r) => r.name_pattern === sent.name_pattern)) return json({ message: "Tag protection already exist" }, 403);
      rules.push({ id: 100 + rules.length, ...sent });
      return json({}, 201);
    }
    if (rule && init.method === "PATCH") return json(Object.assign(rule, sent));
    if (rule) {
      rules.splice(rules.indexOf(rule), 1);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const name = path.split("/").at(-1)!;
    if (path.startsWith("/git/refs/tags/")) {
      return refs[name] ? json([{ ref: `refs/tags/${name}`, object: refs[name] }]) : json({}, 404);
    }
    if (path.startsWith("/releases/tags/")) {
      releases.splice(releases.indexOf(name), 1);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.startsWith("/tags/") && init.method === "DELETE") {
      if (releases.includes(name)) return json({}, 409);
      if (keeps.includes(name)) return json({}, 404);
      delete refs[name];
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.startsWith("/tags/")) return json({ commit: { sha: "c".repeat(40) } });
    throw new Error(`an unexpected call: ${init.method} ${path}`);
  }) as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = saved;
  }
}

/** Who Gitea lets make a tag: nobody refused when no rule matches, and whoever any matching rule admits. */
function admits(rules: Rule[], tag: string, who: { user?: string; team?: string }): boolean {
  const hit = rules.filter((r) => matches(r.name_pattern, tag));
  if (hit.length === 0) return true;
  return hit.some((r) =>
    (who.user !== undefined && r.whitelist_usernames.includes(who.user)) ||
    (who.team !== undefined && r.whitelist_teams.includes(who.team))
  );
}

Deno.test("nobody but the machine account makes a tag named as a branch, and a deploy key makes none", async () => {
  const rules: Rule[] = [];
  const { result } = await withForge({ rules }, () => ensureTagProtection(CFG, REPO));
  equal(result, { changed: true, found: [] });
  equal(rules.length, 2);
  for (const tag of ["main", "Main", "appliance", "APPLIANCE"]) {
    equal(admits(rules, tag, { team: "administrators" }), false, tag);
    equal(admits(rules, tag, { team: "managers" }), false, tag);
    equal(admits(rules, tag, { user: "gitea_admin" }), false, tag);
    equal(admits(rules, tag, {}), false, `${tag}, the key`);
    equal(admits(rules, tag, { user: CFG.user }), true, tag);
  }
  for (const tag of ["v1.9.1", "mainline", "release/main"]) {
    equal(admits(rules, tag, { team: "administrators" }), true, tag);
    equal(admits(rules, tag, { team: "managers" }), true, tag);
    equal(admits(rules, tag, {}), false, `${tag}, the key`);
  }
});

Deno.test("a repository whose rules agree is read and not written", async () => {
  const rules: Rule[] = [];
  await withForge({ rules }, () => ensureTagProtection(CFG, REPO));
  const { result, calls } = await withForge({ rules }, () => ensureTagProtection(CFG, REPO));
  equal(result, { changed: false, found: [] });
  equal(calls, ["GET /tag_protections", "GET /git/refs/tags/main", "GET /git/refs/tags/appliance"]);
});

Deno.test("a widened rule is put back, and any other rule is removed", async () => {
  const rules: Rule[] = [];
  await withForge({ rules }, () => ensureTagProtection(CFG, REPO));
  rules[0].whitelist_teams = ["managers"];
  rules.push({ id: 7, name_pattern: "*", whitelist_usernames: [], whitelist_teams: ["managers"] });
  // A second rule of one pattern, which the forge's settings page allows and its API does not.
  rules.push({ ...rules[1], id: 8, whitelist_usernames: ["someone"] });
  const { result } = await withForge({ rules }, () => ensureTagProtection(CFG, REPO));
  equal(result.changed, true);
  equal(rules.length, 2);
  equal(admits(rules, "main", { team: "managers" }), false);
  equal(admits(rules, "v1", { user: "someone" }), false);
});

Deno.test("a tag already there is reported with its commit and removed, its release too", async () => {
  const state = {
    rules: [] as Rule[],
    refs: {
      main: { type: "commit", sha: "a".repeat(40) },
      appliance: { type: "tag", sha: "b".repeat(40) },
      v1: { type: "commit", sha: "d".repeat(40) },
    } as Record<string, { type: string; sha: string }>,
    releases: ["main"],
  };
  const { result } = await withForge(state, () => ensureTagProtection(CFG, REPO));
  equal(result.found, [
    { tag: "main", commit: "a".repeat(40), removed: true },
    // An annotated tag: the commit it names, not the tag object.
    { tag: "appliance", commit: "c".repeat(40), removed: true },
  ]);
  equal(Object.keys(state.refs), ["v1"]);
  equal(state.releases, []);
});

Deno.test("a tag the forge will not remove is returned as still there, not thrown", async () => {
  const state = { rules: [] as Rule[], refs: { main: { type: "blob", sha: "a".repeat(40) } }, keeps: ["main"] };
  const { result } = await withForge(state, () => ensureTagProtection(CFG, REPO));
  equal(result.found, [{ tag: "main", commit: "a".repeat(40), removed: false }]);
});

/** A forge holding one commit's tree, where a name that is not an object's id answers something else. */
async function withTree<T>(body: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    "/git/trees/commit1?page=1&per_page=1000": { tree: [{ path: "a", type: "blob", sha: "blobA" }], truncated: true },
    "/git/trees/commit1?page=2&per_page=1000": { tree: [{ path: "dir", type: "tree", sha: "treeD" }, { path: "flows.json", type: "blob", sha: "blobF" }] },
    "/git/trees/treeD?page=1&per_page=1000": { tree: [{ path: "x.md", type: "blob", sha: "blobX" }] },
    "/git/blobs/blobF": { content: btoa("[]\n") },
    "/git/blobs/blobX": { content: btoa("x") },
    "/git/blobs/blobA": { content: null },
  };
  const saved = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    const path = url.slice(`${CFG.baseUrl}/api/v1/repos/gateways/${REPO}`.length);
    calls.push(path);
    return Promise.resolve(new Response(JSON.stringify(answers[path] ?? {}), { status: path in answers ? 200 : 404 }));
  }) as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = saved;
  }
}

Deno.test("a file at a commit is found by object id, a page at a time, and by no name a branch could take", async () => {
  const { result, calls } = await withTree(() => fileAtCommit(CFG, { name: REPO }, "flows.json", "commit1"));
  equal(result?.sha, "blobF");
  equal(new TextDecoder().decode(result!.bytes), "[]\n");
  equal(calls.filter((c) => !c.startsWith("/git/trees/") && !c.startsWith("/git/blobs/")), []);

  equal((await withTree(() => fileAtCommit(CFG, { name: REPO }, "dir/x.md", "commit1"))).result?.sha, "blobX");
  equal((await withTree(() => fileAtCommit(CFG, { name: REPO }, "dir", "commit1"))).result, null, "a folder is no file");
  equal((await withTree(() => fileAtCommit(CFG, { name: REPO }, "absent", "commit1"))).result, null);
});

Deno.test("a commit the forge cannot read, and a file it will not give whole, are errors and not absences", async () => {
  for (const [path, commit] of [["flows.json", "commit2"], ["a", "commit1"]]) {
    let threw = false;
    try {
      await withTree(() => fileAtCommit(CFG, { name: REPO }, path, commit));
    } catch {
      threw = true;
    }
    equal(threw, true, `${path} at ${commit}`);
  }
});
