import { proposePlatformBump } from "./forge.ts";
import { bumpBranch } from "./platformBump.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const CFG = { baseUrl: "http://forge", user: "aber_platform", token: "f".repeat(40), webhookUrl: "", webhookSecret: "" };
const REPO = `gateway-gwy${"0".repeat(21)}`;
const TAG = "v1.10.0";
const BRANCH = bumpBranch(TAG);
// What each commit's platform.yml is, and where main and the new commit are.
const [BASE, MADE, OTHER] = ["a".repeat(40), "c".repeat(40), "d".repeat(40)];
const OLD = "platform:\n  tag: v1.9.0\n";
const NEW = "platform:\n  tag: v1.10.0\n";

interface Asked {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

interface Forge {
  /** The branch's commit when a pass finds it, or undefined for no such branch. */
  branch?: string;
  /** Where the branch is said to point once the commit is made. */
  afterwards?: string;
  parent?: string;
  files?: string[];
  ahead?: number;
  pulls?: { number: number; state: string; label: string }[];
  taken?: boolean;
}

/** One call against a forge in that state, and everything it asked. */
async function propose(forge: Forge) {
  const asked: Asked[] = [];
  const texts: Record<string, string> = { [BASE]: OLD, [MADE]: NEW, [OTHER]: NEW };
  let branch = forge.branch;
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Asked = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(`/api/v1/repos/gateways/${REPO}`, "").replace("/api/v1", ""),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    asked.push(call);
    const answer = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    const at = `${call.method} ${call.path}`;
    if (at === "GET /branches/main") return answer(200, { commit: { id: BASE } });
    if (at === `GET /branches/${BRANCH}`) return branch ? answer(200, { commit: { id: branch } }) : answer(404);
    if (call.method === "GET" && call.path.startsWith("/git/trees/")) {
      const commit = call.path.split("/")[3];
      return texts[commit] ? answer(200, { tree: [{ path: "platform.yml", type: "blob", sha: `blob-${commit}` }] }) : answer(404);
    }
    if (call.method === "GET" && call.path.startsWith("/git/blobs/blob-")) {
      return answer(200, { encoding: "base64", content: btoa(texts[call.path.slice("/git/blobs/blob-".length)]) });
    }
    if (at === "GET /pulls") {
      return answer(200, (forge.pulls ?? []).map((p) => ({ ...p, head: { label: p.label, repo_id: 1 }, base: { repo_id: 1 } })));
    }
    if (at === "POST /branches") {
      if (forge.taken) return answer(409);
      branch = String(call.body!.old_ref_name);
      return answer(201);
    }
    if (at === "PUT /contents/platform.yml") {
      branch = forge.afterwards ?? MADE;
      return answer(200, { commit: { sha: MADE, parents: [{ sha: forge.parent ?? BASE }] } });
    }
    if (call.path.startsWith("/compare/")) {
      const commit = call.path.split("...")[1];
      const files = (forge.files ?? ["platform.yml"]).map((filename) => ({ filename }));
      return answer(200, { total_commits: forge.ahead ?? 1, commits: [{ sha: commit, parents: [{ sha: BASE }], files }] });
    }
    if (call.path.includes("/tags/")) return answer(200);
    if (at === "POST /pulls") return answer(201, { number: 7 });
    if (call.method === "PATCH" || call.path.endsWith("/comments")) return answer(201);
    throw new Error(`the fake forge was asked ${at}`);
  };
  try {
    return { bump: await proposePlatformBump(CFG, REPO, TAG), asked };
  } finally {
    globalThis.fetch = real;
  }
}

const opened = (asked: Asked[]) => asked.filter((a) => a.method === "POST" && a.path === "/pulls").length;

Deno.test("every read is of one commit, and the branch is made at it", async () => {
  const { bump, asked } = await propose({});
  assert.equal(bump, { opened: 7, waiting: { tag: TAG, number: 7 }, closed: [], declined: null });
  assert.equal(asked[0].path, "/branches/main");

  const reads = asked.filter((a) => a.method === "GET" && /^\/(contents|raw|git)\//.test(a.path));
  assert.equal(reads.length > 0, true);
  const of = (commit: string) => [`/git/trees/${commit}`, `/git/blobs/blob-${commit}`];
  assert.equal(reads.map((a) => a.path), [...of(BASE), ...of(MADE)]);
  assert.equal(asked.filter((a) => a.path.startsWith("/compare/")).map((a) => a.path), [`/compare/${BASE}...${MADE}`]);

  const made = asked.find((a) => a.method === "POST" && a.path === "/branches");
  assert.equal(made?.body, { new_branch_name: BRANCH, old_ref_name: BASE });
  const committed = asked.find((a) => a.method === "PUT");
  assert.equal([committed?.body?.branch, committed?.body?.sha, atob(String(committed?.body?.content))], [BRANCH, `blob-${BASE}`, NEW]);
  const pull = asked.find((a) => a.method === "POST" && a.path === "/pulls");
  assert.equal([pull?.body?.head, pull?.body?.base], [BRANCH, "main"]);
});

Deno.test("a branch that is not at the commit just made, on main's, is not proposed", async () => {
  const states: Record<string, Forge> = {
    "points elsewhere": { afterwards: OTHER },
    "the commit is on another": { parent: OTHER },
    "more than one commit past main": { ahead: 2 },
    "the commit changes another file": { files: ["platform.yml", "custom.yml"] },
  };
  for (const [what, forge] of Object.entries(states)) {
    const { bump, asked } = await propose(forge);
    assert.equal(bump.opened, null, what);
    assert.equal(typeof bump.declined, "string", what);
    assert.equal(opened(asked), 0, what);
  }
});

Deno.test("a branch a pass left is used when it holds the bump or nothing, and no other is", async () => {
  // Committed, and the pass died before the pull request: proposed as it is.
  const left = await propose({ branch: MADE });
  assert.equal(left.bump.opened, 7);
  assert.equal(left.asked.some((a) => a.method === "PUT"), false);
  // Made, and not yet committed to.
  const bare = await propose({ branch: BASE });
  assert.equal(bare.bump.opened, 7);
  assert.equal(bare.asked.some((a) => a.method === "POST" && a.path === "/branches"), false);
  // Holding something else.
  const other = await propose({ branch: OTHER, files: ["custom.yml"] });
  assert.equal([other.bump.opened, opened(other.asked)], [null, 0]);
});

Deno.test("a branch name the forge will not make is declined, not retried", async () => {
  const { bump, asked } = await propose({ taken: true });
  assert.equal([bump.opened, typeof bump.declined, opened(asked)], [null, "string", 0]);
});

Deno.test("with a pull request for the tag already there, only an older one is touched", async () => {
  const { bump, asked } = await propose({
    pulls: [
      { number: 5, state: "closed", label: BRANCH },
      { number: 4, state: "open", label: bumpBranch("v1.9.0") },
      { number: 3, state: "closed", label: bumpBranch("v1.8.0") },
    ],
  });
  assert.equal(bump, { opened: null, waiting: null, closed: [4], declined: null });
  assert.equal(
    asked.filter((a) => a.method !== "GET").map((a) => `${a.method} ${a.path}`),
    ["PATCH /pulls/4", "POST /issues/4/comments"],
  );
});
