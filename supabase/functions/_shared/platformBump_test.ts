import {
  BUMP_BRANCH_PREFIX,
  bumpBody,
  bumpBranch,
  bumpTitle,
  decideBump,
  exactText,
  findPlatformTag,
  isOlderRelease,
  releaseTag,
  supersededComment,
  withPlatformTag,
} from "./platformBump.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

/** The text with its tag moved, or the reason there is none to move. */
function moved(text: string, to = "v1.10.0"): string {
  const found = findPlatformTag(text);
  return "reason" in found ? `declined: ${found.reason}` : withPlatformTag(text, found, to);
}

function declined(text: string): boolean {
  return "reason" in findPlatformTag(text);
}

// What enrolment seeds (seedPlatformPointer in forge.ts).
const SEEDED = [
  "# The tag of platform/gateway-platform this appliance converges to. Changed by pull request:",
  "# a fleet bump is one pull request per gateway, and a canary is one gateway. `vars` are",
  "# applied to this appliance alone; forge/gateway-platform/README.md in the platform repository",
  "# says which the playbook accepts.",
  "platform:",
  "  tag: v1.9.0",
  "",
].join("\n");

Deno.test("a release tag is vX.Y.Z and nothing else", () => {
  assert.equal(releaseTag("v1.10.0"), [1, 10, 0]);
  assert.equal(releaseTag("v0.0.1"), [0, 0, 1]);
  for (const other of ["1.10.0", "v1.10", "v1.10.0-rc.1", "v1.10.0+build", "v01.1.0", "main", "", " v1.10.0", "v1.10.0\n", "v1.10.0.1", "a1b2c3d"]) {
    assert.equal(releaseTag(other), null, JSON.stringify(other));
  }
});

Deno.test("releases are compared as versions, not as text", () => {
  assert.equal(isOlderRelease("v1.9.0", "v1.10.0"), true);
  assert.equal(isOlderRelease("v1.10.0", "v1.9.0"), false);
  assert.equal(isOlderRelease("v1.9.9", "v2.0.0"), true);
  assert.equal(isOlderRelease("v1.9.0", "v1.9.1"), true);
  assert.equal(isOlderRelease("v1.9.0", "v1.9.0"), false);
});

Deno.test("a tag somebody chose is older than nothing", () => {
  for (const chosen of ["main", "a1b2c3d", "v1.10.0-rc.1", "my-branch", "1.0.0"]) {
    assert.equal(isOlderRelease(chosen, "v1.10.0"), false, chosen);
    assert.equal(isOlderRelease("v1.0.0", chosen), false, chosen);
  }
});

Deno.test("only the tag's own characters change in the file enrolment seeds", () => {
  assert.equal(moved(SEEDED), SEEDED.replace("tag: v1.9.0", "tag: v1.10.0"));
});

Deno.test("Windows line endings, and a file with no last newline, stay as they are", () => {
  const crlf = SEEDED.replaceAll("\n", "\r\n");
  assert.equal(moved(crlf), crlf.replace("tag: v1.9.0", "tag: v1.10.0"));
  assert.equal(moved("platform:\r\n  tag: v1.9.0\r\n"), "platform:\r\n  tag: v1.10.0\r\n");
  assert.equal(moved("platform:\n  tag: v1.9.0"), "platform:\n  tag: v1.10.0");
});

Deno.test("comments, spaces and quotes around the tag are kept", () => {
  assert.equal(moved("platform:   # the playbook\n  tag: v1.9.0  # v1.9.0 since March\n"), "platform:   # the playbook\n  tag: v1.10.0  # v1.9.0 since March\n");
  assert.equal(moved('platform:\n    tag:   "v1.9.0"   \n'), 'platform:\n    tag:   "v1.10.0"   \n');
  assert.equal(moved("platform:\n  tag: 'v1.9.0'\n"), "platform:\n  tag: 'v1.10.0'\n");
  assert.equal(moved("platform:\n  # tag: v1.0.0\n\n  tag : v1.9.0\n"), "platform:\n  # tag: v1.0.0\n\n  tag : v1.10.0\n");
  assert.equal(moved("\"platform\":\n  'tag': v1.9.0\n"), "\"platform\":\n  'tag': v1.10.0\n");
});

Deno.test("vars, and other blocks, that mention a tag are not it", () => {
  const vars = [
    "other:",
    "  tag: v0.1.0",
    "platform:",
    "  vars:",
    "    tag: v0.2.0",
    "    chrony_servers:",
    '      - "server ntp.plant.example iburst"',
    "    note: |",
    "      platform:",
    "        tag: v0.3.0",
    "  tag: v1.9.0",
    "  more:",
    "    - tag: v0.4.0",
    "tag: v0.5.0",
    "",
  ].join("\n");
  assert.equal(moved(vars), vars.replace("  tag: v1.9.0", "  tag: v1.10.0"));
});

