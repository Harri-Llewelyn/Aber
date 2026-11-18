import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 459. Every generated vocabulary has a seed-sync check, and CI runs the generator and then the check
// in one step. The seed is a block of generated rows with a SHA-256 of its own body, and only the
// check recomputes it: a vocabulary whose check CI never ran could be hand-edited, or generated from
// another source, and still apply cleanly on every boot.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems459 = [];
  const scripts = readdirSync(join(REPO, 'scripts'));
  const generators = scripts.filter((f) => /^generate-[a-z0-9]+-vocabulary\.mjs$/.test(f)).map((f) => f.slice('generate-'.length, -'-vocabulary.mjs'.length));
  if (generators.length < 4) {
    fail(`459: found ${generators.length} vocabulary generators in scripts/, where four existed -- the names changed, so this check is no longer checking anything`);
    return;
  }

  const ci = read('.github/workflows/ci.yml');
  for (const name of generators) {
    if (!scripts.includes(`check-${name}-seed-sync.mjs`)) {
      problems459.push(`scripts/generate-${name}-vocabulary.mjs has no scripts/check-${name}-seed-sync.mjs`);
      continue;
    }
    // The generator's line, and the check's as the next line of the same `run: |` block.
    const generate = `node scripts/generate-${name}-vocabulary.mjs\n`;
    const at = ci.indexOf(generate);
    const next = at < 0 ? '' : ci.slice(at + generate.length).trimStart();
    if (at < 0 || !next.startsWith(`node scripts/check-${name}-seed-sync.mjs\n`)) {
      problems459.push(`.github/workflows/ci.yml does not run generate-${name}-vocabulary.mjs and then check-${name}-seed-sync.mjs in one step`);
    }
  }
  const checks = scripts.filter((f) => /^check-[a-z0-9]+-seed-sync\.mjs$/.test(f)).map((f) => f.slice('check-'.length, -'-seed-sync.mjs'.length));
  for (const name of checks.filter((c) => !generators.includes(c))) {
    problems459.push(`scripts/check-${name}-seed-sync.mjs has no generator, scripts/generate-${name}-vocabulary.mjs`);
  }

  if (problems459.length) {
    fail('the generated vocabularies and the CI steps that guard them disagree:\n' + problems459.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`each of the ${generators.length} generated vocabularies (${generators.join(', ')}) has a seed-sync check that CI runs straight after its generator`);
  }
}
