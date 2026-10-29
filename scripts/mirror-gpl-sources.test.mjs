// scripts/mirror-gpl-sources.mjs and scripts/lib/gpl-sources.mjs, offline: the lock's parse, what
// --publish does against an absent, draft or published release, and a digest that does not match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baseTagsOf, compare, expectedAssets, plan, publish, releaseNotes, verify } from './mirror-gpl-sources.mjs';
import { parseLock, releaseTag, releaseTitle, releaseUrl, sumsFile } from './lib/gpl-sources.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const BODY = { 'postgis-3.3.7.tar.gz': 'postgis source\n', 'pgrouting-3.4.1-pg17.patch': 'a patch\n' };
const asset = (name, over = {}) => ({
  component: name.startsWith('postgis') ? 'PostGIS' : 'pgRouting',
  version: name.startsWith('postgis') ? '3.3.7' : '3.4.1',
  url: `https://example.invalid/${name}`,
  asset: name,
  sha256: sha(BODY[name]),
  size: Buffer.byteLength(BODY[name]),
  ...over,
});
const LOCK_TEXT = JSON.stringify({ base: 'supabase/postgres:17.6.1.175', scope: 'postgis', assets: Object.keys(BODY).map((n) => asset(n)) });

test('the lock parses, and every malformed field is named', () => {
  const lock = parseLock(LOCK_TEXT);
  assert.equal(lock.base, '17.6.1.175');
  assert.equal(lock.scope, 'postgis');
  assert.equal(lock.assets.length, 2);
  assert.throws(() => parseLock('{'), /is not JSON/);
  const bad = JSON.stringify({
    base: 'postgres:17',
    scope: 'groonga',
    assets: [
      asset('postgis-3.3.7.tar.gz', { sha256: 'ABC', size: 0, url: 'http://insecure' }),
      asset('postgis-3.3.7.tar.gz', { component: '' }),
      asset('pgrouting-3.4.1-pg17.patch', { asset: 'SHA256SUMS' }),
      asset('pgrouting-3.4.1-pg17.patch', { asset: '../escape' }),
    ],
  });
  assert.throws(() => parseLock(bad), (e) => {
    for (const want of [/"base" is not "supabase\/postgres:<tag>"/, /"scope" is not one of postgis/, /"sha256" is not 64/, /"size" is not a positive/,
      /"url" is not an https URL/, /has no "component"/, /is named twice/, /not a file name a release can carry/]) {
      assert.match(e.message, want);
    }
    return true;
  });
  assert.throws(() => parseLock(JSON.stringify({ base: 'supabase/postgres:1', scope: 'postgis', assets: [] })), /non-empty list/);
});

test('the release tag is one per base tag and scope, never a v* release tag, and SHA256SUMS lists every archive', () => {
  assert.equal(releaseTag('17.6.1.175', 'postgis'), 'gpl-sources-supabase-postgres-17.6.1.175-postgis');
  assert.ok(!releaseTag('17.6.1.175', 'postgis').startsWith('v'));
  assert.equal(releaseUrl('17.6.1.175', 'postgis'), 'https://github.com/Harri-Llewelyn/Aber/releases/tag/gpl-sources-supabase-postgres-17.6.1.175-postgis');
  assert.equal(releaseTitle('17.6.1.175', 'postgis'), 'GPL and LGPL source of PostGIS and pgRouting in the Aber images built on supabase/postgres 17.6.1.175');
  const lock = parseLock(LOCK_TEXT);
  assert.equal(sumsFile(lock), `${sha(BODY['pgrouting-3.4.1-pg17.patch'])}  pgrouting-3.4.1-pg17.patch\n${sha(BODY['postgis-3.3.7.tar.gz'])}  postgis-3.3.7.tar.gz\n`);
  assert.deepEqual(expectedAssets(lock).map((a) => a.name), ['postgis-3.3.7.tar.gz', 'pgrouting-3.4.1-pg17.patch', 'SHA256SUMS']);
  assert.match(releaseNotes(lock), /`pgrouting-3\.4\.1-pg17\.patch`/);
});

test('the base tag is read from the Dockerfiles that build on supabase/postgres', () => {
  assert.deepEqual(baseTagsOf([
    { path: 'a', text: 'FROM supabase/postgres:17.6.1.175\n' },
    { path: 'b', text: `FROM supabase/postgres:17.6.1.175@sha256:${'a'.repeat(64)}\n` },
    { path: 'c', text: 'FROM nginx:alpine\n' },
  ]), ['17.6.1.175']);
});

test('the plan: create and upload everything; upload only what a draft lacks; nothing for a complete release', () => {
  const lock = parseLock(LOCK_TEXT);
  const all = expectedAssets(lock);
  const digest = (name) => `sha256:${all.find((a) => a.name === name).sha256}`;

  assert.deepEqual(plan(lock, null), { create: true, upload: all.map((a) => a.name), unknown: [], publish: true, problems: [] });

  const draft = { draft: true, assets: [{ name: 'postgis-3.3.7.tar.gz', digest: digest('postgis-3.3.7.tar.gz') }, { name: 'SHA256SUMS', digest: null }] };
  assert.deepEqual(plan(lock, draft), { create: false, upload: ['pgrouting-3.4.1-pg17.patch'], unknown: ['SHA256SUMS'], publish: true, problems: [] });

  const complete = { draft: false, assets: all.map((a) => ({ name: a.name, digest: digest(a.name) })) };
  assert.deepEqual(plan(lock, complete), { create: false, upload: [], unknown: [], publish: false, problems: [] });
});

