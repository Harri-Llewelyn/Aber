/**
 * What the mirror checks share: the applied migration chain and the helpers that read it. Each check
 * is a module of this directory that imports what it needs from here;
 * scripts/check-mirror-drift.mjs runs them in number order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const read = (p) => readFileSync(join(ROOT, p), 'utf8');

export const problems = [];

export const ok = [];

/**
 * The whole applied chain, in filename order, the order db-init replays it in. There is no
 * applied-migrations ledger, so a later `CREATE OR REPLACE FUNCTION` of the same name wins, and a
 * guard reading an earlier definition reports an agreement it did not check. `archive/` stays out:
 * readdirSync is top-level only.
 */
export const MIGRATION_DIR = 'supabase/migrations';

export const MIGRATION_FILES = readdirSync(join(ROOT, MIGRATION_DIR))
  .filter((name) => /^[0-9]{4}_.*\.sql$/.test(name))
  .sort();

if (MIGRATION_FILES.length === 0) {
  console.error('No applied migrations found in supabase/migrations/. Nothing to check against.');
  process.exit(1);
}

/** The example metrics db-init applies on request (dbInit.exampleMetrics). No migration seeds one. */
export const EXAMPLES = read('supabase/example-metrics.sql');

/** Every applied migration, in replay order, each headed by a marker naming its file. */
export const SCHEMA = MIGRATION_FILES
  .map((name) => `-- >>> ${name}\n${read(`${MIGRATION_DIR}/${name}`)}`)
  .join('\n');

/**
 * The body of the last definition matching `needle`, and which migration it came from. Last,
 * because an earlier declaration is overwritten on every boot. `endMarker` bounds the body (`$$;`
 * for a function, `;` for a plain view), since 0001 carries unrelated `INTERVAL` literals.
 * `redeclarations` is reported so the output says which file was read.
 */
export const lastDefinition = (needle, endMarker, what) => {
  const at = SCHEMA.lastIndexOf(needle);
  if (at < 0) {
    problems.push(
      `could not find ${what} in any applied migration -- the file's shape changed, so this check is no longer checking anything`
    );
    return null;
  }
  const stop = SCHEMA.indexOf(endMarker, at);
  const preceding = SCHEMA.slice(0, at);
  const marker = preceding.lastIndexOf('-- >>> ');
  const file = marker < 0 ? '(unknown)' : preceding.slice(marker + 7, preceding.indexOf('\n', marker));
  let redeclarations = 0;
  for (let i = SCHEMA.indexOf(needle); i >= 0; i = SCHEMA.indexOf(needle, i + 1)) redeclarations += 1;
  return { body: SCHEMA.slice(at, stop < 0 ? undefined : stop), file, redeclarations };
};

export const need = (source, re, what) => {
  const m = source.match(re);
  if (!m) {
    problems.push(`could not find ${what} — the file's shape changed, so this check is no longer checking anything`);
    return null;
  }
  return m;
};

export const compare = (mirror, label, jsValue, sqlValue) => {
  if (String(jsValue) !== String(sqlValue)) {
    problems.push(`${mirror}: ${label} disagree — JS has ${JSON.stringify(jsValue)}, SQL has ${JSON.stringify(sqlValue)}`);
  } else {
    ok.push(`${mirror}: ${label} = ${JSON.stringify(jsValue)}`);
  }
};
