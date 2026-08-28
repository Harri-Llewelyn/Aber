#!/usr/bin/env node
/**
 * How far behind upstream is each pinned image? Run by hand.
 *
 * =================================================================================================
 * WHY THIS EXISTS AT ALL, GIVEN RENOVATE
 * =================================================================================================
 *
 * It should not need to. `.github/workflows/renovate.yml` answers this question every day, and its
 * own header explains why it is written the way it is:
 *
 *     "A scheduled workflow that fails silently every Monday is worse than no workflow: the
 *      repository looks as though drift is being watched when it is not."
 *
 * That is exactly what happened, by a route the guard could not see. Renovate's own check fires
 * INSIDE the job -- and since 2026-08-24 the job has not started at all: every scheduled run
 * completes in three to five seconds with zero steps, which is what an exhausted Actions allowance
 * looks like. The last successful run was 2026-08-23.
 *
 * So the dependency dashboard (issue #53) is frozen at that date. It still lists
 * `postgrest v12.2.0` and `kong 3.9.3` -- one long since bumped, the other deleted from
 * docker-compose entirely. A reader who trusts it is reading August.
 *
 * THIS IS A STOPGAP AND SHOULD BE DELETED when Actions minutes return (September 2026). It answers
 * the one question the frozen dashboard can no longer answer, from a machine that can still reach
 * the registry. It opens no pull requests, changes no files, and has no schedule -- Renovate does
 * all of that better, and this exists only because Renovate cannot currently run.
 *
 * =================================================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * =================================================================================================
 *
 * NO CROSS-CONVENTION SEMVER. The pins use five different shapes -- `v2.102.3`, `17.6.1.160`,
 * `2.29.2-pg17`, `2026.07.07-sha-a6a04f2`, `24-alpine` -- and one comparator for all of them would
 * be wrong occasionally and confidently. Instead a candidate must match the SHAPE of our own pin
 * before it is considered at all, and only then are the numbers compared. Being wrong about "you
 * are up to date" is the failure that matters here.
 *
 * IT NEVER FAILS ON A NEW RELEASE. Exit code is 0 unless a PINNED TAG NO LONGER EXISTS, which is a
 * real problem -- a pull on a fresh machine would fail -- rather than a normal fact about upstream
 * shipping. A check that went red every time somebody else cut a release would be muted in a week.
 *
 * Usage:  node scripts/check-image-currency.mjs
 */

import { readFileSync } from 'node:fs';

const HUB = 'https://hub.docker.com/v2/repositories';

/** Every image docker-compose.yml pins to a concrete tag. Interpolated values are skipped. */
function pinnedImages() {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  const seen = new Map();
  for (const line of compose.split('\n')) {
    const m = line.trim().match(/^image:\s*["']?([^"'\s]+)/);
    if (!m || m[1].includes('${')) continue;
    const ref = m[1];
    const i = ref.lastIndexOf(':');
    if (i <= ref.lastIndexOf('/')) continue;          // no tag: nothing to compare
    const repo = ref.slice(0, i);
    const tag = ref.slice(i + 1);
    // Official images live under `library/` on the Hub API.
    const path = repo.includes('/') ? repo : `library/${repo}`;
    if (!seen.has(repo)) seen.set(repo, { repo, path, tag });
  }
  return [...seen.values()];
}

/**
 * The shape of our own pin, as a pattern.
 *
 * SORTING BY `last_updated` AND TAKING THE FIRST WAS THE FIRST ATTEMPT, AND IT WAS USELESS. What
 * moved most recently in a public repository is almost never a release: it reported
 * `postgrest v14.12 -> devel`, `grafana 13.2.0 -> nightly-slim`, `timescaledb 2.29.2-pg17 ->
 * latest-pg16` (a DOWNGRADE), and `envoy v1.31.5 -> tools-dev-0260c653…`. An allow-list of
 * suffixes to exclude could not keep up -- every registry names its floating tags differently.
 *
 * So the comparison is anchored on OUR pin instead. Each run of digits becomes `\d+` and everything
 * else is matched literally, which turns `v2.102.3` into /^v\d+\.\d+\.\d+$/ and `2.29.2-pg17` into
 * /^\d+\.\d+\.\d+-pg\d+$/. A candidate has to be the same KIND of tag before it can be a newer one,
 * which is what makes the answer trustworthy without a semver parser that would have to understand
 * five conventions and would be confidently wrong about one of them.
 */
function shapeOf(tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\d+/g, '\\d+')}$`);
}

/** Numeric tuple, for comparing two tags of the SAME shape. */
const parts = (tag) => (tag.match(/\d+/g) || []).map(Number);

function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

async function tagExists(path, tag) {
  const res = await fetch(`${HUB}/${path}/tags/${encodeURIComponent(tag)}`);
  return res.status !== 404;
}

async function tagsFor(path) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${HUB}/${path}/tags?page_size=100&page=${page}&ordering=last_updated`);
    if (!res.ok) return out.length ? out : null;
    const body = await res.json();
    out.push(...(body.results || []));
    if (!body.next) break;
  }
  return out;
}

const days = (iso) => Math.round((Date.now() - new Date(iso)) / 86400000);

let gone = 0;
const rows = [];

console.log('Pinned image currency. Renovate answers this properly; it cannot run without Actions');
console.log('minutes, so this is the by-hand substitute.\n');

for (const { repo, path, tag } of pinnedImages()) {
  let tags;
  try {
    tags = await tagsFor(path);
  } catch (err) {
    rows.push([repo, tag, '—', `unreachable (${err.message})`]);
    continue;
  }
  if (!tags) { rows.push([repo, tag, '—', 'not found on Docker Hub']); continue; }

  const shape = shapeOf(tag);
  const comparable = tags.filter((t) => shape.test(t.name));
  const ahead = comparable.filter((t) => newer(t.name, tag))
    .sort((p, q) => (newer(p.name, q.name) ? -1 : 1));

  // ASKED DIRECTLY RATHER THAN INFERRED FROM ABSENCE. A pin missing from the pages fetched is
  // usually just old -- realtime v2.34.47 is 200+ tags back. Only a 404 means the tag was DELETED,
  // which is the case that breaks a pull on a fresh machine, and it is the only thing worth an
  // exit code.
  if (!comparable.some((t) => t.name === tag)) {
    const exists = await tagExists(path, tag);
    if (!exists) {
      rows.push([repo, tag, ahead[0]?.name ?? '?', 'DELETED UPSTREAM — a fresh pull would fail']);
      gone += 1;
      continue;
    }
  }

  if (ahead.length === 0) {
    rows.push([repo, tag, tag, comparable.length > 1 ? 'newest of its kind' : 'no comparable tag']);
  } else {
    const ours = tags.find((t) => t.name === tag);
    const age = ours ? `, ours ${days(ours.last_updated)}d old` : '';
    rows.push([repo, tag, ahead[0].name, `${ahead.length} newer${age}`]);
  }
}

const w = (i) => Math.max(...rows.map((r) => String(r[i]).length));
const [a, b, c] = [w(0), w(1), w(2)];
for (const r of rows) {
  console.log(`  ${String(r[0]).padEnd(a)}  ${String(r[1]).padEnd(b)}  ->  ${String(r[2]).padEnd(c)}  ${r[3]}`);
}

console.log('');
if (gone) {
  console.log(`${gone} pinned tag(s) no longer exist upstream. A pull on a fresh machine fails.`);
  process.exit(1);
}
console.log('Every pin still exists upstream. Whether to MOVE is a judgement, not a check --');
console.log("upstream's tested combination is the yardstick, not the newest tag (see issue #49).");
