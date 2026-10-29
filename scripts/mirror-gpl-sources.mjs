#!/usr/bin/env node
/**
 * The GitHub release that mirrors the complete corresponding source of the GPL and LGPL components
 * in the images built on supabase/postgres: PostGIS, pgRouting, the copyleft libraries only PostGIS
 * loads, and the scripts that built them. One release per base tag and scope (the lock's `scope`),
 * named by releaseTag(); every archive is pinned in licenses/supabase-postgres/sources.json.
 *
 *   node scripts/mirror-gpl-sources.mjs --check     download each archive from upstream, verify it against the lock
 *   node scripts/mirror-gpl-sources.mjs --verify    read only: the release is published and holds every archive at its SHA-256
 *   node scripts/mirror-gpl-sources.mjs --publish   create the release as a draft if absent, upload what it lacks, verify, publish
 *   node scripts/mirror-gpl-sources.mjs --notes     print the release notes
 *
 * The repository has immutable releases, so a published release can gain no asset and change none:
 * --publish uploads to a draft, verifies every digest, and only then publishes. Run again, it finds
 * the release complete and does nothing. Downloads are verified against the lock before upload.
 * --publish and --verify run `gh` (GH_TOKEN), argument lists only.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { dockerfileBases, walk, withoutDigest } from './check-image-licences.mjs';
import {
  BASE_IMAGE, LOCK, RELEASE_REPO, SUMS, parseLock, releaseTag, releaseTitle, releaseUrl, sumsFile,
} from './lib/gpl-sources.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The base tags the Dockerfiles build on, read as check-image-licences reads them. */
export function baseTagsOf(dockerfiles) {
  return [...new Set(dockerfiles.flatMap(({ text }) => dockerfileBases(text).map(withoutDigest)
    .filter((b) => b.startsWith(`${BASE_IMAGE}:`)).map((b) => b.slice(BASE_IMAGE.length + 1))))];
}

/** Every archive the release carries, SHA256SUMS last, as { name, sha256, size }. */
export function expectedAssets(lock) {
  const sums = Buffer.from(sumsFile(lock));
  return [
    ...lock.assets.map((a) => ({ name: a.asset, sha256: a.sha256, size: a.size })),
    { name: SUMS, sha256: sha256(sums), size: sums.length },
  ];
}

/**
 * The release against the lock. `release` is null when absent, else { draft, assets: [{ name,
 * digest }] } with GitHub's `sha256:<hex>` digest, or null where it has none yet. `missing` and
 * `wrong` name assets; `unknown` are present without a digest, to be downloaded and hashed.
 */
export function compare(lock, release) {
  const have = new Map((release?.assets ?? []).map((a) => [a.name, a.digest]));
  const out = { missing: [], wrong: [], unknown: [] };
  for (const want of expectedAssets(lock)) {
    if (!have.has(want.name)) out.missing.push(want.name);
    else if (!have.get(want.name)) out.unknown.push(want.name);
    else if (have.get(want.name) !== `sha256:${want.sha256}`) out.wrong.push(want.name);
  }
  return out;
}

/**
 * What --publish does next. A published release is immutable: anything missing or wrong there is a
 * problem no run can fix. A draft can take what it lacks; an asset it holds at the wrong digest is a
 * problem, left for a person to delete rather than overwritten.
 */
export function plan(lock, release) {
  const { missing, wrong, unknown } = compare(lock, release);
  const tag = releaseTag(lock.base, lock.scope);
  const problems = [];
  if (release && !release.draft && (missing.length || wrong.length)) {
    problems.push(`${tag} is published and immutable, and ${[...missing.map((m) => `lacks ${m}`), ...wrong.map((w) => `holds ${w} at another digest`)].join(', ')}. `
      + 'No run can add or replace an asset there; a person decides what replaces it (licenses/README.md, The mirror).');
  }
  if (release?.draft) for (const w of wrong) problems.push(`the draft ${tag} holds ${w} at a digest the lock does not pin. Delete that asset, then run this again.`);
  return {
    create: !release,
    upload: problems.length ? [] : missing,
    unknown,
    publish: !problems.length && (!release || release.draft),
    problems,
  };
}

