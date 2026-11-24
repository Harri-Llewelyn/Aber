/**
 * The platform bump Aber proposes in a gateway's repository: the pure parts. `proposePlatformBump()`
 * in forge.ts makes the calls, and forge-sweep asks it once a pass for each Remote gateway in service.
 */

/**
 * The branch a proposal is made on is this and the tag, and the rule on these branches is this and
 * `*`. No slash: a rule is addressed by its name in the API's path, and the gateway's forge-api
 * listener refuses a path carrying an escaped one.
 */
export const BUMP_BRANCH_PREFIX = "aber-platform-";

export function bumpBranch(tag: string): string {
  return `${BUMP_BRANCH_PREFIX}${tag}`;
}

/** The three numbers of a release tag (`vX.Y.Z`), or null for any other ref: somebody chose that one. */
export function releaseTag(ref: string): [number, number, number] | null {
  const parts = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(ref);
  return parts && [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Whether `a` is an older release than `b`. False when either is not a release tag. */
export function isOlderRelease(a: string, b: string): boolean {
  const [x, y] = [releaseTag(a), releaseTag(b)];
  if (!x || !y) return false;
  const at = [0, 1, 2].find((i) => x[i] !== y[i]);
  return at !== undefined && x[at] < y[at];
}

/** A file's text from the contents API's base64, byte for byte (its byte-order mark kept), or null when it is not UTF-8. */
export function exactText(content: string): string | null {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The tag `platform.yml` names, and where its characters are in the text. */
export interface PlatformTag {
  tag: string;
  start: number;
  end: number;
}

/** A value on its key's own line: quoted, or plain without a space in it. A comment may follow. */
const TAG_VALUE = /^[ \t]+(?:"([^"\\]+)"|'([^']+)'|([^\s"'#&*!|>{}[\],%@`][^\s]*))(?:[ \t]+#.*)?[ \t]*$/;

/**
 * The one `tag` line of the top-level `platform:` block, or why there is none to change. Read line
 * by line rather than as YAML, because the change must leave every other byte as it was: what this
 * cannot point at, it declines.
 */
export function findPlatformTag(text: string): PlatformTag | { reason: string } {
  const unclear = (why: string) => ({ reason: `it has no single line naming platform.tag: ${why}` });
  const tags: PlatformTag[] = [];
  let blocks = 0;
  let inside = false;
  let depth = 0; // the block's own indentation, once its first line has shown it
  let underTag = false; // whether the line above, at that depth, is the tag's
  let offset = 0;

  for (const raw of text.split("\n")) {
    const start = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (/^\s*(#.*)?$/.test(line)) continue;

    const top = /^\uFEFF?(["']?)platform\1 *:(.*)$/.exec(line);
    if (top) {
      blocks += 1;
      if (!/^\s*(#.*)?$/.test(top[2])) return unclear("`platform` is not a block of its own lines");
      [inside, depth, underTag] = [true, 0, false];
      continue;
    }
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent === "") {
      inside = false;
      continue;
    }
    if (!inside) continue;
    if (indent.includes("\t")) return unclear("a line under `platform` is indented with a tab");
    if (depth === 0) depth = indent.length;
    if (indent.length > depth) {
      if (underTag) return unclear("the tag runs on to a second line");
      continue;
    }
    if (indent.length < depth) return unclear("the lines under `platform` are indented unevenly");

    const key = /^ +(["']?)tag\1 *:/.exec(line);
    underTag = key !== null;
    if (!key) continue;
    const value = TAG_VALUE.exec(line.slice(key[0].length));
    const tag = value?.[1] ?? value?.[2] ?? value?.[3];
    if (!tag) return unclear("the tag is not a plain value on its line");
    const at = start + line.indexOf(tag, key[0].length);
    tags.push({ tag, start: at, end: at + tag.length });
  }

  if (blocks === 0) return unclear("there is no `platform` block");
  if (blocks > 1) return unclear("there is more than one `platform` block");
  if (tags.length === 0) return unclear("there is no `tag` under `platform`");
  if (tags.length > 1) return unclear("there is more than one `tag` under `platform`");
  return tags[0];
}

/** The text with that tag's characters replaced, and nothing else. */
export function withPlatformTag(text: string, found: PlatformTag, to: string): string {
  return text.slice(0, found.start) + to + text.slice(found.end);
}

/** One of the machine account's own pull requests in a gateway's repository. */
export interface BumpPull {
  number: number;
  open: boolean;
  /** Its head branch's name, which must survive the branch's deletion. */
  branch: string;
}

/** What to do about a gateway whose `main` names an older release than `tag`. */
export interface BumpDecision {
  /** The pull request already made for this tag, in whatever state, or null: open one. */
  existing: number | null;
  /** The machine account's open pull requests for older releases, which the one above replaces. */
  supersedes: number[];
}

/**
 * One pull request for each tag, ever: one that a person closed was answered, so a closed one counts
 * as much as an open or a merged one.
 */
export function decideBump(pulls: BumpPull[], tag: string): BumpDecision {
  return {
    existing: pulls.find((p) => p.branch === bumpBranch(tag))?.number ?? null,
    supersedes: pulls
      .filter((p) => p.open && p.branch.startsWith(BUMP_BRANCH_PREFIX))
      .filter((p) => isOlderRelease(p.branch.slice(BUMP_BRANCH_PREFIX.length), tag))
      .map((p) => p.number),
  };
}

export function bumpTitle(tag: string): string {
  return `Converge to the platform at ${tag}`;
}

/** The pull request's text. `comparison` is the link to what changed between the two tags, or null. */
export function bumpBody(from: string, to: string, comparison: string | null): string {
  return [
    `Aber opened this pull request. This site now runs Aber \`${to}\`, and this gateway's \`platform.yml\` still names \`${from}\`.`,
    "",
    `**What changes:** one line of \`platform.yml\`. The tag moves from \`${from}\` to \`${to}\`.`,
    "",
    `**What merging it does:** the appliance converges to the platform at \`${to}\`. It fetches the merge within five minutes, and converges within the hour.`,
    "",
    comparison
      ? `**What is different:** [the platform from \`${from}\` to \`${to}\`](${comparison})`
      : `**What is different:** this forge has no platform at \`${from}\`, so there is no comparison to show.`,
    "",
    "**Who approves it:** an Administrator. Nobody on the site wrote this change, so any Administrator may approve it. Once approved, anyone who may write to this repository may merge it.",
    "",
    `Move one gateway first, and check that it converges before you merge the others. To keep this appliance on \`${from}\`, close this pull request: Aber does not open another for \`${to}\`. You can reopen it later.`,
    "",
  ].join("\n");
}

/** What is said on an older proposal when it is closed for a newer one. */
export function supersededComment(by: number, tag: string): string {
  return `This site now runs a newer Aber. #${by} proposes the platform at \`${tag}\`, in place of this pull request.`;
}
