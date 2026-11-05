// =================================================================================================
// scripts/scan-source.mjs: which of Semgrep's errors fail the scan, and which files it must read
//
// The part that needs no Docker. The parse errors are Semgrep 1.140.0's `scan --json`, from its runs
// on this repository's files before they parsed, with the messages cut and the paths varied. The
// timeout and the rule error follow Semgrep's schema for those types. The ignore list's tests read
// the repository's own .semgrepignore as well as small lists of their own.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IGNORE_FILE, UNPARSED, ignoreRules, parseFailures, unscanned } from './scan-source.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The whole file refused: tree-sitter's root was an error, and pfff stopped at import.meta.
const WHOLE = {
  code: 3, level: 'warn', type: 'Syntax error',
  message: 'Syntax error at line scripts/check-docs-drift.mjs:1:\n `#!/usr/bin/env node\n/**\n * Assert that',
  path: 'scripts/check-docs-drift.mjs',
};
// Two stretches tree-sitter skipped: regexes that opened with an HTML comment marker.
const span = (line, col) => ({ start: { line, col, offset: 0 }, end: { line: line + 1, col: 8, offset: 61 } });
const PARTIAL = {
  code: 3, level: 'warn',
  type: ['PartialParsing', [{ path: 'scripts/check-mirror-drift.mjs', ...span(4999, 43) }, { path: 'scripts/check-mirror-drift.mjs', ...span(8158, 40) }]],
  message: 'Syntax error at line scripts/check-mirror-drift.mjs:4999:\n `(c) => c.replace(` was unexpected',
  path: 'scripts/check-mirror-drift.mjs',
  spans: [{ file: 'scripts/check-mirror-drift.mjs', ...span(4999, 43) }, { file: 'scripts/check-mirror-drift.mjs', ...span(8158, 40) }],
};
// A run step two rules read as bash, reported once for each rule, with two stops on one line.
const SNIPPET = (rule) => ({
  code: 3, level: 'warn',
  type: ['PartialParsing', [{ path: '.github/workflows/ci.yml', ...span(180, 32) }, { path: '.github/workflows/ci.yml', ...span(180, 88) }]],
  message: `Syntax error at line .github/workflows/ci.yml:180:\n When parsing a snippet as Bash for metavariable-pattern in rule '${rule}', \`<\` was unexpected`,
  path: '.github/workflows/ci.yml',
  spans: [{ file: '.github/workflows/ci.yml', ...span(180, 32) }, { file: '.github/workflows/ci.yml', ...span(180, 88) }],
});
const LOCAL = { ...WHOLE, message: 'Syntax error at line draft.mjs:12:\n `x` was unexpected', path: 'draft.mjs' };
// Not parse errors: a rule that ran out of time on a file, and a rule Semgrep could not read.
const TIMEOUT = { code: 3, level: 'warn', type: 'Timeout', rule_id: 'javascript.express.security.audit.express-ssrf.express-ssrf', message: 'Timeout when running javascript.express.security.audit.express-ssrf.express-ssrf on scripts/check-docs-drift.mjs:', path: 'scripts/check-docs-drift.mjs' };
const RULE = { code: 7, level: 'error', type: 'Rule parse error', message: 'Invalid rule schema' };

const TRACKED = new Set(['scripts/check-docs-drift.mjs', 'scripts/check-mirror-drift.mjs', 'scripts/dev-cluster.mjs', '.github/workflows/ci.yml']);

test('a tracked file Semgrep refuses whole fails the scan, at the line it names', () => {
  const { failing, untracked, stale } = parseFailures([WHOLE], TRACKED, {});
  assert.deepEqual(failing, [{ path: 'scripts/check-docs-drift.mjs', type: 'Syntax error', lines: [1] }]);
  assert.deepEqual(untracked, []);
  assert.deepEqual(stale, []);
});

test('a tracked file Semgrep parses only in part fails too, at each line its parser stopped at', () => {
  const { failing } = parseFailures([PARTIAL], TRACKED, {});
  assert.deepEqual(failing, [{ path: 'scripts/check-mirror-drift.mjs', type: 'PartialParsing', lines: [4999, 8158] }]);
});

test('the same stop reported by two rules, or twice on one line, is one line', () => {
  const { failing } = parseFailures([SNIPPET('curl-eval'), SNIPPET('gha-curl-pipe-shell')], TRACKED, {});
  assert.deepEqual(failing.map((f) => f.lines), [[180]]);
});

test('an untracked file is reported apart, and does not fail the scan', () => {
  const { failing, untracked } = parseFailures([LOCAL, WHOLE], TRACKED, {});
  assert.deepEqual(failing.map((f) => f.path), ['scripts/check-docs-drift.mjs']);
  assert.deepEqual(untracked, [{ path: 'draft.mjs', type: 'Syntax error', lines: [12] }]);
});

test('with no list of tracked files, every file counts as tracked', () => {
  assert.deepEqual(parseFailures([LOCAL], null, {}).failing.map((f) => f.path), ['draft.mjs']);
});

test('a timeout and a rule error are not parse errors', () => {
  assert.deepEqual(parseFailures([TIMEOUT, RULE], TRACKED, {}), { failing: [], untracked: [], stale: [] });
});