/** The release notes, from the lock. */
export function releaseNotes(lock) {
  const rows = lock.assets.map((a) => `| ${a.component} | \`${a.version}\` | \`${a.asset}\` | [upstream](${a.url}) | ${a.note ?? ''} |`);
  return [
    `The complete corresponding source of the GPL and LGPL components in the Aber images built on \`${BASE_IMAGE}:${lock.base}\`:`,
    '`ghcr.io/harri-llewelyn/aber/supabase-db`, `ghcr.io/harri-llewelyn/aber/db-init` and `ghcr.io/harri-llewelyn/aber/backup-service`.',
    'They carry PostGIS and pgRouting (GPL-2.0-or-later) and the copyleft libraries only PostGIS loads, unmodified from the base image.',
    '',
    ...(lock.covers ? [lock.covers, ''] : []),
    'One archive per component, with the build scripts. `SHA256SUMS` lists every archive\'s SHA-256, and',
    '[`licenses/supabase-postgres/sources.json`](https://github.com/Harri-Llewelyn/Aber/blob/main/licenses/supabase-postgres/sources.json) pins them.',
    'The licences are in [`NOTICE.md`](https://github.com/Harri-Llewelyn/Aber/blob/main/NOTICE.md) and, in each image, under `/usr/share/licenses/`.',
    '',
    '| Component | Version | Asset | Source | Note |',
    '| :--- | :--- | :--- | :--- | :--- |',
    ...rows,
    '',
    'The written offer in each image (`/usr/share/licenses/postgis/SOURCE`, `/usr/share/licenses/pgrouting/SOURCE`) still stands.',
    'This is not an Aber release.',
    '',
  ].join('\n');
}

/** The response to a GET of `url`, following up to `hops` redirects. */
function getFollowing(url, hops = 10) {
  return new Promise((ok, fail) => {
    get(url, { headers: { 'User-Agent': 'aber-mirror-gpl-sources', Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        getFollowing(new URL(res.headers.location, url).href, hops - 1).then(ok, fail);
      } else if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`${url} answered ${res.statusCode}`));
      } else {
        ok(res);
      }
    }).on('error', fail);
  });
}

/**
 * Download `url` to `dest`, hashing as it streams. node:https rather than fetch: it asks for no
 * content encoding and decodes none, so the bytes hashed are the archive's, and GitLab refuses its
 * archives to fetch's default headers now and then (406).
 */
export async function download(url, dest) {
  const res = await getFollowing(url);
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  await pipeline(res, tap, createWriteStream(dest));
  return { sha256: hash.digest('hex'), size };
}

/** `gh` with an argument list, no shell. Returns stdout. */
export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** The release as compare() reads it, or null when there is none (a draft included). */
export function fetchRelease(run, tag) {
  let out;
  try {
    out = run(['release', 'view', tag, '--repo', RELEASE_REPO, '--json', 'isDraft,assets']);
  } catch (e) {
    if (/release not found/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) return null;
    throw e;
  }
  const r = JSON.parse(out);
  return { draft: r.isDraft, assets: r.assets.map((a) => ({ name: a.name, digest: a.digest || null })) };
}

/** Hash the release's copies of `names`, for assets GitHub reports no digest for. */
async function hashFromRelease(run, tag, names, dir) {
  const digests = {};
  for (const name of names) {
    run(['release', 'download', tag, '--repo', RELEASE_REPO, '--pattern', name, '--dir', dir, '--clobber']);
    digests[name] = `sha256:${sha256(readFileSync(join(dir, name)))}`;
  }
  return digests;
}

/** Problems with the release as it stands: absent, a draft, or an archive missing or at another digest. */
export async function verify(lock, { run = gh, dir } = {}) {
  const tag = releaseTag(lock.base, lock.scope);
  const release = fetchRelease(run, tag);
  if (!release) return [`there is no release ${tag} (${releaseUrl(lock.base, lock.scope)})`];
  const hashed = await hashFromRelease(run, tag, compare(lock, release).unknown, dir);
  const filled = { ...release, assets: release.assets.map((a) => ({ ...a, digest: a.digest ?? hashed[a.name] ?? null })) };
  const { missing, wrong } = compare(lock, filled);
  return [
    ...(release.draft ? [`${tag} is still a draft, so nobody can download it`] : []),
    ...missing.map((m) => `${tag} lacks ${m}`),
    ...wrong.map((w) => `${tag} holds ${w} at a digest the lock does not pin`),
  ];
}

/**
 * Create the draft if absent, upload what it lacks (each download verified against the lock first),
 * verify every digest, then publish. Returns what it did, as lines.
 */
