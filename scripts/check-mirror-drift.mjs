/**
 * Hold the SQL-to-JavaScript mirrors together by comparing the values both sides declare, not by
 * grepping for a literal's presence, which catches a rewrite and misses a re-tuning. The
 * `modelledMetrics` mirror is behaviour rather than a literal and has a fixture contract instead
 * (`test-harness/fixtures/modelled-metrics.json`).
 *
 * Each check is a module of its own in scripts/mirror-checks/, NNN-name.mjs after its number, that
 * exports a default function. This runs them in number order. What they share is in
 * scripts/mirror-checks/lib.mjs. A new check is a new file; CONTRIBUTING.md says how.
 *
 * Usage: node scripts/check-mirror-drift.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MIGRATION_FILES, ok, problems } from './mirror-checks/lib.mjs';
import { numberedModules } from './lib/numbered-modules.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'mirror-checks');

for (const { file } of numberedModules(DIR)) {
  const { default: check } = await import(pathToFileURL(join(DIR, file)).href);
  if (typeof check !== 'function') throw new Error(`scripts/mirror-checks/${file} exports no default function`);
  await check();
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nSQL-to-JavaScript mirror drift:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThese pairs answer the same question in two languages because one runs in a browser');
  console.error('and one in PostgreSQL. A divergence is silent: both sides keep working, and disagree.');
  process.exit(1);
}
console.log(
  `\nAll ${ok.length} mirrored values agree between the frontend and the applied migration ` +
    `chain (${MIGRATION_FILES.length} files, last definition wins).`
);
