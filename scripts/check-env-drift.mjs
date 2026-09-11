#!/usr/bin/env node
// Environment drift: between docker-compose.yml and .env.example, and between .env.example and a
// developer's working .env. Two checks: A, every variable Compose requires must be declared in
// .env.example, runs everywhere including CI; B, template against .env in both directions, runs
// only where a `.env` exists, so it is advisory and skips loudly in CI rather than reporting ok for
// a property it did not examine. A is scoped to required variables, those written `${VAR}` with no
// default: Compose substitutes empty for those and the failure is silent and downstream, whereas
// the defaulted tuning knobs would bloat the template.
//
// Usage: node scripts/check-env-drift.mjs. Exit: 0 = no enforceable drift (advisory findings may
// still be printed), 1 = check A failed.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let failed = false;
const fail = (msg) => { failed = true; console.error(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);
const note = (msg) => console.log(`  --    ${msg}`);

/** Variable names assigned in a dotenv-style file. Comments and blanks ignored. */
const declaredIn = (text) =>
  new Set([...text.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));

// `$$` is Compose's escape for a literal `$`: `$${VAR}` reaches the container shell untouched and
// is not a Compose variable, so those references are removed before the scan.
const compose = read('docker-compose.yml').replace(/\$\$/g, '');
const template = read('.env.example');
const declared = declaredIn(template);

// A. Every variable Compose requires is declared in the template. A name counts as optional if any
// reference supplies a default (`${VAR:-x}` or `${VAR-x}`); only a name defaulted nowhere is
// required.
{
  const optional = new Set();
  const referenced = new Set();
  for (const m of compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(:?[-?])?/g)) {
    referenced.add(m[1]);
    if (m[2]) optional.add(m[1]);
  }
  const required = [...referenced].filter((v) => !optional.has(v));
  const missing = required.filter((v) => !declared.has(v)).sort();

  if (missing.length) {
    fail(
      `docker-compose.yml requires ${missing.length} variable(s) with no default that .env.example ` +
        `does not declare: ${missing.join(', ')}.\n` +
        '        Compose substitutes an empty string for these, so a fresh clone starts a stack\n' +
        '        that is misconfigured rather than one that refuses to start. Add them to\n' +
        '        .env.example, or give the reference in docker-compose.yml a default if the\n' +
        '        variable is genuinely optional.'
    );
  } else {
    pass(
      `all ${required.length} variable(s) docker-compose.yml requires are declared in .env.example ` +
        `(${referenced.size} referenced in total)`
    );
  }
}

// B. The working .env against the template, both directions. Advisory; local only.
if (!existsSync(join(REPO, '.env'))) {
  note('no .env in this checkout -- skipping the working-file comparison (expected in CI)');
} else {
  const working = declaredIn(read('.env'));

  // MISSING: in the template, absent from the working file. The stack still starts, on whatever
  // Compose defaults to, which is the failure this is here to make visible.
  const missing = [...declared].filter((v) => !working.has(v)).sort();

  // EXTRA splits in two: a name Compose still reads is one the template is missing; a name nothing
  // reads is a dead key in the working file.
  const extra = [...working].filter((v) => !declared.has(v)).sort();
  const stillRead = extra.filter((v) => new RegExp(`\\$\\{${v}[^A-Z0-9_]`).test(compose));
  const dead = extra.filter((v) => !stillRead.includes(v));

  if (!missing.length && !extra.length) {
    pass('.env and .env.example declare the same variables');
  }
  if (missing.length) {
    note(
      `.env is missing ${missing.length} variable(s) the template declares: ${missing.join(', ')}\n` +
        '        These fall through to the docker-compose.yml default, which may not be what this\n' +
        '        deployment intends. Copy them across and set them deliberately.'
    );
  }
  if (stillRead.length) {
    note(
      `.env sets ${stillRead.length} variable(s) that docker-compose.yml reads but the template ` +
        `does not document: ${stillRead.join(', ')}\n` +
        '        This is drift in the TEMPLATE, not in the working file -- a fresh clone would\n' +
        '        silently take the Compose default. Consider adding them to .env.example.'
    );
  }
  if (dead.length) {
    note(
      `.env sets ${dead.length} variable(s) that nothing in docker-compose.yml reads: ` +
        `${dead.join(', ')}\n` +
        '        Retired from the template and doing nothing. Safe to delete from .env.'
    );
  }
}

console.log(
  failed
    ? '\nEnvironment drift found. See above.'
    : '\nNo enforceable environment drift.'
);
process.exit(failed ? 1 : 0);