test('an exception allows as many stops as it names: one more fails, one fewer is stale', () => {
  const at = (stretches) => ({ 'scripts/check-mirror-drift.mjs': { stretches, reason: 'r' } });
  assert.deepEqual(parseFailures([PARTIAL], TRACKED, at(2)), { failing: [], untracked: [], stale: [] });
  assert.deepEqual(parseFailures([PARTIAL], TRACKED, at(1)).failing.map((f) => f.lines), [[4999, 8158]]);
  assert.deepEqual(parseFailures([PARTIAL], TRACKED, at(3)).stale, [{ path: 'scripts/check-mirror-drift.mjs', stretches: 3, now: 2 }]);
  assert.deepEqual(parseFailures([], TRACKED, at(2)).stale, [{ path: 'scripts/check-mirror-drift.mjs', stretches: 2, now: 0 }]);
});

test('every exception the scan accepts allows a number of stops and names its reason', () => {
  for (const [path, { stretches, reason }] of Object.entries(UNPARSED)) {
    assert.ok(Number.isInteger(stretches) && stretches > 0, `${path} allows no stops`);
    assert.ok(typeof reason === 'string' && reason.length > 30, `${path} has no reason`);
    assert.doesNotMatch(path, /\.(m?js|jsx|ts|tsx|py)$/, `${path}: a JavaScript, TypeScript or Python file is ours to rewrite`);
  }
});

// ---- Every tracked file read: the ignore list, and paths.scanned against git's list -------------

const IGNORE = ['# a comment, and a blank line', '', 'node_modules', '*.generated.ts', 'deploy/helm/aber/templates/',
  '/top-only', 'build/', ''].join('\n');

test('a name in the ignore list leaves it out at any depth, a path only from the root', () => {
  const left = ignoreRules(IGNORE);
  assert.ok(left('node_modules/react/index.js'));
  assert.ok(left('frontend/node_modules/react/index.js'));
  assert.ok(left('supabase/functions/_shared/gatewayPlatform.generated.ts'));
  assert.ok(left('deploy/helm/aber/templates/tests/test-api.yaml'));
  assert.ok(left('top-only/x.sh'));
  assert.ok(!left('pkg/top-only/x.sh'), 'a pattern with a / matches from the root');
  assert.ok(!left('elsewhere/deploy/helm/aber/templates/a.yaml'));
  assert.ok(!left('pkg/generated.ts'), '* is part of a name, not all of one');
  assert.ok(!left('frontend/src/test/setup.js'));
});

test('a trailing / leaves out a directory, never a file of that name', () => {
  const left = ignoreRules(IGNORE);
  assert.ok(left('frontend/build/app.js'));
  assert.ok(!left('scripts/build'));
});

test('* and ? stay within a name', () => {
  const left = ignoreRules('pkg/*.sh\nlog?.txt\n');
  assert.ok(left('pkg/a.sh'));
  assert.ok(!left('pkg/sub/a.sh'));
  assert.ok(left('deep/log1.txt'));
  assert.ok(!left('deep/log12.txt'));
});

test('syntax Semgrep might read differently from the check is refused', () => {
  for (const line of ['!keep.js', '**/dist', 'a\\ b', '[ab].js', ':include .gitignore', 'trailing ', 'a//b']) {
    assert.throws(() => ignoreRules(`${line}\n`), /uses syntax this check does not read/, line);
  }
});

// A report as Semgrep 1.140.0 writes it, cut to paths.scanned: what a run read.
const REPORT = { paths: { scanned: ['pkg/a.mjs', 'frontend/src/test/setup.js', 'ingestion/sparkplug_b_pb2.py'] } };

test('a tracked file outside the ignore list that Semgrep did not read fails, by path', () => {
  const tracked = ['pkg/a.mjs', 'scripts/check-docs-drift.mjs', 'frontend/src/test/setup.js', 'frontend/src/test/tabBar.js'];
  assert.deepEqual(unscanned(tracked, REPORT.paths.scanned, ignoreRules(IGNORE)), {
    missing: ['frontend/src/test/tabBar.js', 'scripts/check-docs-drift.mjs'],
    ignoredButRead: [],
  });
});

test('a file the ignore list leaves out is not required, and an untracked file read is no fault', () => {
  const tracked = ['pkg/a.mjs', 'frontend/src/test/setup.js', 'deploy/helm/aber/templates/tests/test-api.yaml'];
  assert.deepEqual(unscanned(tracked, REPORT.paths.scanned, ignoreRules(IGNORE)), { missing: [], ignoredButRead: [] });
});

test('a file the ignore list leaves out that Semgrep read anyway says the two read the list differently', () => {
  const tracked = ['pkg/a.mjs', 'frontend/src/test/setup.js'];
  assert.deepEqual(unscanned(tracked, REPORT.paths.scanned, ignoreRules('pkg/\n')), {
    missing: [],
    ignoredButRead: ['pkg/a.mjs'],
  });
});

test('the repository\'s own ignore list reads every test directory but the chart\'s, and gives each pattern a reason', () => {
  const text = readFileSync(join(REPO, IGNORE_FILE), 'utf8');
  const left = ignoreRules(text);
  assert.ok(!left('frontend/src/test/setup.js'), 'Semgrep\'s own list leaves test/ out; this one must not');
  assert.ok(!left('scripts/scan-source.test.mjs'));
  assert.ok(left('deploy/helm/aber/templates/tests/test-api.yaml'));
  assert.ok(left('deploy/helm/aber/templates/apps/frontend.yaml'));
  // Each pattern, or each run of patterns, sits under the comment that gives its reason.
  const lines = text.split(/\r?\n/);
  const isPattern = (line) => line && !line.startsWith('#');
  lines.forEach((line, i) => {
    if (!isPattern(line)) return;
    let above = i - 1;
    while (above >= 0 && isPattern(lines[above])) above -= 1;
    assert.match(lines[above] ?? '', /^# \S/, `${IGNORE_FILE}: "${line}" has no reason above it`);
  });
});
