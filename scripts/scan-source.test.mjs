// =================================================================================================
// scripts/scan-source.mjs: which of Semgrep's errors fail the scan
//
// The part that needs no Docker. The parse errors are Semgrep 1.140.0's `scan --json`, from its runs
// on this repository's files before they parsed, with the messages cut and the paths varied. The
// timeout and the rule error follow Semgrep's schema for those types.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UNPARSED, parseFailures } from './scan-source.mjs';

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
