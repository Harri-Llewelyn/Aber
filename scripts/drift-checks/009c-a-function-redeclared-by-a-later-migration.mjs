import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 9c. A function redeclared by a later migration is deliberate, not accidental.
//
// Migrations replay on every boot in filename order with no ledger, so a later `CREATE OR REPLACE
// FUNCTION` of the same name wins silently. A marker in the header comment of the migration that
// redefines it is where "yes, I meant to replace that" is written down:
// `-- Redefines public.<fn>: <why>`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';

  const files = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const seen = new Map();
  for (const name of files) {
    for (const m of read(`${dir}/${name}`).matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(/gi)) {
      const fn = m[1].toLowerCase();
      if (!seen.has(fn)) seen.set(fn, []);
      if (!seen.get(fn).includes(name)) seen.get(fn).push(name);
    }
  }

  // `-- Redefines public.<fn>: <why>` in a migration's header comment says that migration redefines
  // <fn> on purpose, and why; a reason too long for a line wraps onto lines that start `--   `. The
  // baseline is generated from a dump of the finished database, so every function appears in it once,
  // in its final form; a marker is made by a later migration that deliberately replaces a definition.
  // Only the header is read: a comment inside a function body changes the function's stored source.
  const INTENDED_REDECLARATIONS = {};
  const misplaced = [];
  for (const name of files) {
    let current = null;
    for (const line of read(`${dir}/${name}`).split('\n')) {
      if (line.trim() && !line.startsWith('--')) break;
      const marker = line.match(/^-- Redefines ([a-z_]+\.[a-z_]+): (.*)$/);
      const more = current && line.match(/^-- {3}(\S.*)$/);
      if (marker) {
        const fn = marker[1].toLowerCase();
        current = { fn, name, reason: marker[2] };
        (INTENDED_REDECLARATIONS[fn] ||= []).push(current);
        if (!(seen.get(fn) || []).includes(name)) misplaced.push(`${name} says it redefines ${fn}(), which it does not declare`);
      } else if (more) {
        current.reason += ` ${more[1]}`;
      } else {
        current = null;
      }
    }
  }
  const unexplained = Object.values(INTENDED_REDECLARATIONS).flat()
    .filter((m) => !m.reason.trim()).map((m) => `${m.name} says it redefines ${m.fn}() and gives no reason`);

  const undeclared = [];
  const stale = [];
  for (const [fn, where] of seen) {
    if (where.length > 1 && !(fn in INTENDED_REDECLARATIONS)) {
      undeclared.push(`${fn}() is declared in ${where.length} applied migrations (${where.join(', ')}) but no migration's header comment says it is redefined on purpose`);
    }
  }
  for (const fn of Object.keys(INTENDED_REDECLARATIONS)) {
    const where = seen.get(fn) || [];
    if (where.length < 2) {
      stale.push(`${fn}() has a "-- Redefines" marker but is declared ${where.length} time(s) -- remove the marker`);
    }
  }

  // -----------------------------------------------------------------------------------------
  // A redeclaration may not change the return type. The chain replays in filename order, so
  // 0001 re-declares its own version first with CREATE OR REPLACE, which cannot change a return
  // type, and the later file's DROP never runs: the next boot dies at file one, and nothing after
  // it is applied. A new argument is a new signature and is fine; the
  // same signature with a different return type is not, and it is invisible until the second
  // boot.
  const returnTypes = new Map();
  for (const name of files) {
    const body = read(`${dir}/${name}`);
    for (const m of body.matchAll(
      /CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([^\n]+?)(?:\s+LANGUAGE|\s*$)/gim
    )) {
      const fn = m[1].toLowerCase();
      const ret = m[3].trim().replace(/\s+/g, ' ').replace(/;$/, '');
      if (!returnTypes.has(fn)) returnTypes.set(fn, []);
      returnTypes.get(fn).push({ file: name, ret });
    }
  }

  const returnDrift = [];
  for (const [fn, decls] of returnTypes) {
    if (decls.length < 2) continue;
    const distinct = [...new Set(decls.map((d) => d.ret))];
    if (distinct.length > 1) {
      returnDrift.push(
        `${fn}() is declared with ${distinct.length} different return types across ` +
          `${decls.map((d) => `${d.file} -> ${d.ret}`).join(' | ')}. CREATE OR REPLACE cannot ` +
          'change a return type, so on the SECOND boot the earlier file aborts the whole chain -- ' +
          'with nothing after 0001 applied. Give the new shape its own function ' +
          'name instead, as 0078 does.'
      );
    }
  }
  for (const p of returnDrift) fail(p);
  if (!returnDrift.length && returnTypes.size) {
    pass(`no function changes its return type across the ${returnTypes.size} declared in the chain`);
  }

  if (undeclared.length || stale.length || misplaced.length || unexplained.length) {
    for (const p of [...undeclared, ...stale, ...misplaced, ...unexplained]) fail(p);
    fail(
      'Every migration is replayed on every boot in filename order and there is no applied-migrations\n' +
        '      ledger, so the LAST declaration wins -- silently, with no error. A redeclaration is fine when\n' +
        '      it is meant; put "-- Redefines public.<fn>: <why>" in the header comment of the migration that\n' +
        '      redefines it. The docs/architecture.md note "The\n' +
        '      archive has no 0017" is the case where an unrecorded one would have regressed audit attribution.'
    );
  } else {
    pass(`${seen.size} function(s) declared across the chain; all ${Object.keys(INTENDED_REDECLARATIONS).length} redeclarations are recorded as intended`);
  }
}
