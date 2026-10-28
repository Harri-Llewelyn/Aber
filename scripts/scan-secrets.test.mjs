// =================================================================================================
// scripts/scan-secrets.mjs: the history scope it takes, and the accepted list --ignore-union builds
//
// The parts that need no Docker. The union is read from a throwaway repository with a branch, a tag
// and a ref without a list, the way the scheduled scan reads a clone with every branch fetched.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeFindings, parseArgs, parseCatFileBatch, refLists, unionIgnore } from './scan-secrets.mjs';

test('the default scope is every ref, against the checkout\'s own list', () => {
  assert.deepEqual(parseArgs([]), { history: 'all', union: false, gitDir: undefined });
  assert.deepEqual(parseArgs(['--history=all']), { history: 'all', union: false, gitDir: undefined });
});

test('--history=head, --ignore-union and --git-dir are read', () => {
  assert.equal(parseArgs(['--history=head']).history, 'head');
  assert.equal(parseArgs(['--ignore-union']).union, true);
  assert.equal(parseArgs(['--git-dir=/tmp/m.git', '--ignore-union']).gitDir, '/tmp/m.git');
  assert.equal(parseArgs(['--git-dir=/tmp/m.git', '--history=head']).history, 'head');
});

test('an unknown scope, an unknown argument and a union of one commit are refused', () => {
  assert.match(parseArgs(['--history=HEAD']).error, /--history takes all or head, not "HEAD"/);
  assert.match(parseArgs(['--history=']).error, /--history takes all or head/);
  assert.match(parseArgs(['--histroy=head']).error, /unknown argument --histroy=head/);
  assert.match(parseArgs(['--git-dir=']).error, /unknown argument --git-dir=/);
  assert.match(parseArgs(['--history=head', '--ignore-union']).error, /drop --history=head/);
});

test('the union keeps the checkout\'s list and adds only what another ref accepts', () => {
  const base = '# reviewed\naaa:f.yaml:jwt:1\n\nbbb:g.yaml:jwt:2\n';
  const { text, added } = unionIgnore(base, [
    ['refs/heads/main', base],
    ['refs/remotes/origin/one', '# its own reason\naaa:f.yaml:jwt:1\nccc:h.yaml:jwt:3\nccc:h.yaml:jwt:3\n'],
    ['refs/remotes/origin/pr/7', 'ccc:h.yaml:jwt:3\r\nddd:i.yaml:generic-api-key:4\r\n'],
    ['refs/tags/v1', '# a comment only\n\n'],
  ]);
  assert.equal(text, `${base}\n# Accepted on refs/remotes/origin/one\nccc:h.yaml:jwt:3\n` +
    '\n# Accepted on refs/remotes/origin/pr/7\nddd:i.yaml:generic-api-key:4\n');
  assert.deepEqual(added, [['refs/remotes/origin/one', 1], ['refs/remotes/origin/pr/7', 1]]);
});

test('a list without a final newline, or none at all, still yields one fingerprint a line', () => {
  assert.equal(unionIgnore('aaa:f:jwt:1', [['r', 'bbb:g:jwt:2']]).text, 'aaa:f:jwt:1\n\n# Accepted on r\nbbb:g:jwt:2\n');
  assert.equal(unionIgnore('', [['r', 'bbb:g:jwt:2']]).text, '\n# Accepted on r\nbbb:g:jwt:2\n');
});

test('cat-file\'s batch output is read by byte size, past a missing list and a tree', () => {
  const blob = (text) => {
    const body = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from(`${'a'.repeat(40)} blob ${body.length}\n`), body, Buffer.from('\n')]);
  };
  const out = Buffer.concat([
    blob('# reason — with a dash\naaa:f:jwt:1\n'),
    Buffer.from('refs/heads/none:.gitleaksignore missing\n'),
    Buffer.from(`${'b'.repeat(40)} tree 0\n\n`),
    blob('bbb:g:jwt:2\n'),
  ]);
  assert.deepEqual(parseCatFileBatch(out, ['HEAD', 'refs/heads/none', 'refs/heads/odd', 'refs/tags/v1']), [
    ['HEAD', '# reason — with a dash\naaa:f:jwt:1\n'],
    ['refs/tags/v1', 'bbb:g:jwt:2\n'],
  ]);
  assert.throws(() => parseCatFileBatch(Buffer.from(''), ['HEAD']), /stopped before HEAD/);
});

test('a committed finding is named by its fingerprint and the refs that reach it, never its value', () => {
  const report = [
    { RuleID: 'jwt', Commit: 'c1', Fingerprint: 'c1:a.yaml:jwt:3', Secret: 'REDACTED', Match: 'key: REDACTED' },
    { RuleID: 'jwt', Commit: 'c2', Fingerprint: 'c2:b.yaml:jwt:1', Secret: 'REDACTED' },
  ];
  const refs = { c1: ['refs/heads/a', 'refs/heads/b', 'refs/remotes/origin/pr/4', 'refs/tags/v1', 'refs/heads/main'], c2: [] };
  const text = describeFindings(report, { refsOf: (c) => refs[c] });
  assert.equal(text, '   c1:a.yaml:jwt:3  (on refs/heads/a, refs/heads/b, refs/remotes/origin/pr/4 and 2 more)\n' +
    '   c2:b.yaml:jwt:1');
  assert.doesNotMatch(text, /REDACTED/);
});

test('an uncommitted finding is named by the file whose header is above its line', () => {
  const scanned = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n+one\n\n+++ b/new.txt\ntwo\n';
  const finding = (line) => ({ RuleID: 'r', Commit: '', StartLine: line, Fingerprint: `:r:${line}` });
  assert.equal(describeFindings([finding(5), finding(8), finding(1)], { text: scanned }),
    '   :r:5  (in x.js, not committed)\n   :r:8  (in new.txt, not committed)\n   :r:1');
});

test('every ref of a clone is read for its own list, and a ref without one is skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-secrets-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (file, text) => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', file);
  };
  git('init', '-q', '-b', 'main');
  commit('README', 'no list yet\n');
  git('branch', 'bare');
  commit('.gitleaksignore', 'aaa:f:jwt:1\n');
  git('checkout', '-q', '-b', 'feature');
  commit('.gitleaksignore', 'aaa:f:jwt:1\nbbb:g:jwt:2\n');
  git('tag', '-a', '-m', 'v', 'v1');
  git('checkout', '-q', 'main');

  const lists = refLists(join(dir, '.git'));
  assert.deepEqual(lists, [
    ['HEAD', 'aaa:f:jwt:1\n'],
    ['refs/heads/feature', 'aaa:f:jwt:1\nbbb:g:jwt:2\n'],
    ['refs/heads/main', 'aaa:f:jwt:1\n'],
    ['refs/tags/v1', 'aaa:f:jwt:1\nbbb:g:jwt:2\n'],
  ]);
  assert.deepEqual(unionIgnore('aaa:f:jwt:1\n', lists).added, [['refs/heads/feature', 1]]);
});
