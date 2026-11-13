#!/usr/bin/env node
/**
 * Assert that the documentation's checkable claims still match the repository.
 *
 * Checks counts, lists, links and pinned versions: the parts that rot silently. It does not
 * check reasoning or design narrative, which cannot be verified mechanically.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs            # exit non-zero on drift
 *   node scripts/check-docs-drift.mjs --verbose
 *
 * Each check is a module of its own in scripts/drift-checks/, NNN-name.mjs after its number, that
 * exports a default function. This runs them in number order. What they share is in
 * scripts/drift-checks/lib.mjs. A new check is a new file; CONTRIBUTING.md says how.
 *
 * No YAML dependency: this runs in CI before any `npm install`, and the shapes it reads are narrow.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { allFiles, ok, problems } from './drift-checks/lib.mjs';
import { numberedModules } from './lib/numbered-modules.mjs';

const verbose = process.argv.includes('--verbose');
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'drift-checks');

for (const { file } of numberedModules(DIR)) {
  const { default: check } = await import(pathToFileURL(join(DIR, file)).href);
  if (typeof check !== 'function') throw new Error(`scripts/drift-checks/${file} exports no default function`);
  await check();
}

// -------------------------------------------------------------------------------------------------
for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nDocumentation drift:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nThese are the claims that rot silently -- counts, lists, links and pinned versions. A stale\n' +
      'number is worse than no number: a reader cannot tell it is stale and will act on it.\n'
  );
  process.exit(1);
}
if (verbose) console.log(`\n(${allFiles.filter((f) => f.endsWith('.md')).length} markdown files scanned)`);
console.log('\nDocumentation matches the repository on every checkable claim.');