test('a digest that does not match is refused, in a draft and in a published release', () => {
  const lock = parseLock(LOCK_TEXT);
  const all = expectedAssets(lock);
  const assets = all.map((a) => ({ name: a.name, digest: `sha256:${a.sha256}` }));
  assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.deepEqual(compare(lock, { draft: false, assets }).wrong, ['postgis-3.3.7.tar.gz']);

  const published = plan(lock, { draft: false, assets });
  assert.equal(published.upload.length, 0);
  assert.equal(published.publish, false);
  assert.match(published.problems[0], /published and immutable.*holds postgis-3\.3\.7\.tar\.gz at another digest/);

  const draft = plan(lock, { draft: true, assets: assets.slice(0, 1) });
  assert.deepEqual(draft.upload, []);
  assert.match(draft.problems[0], /the draft gpl-sources-supabase-postgres-17\.6\.1\.175-postgis holds postgis-3\.3\.7\.tar\.gz at a digest the lock does not pin/);
});

/** A fake `gh` over one release held in memory, recording every call. */
function fakeGh() {
  const state = { release: null, calls: [] };
  const run = (args) => {
    state.calls.push(args.slice(0, 2).join(' '));
    const [, verb, tag] = args;
    if (verb === 'view') {
      if (!state.release) throw Object.assign(new Error('gh failed'), { stderr: 'release not found' });
      return JSON.stringify({ isDraft: state.release.draft, assets: state.release.assets });
    }
    if (verb === 'create') state.release = { tag, draft: true, assets: [] };
    if (verb === 'upload') {
      const file = args[3];
      const name = file.split(/[\\/]/).pop();
      state.release.assets.push({ name, digest: `sha256:${state.uploaded(file)}` });
    }
    if (verb === 'edit') state.release.draft = false;
    return '';
  };
  return { state, run };
}

test('--publish creates, uploads, verifies and publishes, and a second run does nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpl-sources-test-'));
  try {
    const lock = parseLock(LOCK_TEXT);
    const { state, run } = fakeGh();
    const files = {};
    state.uploaded = (file) => sha(files[file.split(/[\\/]/).pop()] ?? sumsFile(lock));
    const fetchTo = async (url, dest) => {
      const name = url.split('/').pop();
      files[name] = BODY[name];
      writeFileSync(dest, BODY[name]);
      return { sha256: sha(BODY[name]), size: Buffer.byteLength(BODY[name]) };
    };

    const first = await publish(lock, { run, fetchTo, dir });
    assert.deepEqual(first, [
      'created the draft gpl-sources-supabase-postgres-17.6.1.175-postgis',
      'uploaded postgis-3.3.7.tar.gz',
      'uploaded pgrouting-3.4.1-pg17.patch',
      'uploaded SHA256SUMS',
      'published gpl-sources-supabase-postgres-17.6.1.175-postgis, every archive at its pinned SHA-256',
    ]);
    assert.equal(state.release.draft, false);
    assert.deepEqual(await verify(lock, { run, dir }), []);

    state.calls.length = 0;
    assert.deepEqual(await publish(lock, { run, fetchTo, dir }), ['gpl-sources-supabase-postgres-17.6.1.175-postgis is complete; nothing to do']);
    assert.ok(state.calls.every((c) => c === 'release view'), state.calls.join(', '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--publish uploads nothing from an upstream archive that no longer matches the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpl-sources-test-'));
  try {
    const lock = parseLock(LOCK_TEXT);
    const { state, run } = fakeGh();
    const fetchTo = async (_url, dest) => {
      writeFileSync(dest, 'changed upstream\n');
      return { sha256: sha('changed upstream\n'), size: 17 };
    };
    await assert.rejects(publish(lock, { run, fetchTo, dir }), /is now sha256:[0-9a-f]{64} \(17 bytes\); the lock pins .*Nothing uploaded from it/);
    assert.deepEqual(state.release.assets, []);
    assert.equal(state.release.draft, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--verify names an absent release, a draft, a missing archive and a wrong digest', async () => {
  const lock = parseLock(LOCK_TEXT);
  const { state, run } = fakeGh();
  assert.match((await verify(lock, { run }))[0], /there is no release gpl-sources-supabase-postgres-17\.6\.1\.175-postgis/);
  state.release = { draft: true, assets: [{ name: 'postgis-3.3.7.tar.gz', digest: `sha256:${'1'.repeat(64)}` }] };
  assert.deepEqual(await verify(lock, { run }), [
    'gpl-sources-supabase-postgres-17.6.1.175-postgis is still a draft, so nobody can download it',
    'gpl-sources-supabase-postgres-17.6.1.175-postgis lacks pgrouting-3.4.1-pg17.patch',
    'gpl-sources-supabase-postgres-17.6.1.175-postgis lacks SHA256SUMS',
    'gpl-sources-supabase-postgres-17.6.1.175-postgis holds postgis-3.3.7.tar.gz at a digest the lock does not pin',
  ]);
});
