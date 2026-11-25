import { clearMergedBump, recordBump } from "./bumpRecord.ts";
import { proposePlatformBump } from "./forge.ts";
import { bumpBranch, waitingBump } from "./platformBump.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const CFG = { baseUrl: "http://forge", user: "aber_platform", token: "f".repeat(40), webhookUrl: "", webhookSecret: "" };
const GATEWAY = `gwy${"0".repeat(21)}`;
const REPO = `gateway-${GATEWAY}`;
const TAG = "v1.10.0";
const [MAIN, MADE] = ["a".repeat(40), "c".repeat(40)];
const naming = (tag: string) => `platform:\n  tag: ${tag}\n`;
const [OLD, NEW] = [naming("v1.9.0"), naming(TAG)];

interface Forge {
  /** platform.yml on main, or null for a main without one. */
  main: string | null;
  pulls?: { number: number; state: string; tag: string }[];
  /** Every call is answered with this status instead. */
  down?: number;
}

/** What a call does against a forge in that state, and how many calls it made. */
async function against<T>(forge: Forge, act: () => Promise<T>): Promise<{ answer: T; calls: number }> {
  const texts: Record<string, string | null> = { [MAIN]: forge.main, [MADE]: NEW };
  let calls = 0;
  let branch: string | null = null;
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const path = new URL(String(input)).pathname.replace(`/api/v1/repos/gateways/${REPO}`, "").replace("/api/v1", "");
    const answer = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (forge.down) return answer(forge.down);
    const at = `${init?.method ?? "GET"} ${path}`;
    if (at === "GET /branches/main") return answer(200, { commit: { id: MAIN } });
    if (at === `GET /branches/${bumpBranch(TAG)}`) return branch ? answer(200, { commit: { id: branch } }) : answer(404);
    if (path.startsWith("/git/trees/")) {
      const commit = path.split("/")[3];
      const tree = texts[commit] === null ? [] : [{ path: "platform.yml", type: "blob", sha: `blob-${commit}` }];
      return answer(200, { tree });
    }
    if (path.startsWith("/git/blobs/")) return answer(200, { content: btoa(texts[path.slice("/git/blobs/blob-".length)]!) });
    if (at === "GET /pulls") {
      return answer(
        200,
        (forge.pulls ?? []).map((p) => ({ number: p.number, state: p.state, head: { label: bumpBranch(p.tag), repo_id: 1 }, base: { repo_id: 1 } })),
      );
    }
    if (at === "POST /branches") {
      branch = MAIN;
      return answer(201);
    }
    if (at === "PUT /contents/platform.yml") {
      branch = MADE;
      return answer(200, { commit: { sha: MADE, parents: [{ sha: MAIN }] } });
    }
    if (path.startsWith("/compare/")) {
      return answer(200, { total_commits: 1, commits: [{ sha: MADE, parents: [{ sha: MAIN }], files: [{ filename: "platform.yml" }] }] });
    }
    if (path.includes("/tags/")) return answer(200);
    if (at === "POST /pulls") return answer(201, { number: 7 });
    if (at.startsWith("PATCH /pulls/") || path.endsWith("/comments")) return answer(201);
    throw new Error(`the fake forge was asked ${at}`);
  };
  try {
    return { answer: await act(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

type Row = { sparkplug_id: string; forge_bump_tag: string | null; forge_bump_number: number | null };
const row = (tag: string | null = null, number: number | null = null): Row => ({ sparkplug_id: GATEWAY, forge_bump_tag: tag, forge_bump_number: number });

/** The gateways table, holding one row, and every update asked of it. `fails` is what each call answers. */
function database(held: Row, fails: string | null = null) {
  const writes: { values: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const error = fails === null ? null : { message: fails };
  const client = {
    from(table: string) {
      assert.equal(table, "gateways");
      const filters: Record<string, unknown> = {};
      const matches = () => Object.entries(filters).every(([column, value]) => held[column as keyof Row] === value);
      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return { maybeSingle: () => Promise.resolve({ data: !error && matches() ? { ...held } : null, error }) };
          },
        }),
        update(values: Partial<Row>) {
          const step = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return step;
            },
            then(resolve: (answer: { error: { message: string } | null }) => void) {
              writes.push({ values, filters });
              if (!error && matches()) Object.assign(held, values);
              resolve({ error });
            },
          };
          return step;
        },
      };
    },
  };
  return { admin: client as unknown as Parameters<typeof recordBump>[0], writes, held };
}

/** One pass over a gateway, as sweepBumps() makes it: the proposal, then what the row says. */
async function pass(forge: Forge, held: Row) {
  const { admin, writes } = database(held);
  await against(forge, async () => {
    const bump = await proposePlatformBump(CFG, REPO, TAG);
    await recordBump(admin, { ...held }, bump.waiting);
  });
  return { says: [held.forge_bump_tag, held.forge_bump_number], writes: writes.length };
}

