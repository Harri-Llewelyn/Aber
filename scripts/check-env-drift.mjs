#!/usr/bin/env node
// =================================================================================================
// Environment drift: between docker-compose.yml and .env.example, and between .env.example and a
// developer's working .env.
//
// NOTHING CHECKED EITHER DIRECTION BEFORE THIS. A working `.env` accumulates keys that were retired
// from the template and misses keys that were added to it, and both fail silently: Compose
// substitutes its own default and the stack comes up looking correct while running on a value
// nobody chose. `VITE_ALLOW_SIGNUP` is the worked example -- a frontend flag that was removed
// outright once it was understood not to be an access control, and which still sits in working
// `.env` files doing nothing.
//
// TWO CHECKS, AND ONLY ONE OF THEM CAN RUN IN CI. That asymmetry is the whole design:
//
//   A. compose -> template.   Every variable Compose REQUIRES must be declared in .env.example.
//                             Runs everywhere, including CI, because both files are committed.
//
//   B. template <-> .env.     Both directions. Can only run where a `.env` exists, which is a
//                             developer's machine and never CI -- `.env` is gitignored, and it
//                             holds real credentials precisely so it is not.
//
// Check B is therefore ADVISORY BY CONSTRUCTION and this script says so rather than pretending
// otherwise. A guard that silently no-ops in the place it is enforced is worse than no guard: it
// reports "ok" in CI for a property it did not examine. So B skips loudly, and A is the one wired
// into the pipeline.
//
// WHY A IS SCOPED TO *REQUIRED* VARIABLES rather than to everything Compose reads. 88 variables are
// referenced in docker-compose.yml and 66 are declared in the template; the 22-way difference is
// almost entirely internal tuning knobs with safe defaults -- I3X_PORT, PROMETHEUS_PORT,
// NODE_RED_FORCE_SEED. Demanding those be documented would bloat the template with settings nobody
// sets and train everyone to add entries to silence a check, which is how an allow-list becomes
// meaningless. A variable written `${VAR}` with NO default is different in kind: Compose
// substitutes empty, and the failure is silent and downstream. That set is currently EMPTY of
// violations, which is what makes this worth asserting -- it is an invariant that holds today and
// would be broken by the ordinary act of adding a required variable and forgetting the template.
//
// Usage:  node scripts/check-env-drift.mjs
// Exit:   0 = no enforceable drift (advisory findings may still be printed), 1 = check A failed.
// =================================================================================================
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

const compose = read('docker-compose.yml');
const template = read('.env.example');
const declared = declaredIn(template);

// -------------------------------------------------------------------------------------------------
// A. Every variable Compose requires is declared in the template.
// -------------------------------------------------------------------------------------------------
// A name counts as OPTIONAL if ANY reference supplies a default (`${VAR:-x}` or `${VAR-x}`), because
// one defaulted reference is enough to keep the stack up. Only a name that is defaulted NOWHERE is
// required. Collecting both sets and subtracting is why this is not a single regex.
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

// -------------------------------------------------------------------------------------------------
// B. The working .env against the template, both directions. Advisory; local only.
// -------------------------------------------------------------------------------------------------
if (!existsSync(join(REPO, '.env'))) {
  note('no .env in this checkout -- skipping the working-file comparison (expected in CI)');
} else {
  const working = declaredIn(read('.env'));

  // MISSING: in the template, absent from the working file. The stack still starts, on whatever
  // Compose defaults to, which is the failure this is here to make visible.
  const missing = [...declared].filter((v) => !working.has(v)).sort();

  // EXTRA splits in two, and the distinction is the useful part of this check. A name Compose still
  // reads is one the TEMPLATE is missing; a name nothing reads is a dead key in the working file.
  // Reporting them together would put a template bug and a stale local setting under one heading.
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