export async function publish(lock, { run = gh, fetchTo = download, dir }) {
  const tag = releaseTag(lock.base, lock.scope);
  const done = [];
  const steps = plan(lock, fetchRelease(run, tag));
  if (steps.problems.length) throw new Error(steps.problems.join('\n'));
  if (steps.create) {
    const notes = join(dir, 'notes.md');
    writeFileSync(notes, releaseNotes(lock));
    run(['release', 'create', tag, '--repo', RELEASE_REPO, '--draft', '--latest=false', '--title', releaseTitle(lock.base, lock.scope), '--notes-file', notes]);
    done.push(`created the draft ${tag}`);
  }
  for (const name of steps.upload) {
    const file = join(dir, name);
    if (name === SUMS) {
      writeFileSync(file, sumsFile(lock));
    } else {
      const want = lock.assets.find((a) => a.asset === name);
      const got = await fetchTo(want.url, file);
      if (got.sha256 !== want.sha256 || got.size !== want.size) {
        throw new Error(`${want.url} is now sha256:${got.sha256} (${got.size} bytes); the lock pins sha256:${want.sha256} (${want.size} bytes). Nothing uploaded from it.`);
      }
    }
    run(['release', 'upload', tag, file, '--repo', RELEASE_REPO]);
    done.push(`uploaded ${name}`);
  }
  if (steps.publish) {
    const problems = (await verify(lock, { run, dir })).filter((p) => !/still a draft/.test(p));
    if (problems.length) throw new Error(`not published:\n${problems.join('\n')}`);
    run(['release', 'edit', tag, '--repo', RELEASE_REPO, '--draft=false', '--latest=false']);
    done.push(`published ${tag}, every archive at its pinned SHA-256`);
  }
  const after = await verify(lock, { run, dir });
  if (after.length) throw new Error(after.join('\n'));
  if (!done.length) done.push(`${tag} is complete; nothing to do`);
  return done;
}

/** --check: every archive, downloaded from upstream into `dir`, is what the lock pins. */
export async function check(lock, { fetchTo = download, dir }) {
  const problems = [];
  for (const a of lock.assets) {
    try {
      const got = await fetchTo(a.url, join(dir, a.asset));
      if (got.sha256 !== a.sha256 || got.size !== a.size) problems.push(`${a.asset}: ${a.url} is sha256:${got.sha256} (${got.size} bytes), the lock pins sha256:${a.sha256} (${a.size} bytes)`);
    } catch (e) {
      problems.push(`${a.asset}: ${e.message}`);
    } finally {
      rmSync(join(dir, a.asset), { force: true });
    }
  }
  return problems;
}

/** The lock, after checking its base is the one the Dockerfiles build on. */
function readLock() {
  const lock = parseLock(readFileSync(join(REPO, LOCK), 'utf8'));
  const tags = baseTagsOf(walk(REPO).filter((f) => /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/.test(f))
    .map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') })));
  if (tags.length !== 1) throw new Error(`the Dockerfiles build on ${tags.length ? tags.map((t) => `${BASE_IMAGE}:${t}`).join(' and ') : `no ${BASE_IMAGE}`}; expected one tag`);
  if (tags[0] !== lock.base) throw new Error(`${LOCK} pins sources for ${BASE_IMAGE}:${lock.base}, and the Dockerfiles build on ${BASE_IMAGE}:${tags[0]}. Update the lock first.`);
  return lock;
}

async function main(mode) {
  const lock = readLock();
  if (mode === '--notes') {
    process.stdout.write(releaseNotes(lock));
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gpl-sources-'));
  try {
    if (mode === '--check') {
      const problems = await check(lock, { dir });
      for (const p of problems) console.log(`  FAIL  ${p}`);
      if (!problems.length) console.log(`  ok    all ${lock.assets.length} archives for ${BASE_IMAGE}:${lock.base} download at the SHA-256 the lock pins`);
      return problems.length ? 1 : 0;
    }
    if (mode === '--verify') {
      const problems = await verify(lock, { dir });
      for (const p of problems) console.log(`  FAIL  ${p}`);
      if (!problems.length) console.log(`  ok    ${releaseUrl(lock.base, lock.scope)} holds all ${lock.assets.length} archives and ${SUMS}, each at its pinned SHA-256`);
      return problems.length ? 1 : 0;
    }
    if (mode === '--publish') {
      for (const line of await publish(lock, { dir })) console.log(`  ok    ${line}`);
      return 0;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.error('usage: node scripts/mirror-gpl-sources.mjs --check | --verify | --publish | --notes');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main(process.argv[2]).then((code) => process.exit(code), (e) => {
    console.error(`  FAIL  ${e.message}`);
    process.exit(1);
  });
}