Deno.test("a byte-order mark and every other character survive the round trip", () => {
  const text = `﻿platform:\n  tag: v1.9.0\n  vars:\n    site: "Aberystwyth – Pen̂"\n`;
  const bytes = new TextEncoder().encode(text);
  const read = exactText(btoa(String.fromCharCode(...bytes)));
  assert.equal(read, text);
  assert.equal(moved(read!), text.replace("v1.9.0", "v1.10.0"));
  // Gitea wraps a file's base64; a file that is not UTF-8 is not touched at all.
  assert.equal(exactText(btoa("platform:\n").replace(/(.{4})/g, "$1\n")), "platform:\n");
  assert.equal(exactText(btoa("\xff\xfe")), null);
});

Deno.test("a file with no single tag line is declined", () => {
  const files: Record<string, string> = {
    "empty": "",
    "only comments": "# platform:\n#   tag: v1.9.0\n",
    "no platform": "tag: v1.9.0\n",
    "no tag": "platform:\n  vars:\n    tag: v1.9.0\n",
    "an empty tag": "platform:\n  tag:\n",
    "a commented-out value": "platform:\n  tag: # v1.9.0\n",
    "two tags": "platform:\n  tag: v1.9.0\n  tag: v1.8.0\n",
    "two tags, one of them quoted": "platform:\n  tag: v1.9.0\n  \"tag\": v1.8.0\n",
    "two platform blocks": "platform:\n  tag: v1.9.0\nplatform:\n  tag: v1.8.0\n",
    "two documents": "platform:\n  tag: v1.9.0\n---\nplatform:\n  tag: v1.8.0\n",
    "a flow mapping": "platform: {tag: v1.9.0}\n",
    "an anchor on the block": "platform: &p\n  tag: v1.9.0\n",
    "an alias": "platform: *p\n",
    "an anchored tag": "platform:\n  tag: &t v1.9.0\n",
    "an aliased tag": "platform:\n  tag: *t\n",
    "a block scalar": "platform:\n  tag: |\n    v1.9.0\n",
    "a tag over two lines": "platform:\n  tag: v1.9.0\n    and-more\n",
    "a tag of two words": "platform:\n  tag: v1.9.0 or-so\n",
    "a tab": "platform:\n\ttag: v1.9.0\n",
    "uneven lines": "platform:\n    vars: {}\n  tag: v1.9.0\n",
    "no space after the colon": "platform:\n  tag:v1.9.0\n",
  };
  for (const [what, text] of Object.entries(files)) assert.equal(declined(text), true, what);
});

Deno.test("a tag of another shape is found, so it can be left alone", () => {
  for (const tag of ["main", "v1.10.0-rc.1", "a1b2c3d", "feature/x"]) {
    const found = findPlatformTag(`platform:\n  tag: ${tag}\n`);
    assert.equal("tag" in found && found.tag, tag);
  }
});

Deno.test("the branch is named for Aber and its tag, with no slash in it", () => {
  assert.equal(bumpBranch("v1.10.0"), "aber-platform-v1.10.0");
  assert.equal(BUMP_BRANCH_PREFIX.includes("/"), false);
});

const pull = (number: number, tag: string, open: boolean) => ({ number, open, branch: bumpBranch(tag) });

Deno.test("a gateway with no pull request for the tag gets one", () => {
  assert.equal(decideBump([], "v1.10.0"), { existing: null, supersedes: [] });
  assert.equal(decideBump([pull(3, "v1.9.0", false)], "v1.10.0"), { existing: null, supersedes: [] });
});

Deno.test("one that is open, merged or closed by a person is not made again", () => {
  for (const open of [true, false]) {
    assert.equal(decideBump([pull(4, "v1.10.0", open)], "v1.10.0"), { existing: 4, supersedes: [] }, String(open));
  }
});

Deno.test("an older one still open is closed for the newer, and no other is", () => {
  const pulls = [
    pull(9, "v1.11.0", true),
    { number: 8, open: true, branch: "platform-notes" },
    { number: 7, open: true, branch: `${BUMP_BRANCH_PREFIX}by-hand` },
    pull(6, "v1.8.0", false),
    pull(5, "v1.9.0", true),
    pull(4, "v1.9.1", true),
  ];
  assert.equal(decideBump(pulls, "v1.10.0"), { existing: null, supersedes: [5, 4] });
  // The pass that opened the newer one died before it closed these: the next one does.
  assert.equal(decideBump([pull(10, "v1.10.0", false), ...pulls], "v1.10.0"), { existing: 10, supersedes: [5, 4] });
});

Deno.test("the text says what moves, what merging does, who approves and what closing means", () => {
  const body = bumpBody("v1.9.0", "v1.10.0", "/:root/platform/gateway-platform/compare/v1.9.0...v1.10.0");
  for (const said of [
    "from `v1.9.0` to `v1.10.0`",
    "converges to the platform at `v1.10.0`",
    "(/:root/platform/gateway-platform/compare/v1.9.0...v1.10.0)",
    "an Administrator",
    "close this pull request: Aber does not open another for `v1.10.0`",
  ]) assert.equal(body.includes(said), true, said);
  assert.equal(bumpTitle("v1.10.0"), "Converge to the platform at v1.10.0");
  assert.equal(bumpBody("v0.1.0", "v1.10.0", null).includes("]("), false);
  assert.equal(supersededComment(12, "v1.10.0").includes("#12"), true);
});