Deno.test("what waits is the open pull request for the tag, and no other", () => {
  const pull = (number: number, tag: string, open: boolean) => ({ number, open, branch: bumpBranch(tag) });
  assert.equal(waitingBump([pull(3, "v1.9.0", true), pull(5, TAG, true)], TAG), { tag: TAG, number: 5 });
  assert.equal(waitingBump([pull(5, TAG, false)], TAG), null);
  assert.equal(waitingBump([pull(3, "v1.9.0", true)], TAG), null);
});

Deno.test("a pass that opens a proposal records it, and one that finds it open writes nothing more", async () => {
  assert.equal(await pass({ main: OLD }, row()), { says: [TAG, 7], writes: 1 });
  const open = { number: 7, state: "open", tag: TAG };
  assert.equal(await pass({ main: OLD, pulls: [open] }, row()), { says: [TAG, 7], writes: 1 });
  assert.equal(await pass({ main: OLD, pulls: [open] }, row(TAG, 7)), { says: [TAG, 7], writes: 0 });
  // Left by the release before: the newer one takes its place.
  const older = { number: 4, state: "open", tag: "v1.9.1" };
  assert.equal(await pass({ main: OLD, pulls: [older] }, row("v1.9.1", 4)), { says: [TAG, 7], writes: 1 });
});

Deno.test("a pass clears one that is closed, and one main has caught up with", async () => {
  assert.equal(await pass({ main: OLD, pulls: [{ number: 7, state: "closed", tag: TAG }] }, row(TAG, 7)), { says: [null, null], writes: 1 });
  for (const tag of [TAG, "v1.11.0", "my-branch"]) {
    const open = { number: 7, state: "open", tag: TAG };
    assert.equal(await pass({ main: naming(tag), pulls: [open] }, row(TAG, 7)), { says: [null, null], writes: 1 }, tag);
  }
  assert.equal(await pass({ main: NEW }, row()), { says: [null, null], writes: 0 });
});

Deno.test("where main's file cannot be used, the proposal itself says whether it waits", async () => {
  for (const main of [null, "platform:\n  tag: v1.9.0\n  tag: v1.9.0\n"]) {
    assert.equal(await pass({ main, pulls: [{ number: 7, state: "open", tag: TAG }] }, row(TAG, 7)), { says: [TAG, 7], writes: 0 });
    assert.equal(await pass({ main, pulls: [{ number: 7, state: "closed", tag: TAG }] }, row(TAG, 7)), { says: [null, null], writes: 1 });
  }
});

Deno.test("a row the database refuses is an error, for the pass to report", async () => {
  const { admin } = database(row(), "permission denied");
  let said = "";
  try {
    await recordBump(admin, row(), { tag: TAG, number: 7 });
  } catch (err) {
    said = String(err);
  }
  assert.equal(said.includes("permission denied"), true, said);
});

Deno.test("a push to main that brings the release clears it, and any other push leaves it", async () => {
  const pushed = async (main: string | null, held: Row) => {
    const { admin, writes } = database(held);
    await against({ main }, () => clearMergedBump(CFG, admin, REPO, GATEWAY, MAIN));
    return { says: [held.forge_bump_tag, held.forge_bump_number], filters: writes.map((w) => w.filters) };
  };
  // Named in the update, so that one the sweep recorded meanwhile stays.
  const cleared = { says: [null, null], filters: [{ sparkplug_id: GATEWAY, forge_bump_tag: TAG }] };
  for (const tag of [TAG, "v1.11.0", "my-branch"]) assert.equal(await pushed(naming(tag), row(TAG, 7)), cleared, tag);
  for (const main of [OLD, null, "platform: {}\n"]) {
    assert.equal(await pushed(main, row(TAG, 7)), { says: [TAG, 7], filters: [] }, String(main));
  }
});

Deno.test("with nothing waiting a push asks the forge nothing", async () => {
  const { admin, writes } = database(row());
  const { calls } = await against({ main: NEW }, () => clearMergedBump(CFG, admin, REPO, GATEWAY, MAIN));
  assert.equal([calls, writes.length], [0, 0]);
});

Deno.test("a forge or a database that does not answer never fails the delivery", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const held = row(TAG, 7);
    const { admin, writes } = database(held);
    await against({ main: NEW, down: 500 }, () => clearMergedBump(CFG, admin, REPO, GATEWAY, MAIN));
    assert.equal([held.forge_bump_tag, writes.length], [TAG, 0]);
    await against({ main: NEW }, () => clearMergedBump(CFG, database(row(TAG, 7), "timeout").admin, REPO, GATEWAY, MAIN));
  } finally {
    console.warn = warn;
  }
});
