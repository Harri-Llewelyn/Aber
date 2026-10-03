#!/usr/bin/env node
/**
 * Rewrites a `pg_dump --schema-only` into the idempotent form section 4 of the baseline takes.
 *
 * The first two squashes did this by hand and left nothing behind, so the form had to be
 * re-derived from the previous baseline each time. The rules it applies, each one read off
 * `0001` as it stands:
 *
 *   TABLE        CREATE TABLE IF NOT EXISTS
 *   FUNCTION     CREATE OR REPLACE FUNCTION
 *   VIEW         CREATE OR REPLACE VIEW, or a call to the function that builds it (REBUILT_BY)
 *   INDEX        CREATE [UNIQUE] INDEX IF NOT EXISTS
 *   TRIGGER      DROP TRIGGER IF EXISTS ... ON ...; CREATE TRIGGER ...
 *   POLICY       DROP POLICY IF EXISTS ... ON ...; CREATE POLICY ...
 *   CONSTRAINT   a DO block guarded on pg_constraint -- rule 2, added guarded, never re-added
 *   the rest     already idempotent (GRANT, REVOKE, COMMENT, ALTER ... ENABLE ROW LEVEL SECURITY)
 *
 * MONTHLY PARTITIONS ARE DROPPED ON THE FLOOR. `audit_trail` is partitioned by month and its
 * partitions are created at run time by the function 0079 installs, so the months present on the
 * day the dump was taken are not schema -- baking them in would pin the baseline to a date. The
 * partitioned parent and the DEFAULT partition are kept; `audit_trail_YYYY_MM` and everything
 * attached to it is not.
 *
 * A PARTITION IS WRITTEN AS `PARTITION OF`, NOT AS A TABLE PLUS AN ATTACH. pg_dump splits every
 * partition into five separate objects -- a bare CREATE TABLE with the columns spelled out, a
 * TABLE ATTACH, one INDEX per inherited index, a CONSTRAINT for the inherited primary key, and an
 * INDEX ATTACH per index -- because that order lets it restore a large partitioned table in
 * parallel. Replaying those verbatim builds indexes that are NOT attached to the parent's, which
 * is a different schema wearing the same names. `CREATE TABLE ... PARTITION OF` inherits all of
 * them and attaches them, so the parent's own index blocks do the work and the partition's are
 * dropped.
 *
 * `BETWEEN` IS RESTORED. pg_dump expands `x BETWEEN a AND b` to `((x >= a) AND (x <= b))`, and
 * re-parsing that flattens the pair into the enclosing AND -- so a CHECK written with BETWEEN
 * comes back with a different expression tree and a dump of the result does not match the dump it
 * came from. The expansion is undone only where the dump bracketed it as its own pair, which is
 * exactly where it came from a BETWEEN: a hand-written `x >= a AND x <= b` sitting in a larger
 * AND was flattened by the ORIGINAL parse and is printed without those brackets.
 *
 *   node generate-baseline.mjs <dump.sql> > section4.sql
 */
import { readFileSync } from 'node:fs';

const dump = readFileSync(process.argv[2], 'utf8');

// `\b` does NOT work here: `_` is a word character, so it fails between the month and the rest
// of a name like `audit_trail_2026_09_causation_id_idx`. That let every per-partition index
// through, each one referring to a table this generator had just dropped.
const MONTHLY = /_(?:19|20)\d{2}_(?:0[1-9]|1[0-2])(?!\d)/;

/** pg_dump emits `--\n-- Name: X; Type: T; Schema: S; Owner: O\n--\n\n<stmt>` blocks. */
function blocks(sql) {
  const out = [];
  const re = /^--\r?\n-- Name: (.+?); Type: (.+?); Schema: (.+?); Owner: (.*?)\r?\n--\r?\n/gm;
  const marks = [...sql.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : sql.length;
    let body = sql.slice(start, end);
    // Trailing pg_dump noise between objects.
    body = body.replace(/^\s*\n/, '').replace(/\n+$/, '\n');
    out.push({ name: m[1].trim(), type: m[2].trim(), schema: m[3].trim(), body });
  }
  return out;
}

/**
 * Views a function builds from `SELECT t.*`, emitted as a call to that function instead of as
 * themselves. Postgres freezes the star into a column list at creation, so a stated
 * `CREATE OR REPLACE VIEW` would, on the replay after a later migration widened the table and
 * rebuilt the view, try to drop that column and abort the boot ("cannot drop columns from view").
 */
const REBUILT_BY = { gateway_status: 'public.ensure_gateway_status_view()' };

const esc = (s) => s.replace(/'/g, "''");
const bare = (s) => (s || '').replace(/^public\./, '').replace(/"/g, '');

/**
 * Pass one: which tables are partitions, of what, and on what bound. A CONSTRAINT or INDEX on one
 * of these is inherited from the parent and must not be stated again.
 */
const partitionOf = new Map();
const partitionedParents = new Set();
for (const b of blocks(dump)) {
  if (b.type.toUpperCase() !== 'TABLE ATTACH') continue;
  const m = b.body.match(/ALTER TABLE(?:\s+ONLY)?\s+(\S+)\s+ATTACH PARTITION\s+(\S+)\s+([\s\S]*?);/i);
  if (!m) continue;
  partitionOf.set(bare(m[2]), { parent: m[1], bound: m[3].trim().replace(/\s+/g, ' ') });
  partitionedParents.add(bare(m[1]));
}

/**
 * pg_dump builds a partitioned table's indexes the way a parallel restore needs them: the parent's
 * index is created `ON ONLY` so it does not recurse, each partition's index is created separately,
 * and an INDEX ATTACH marries them. Dropping `ONLY` collapses all three into one statement that
 * recurses -- and the child indexes PostgreSQL then creates carry the same generated names the
 * dump spells out, so the result dumps identically. Left in place, `ON ONLY` would leave the
 * parent's index permanently invalid, because the partitions it is waiting for never attach.
 */
const dropOnly = (s) => s.replace(/^(CREATE (?:UNIQUE )?INDEX [^\n]*? ON )ONLY /m, '$1')
                         .replace(/^ALTER TABLE ONLY /m, 'ALTER TABLE ');

/**
 * Undo pg_dump's expansion of BETWEEN. The brackets are the whole signal: `((x >= a) AND (x <= b))`
 * is a pair the planner kept together, which only happens when the pair arrived as one node --
 * a BETWEEN. A hand-written `x >= a AND x <= b` inside a larger AND was flattened at parse time
 * and prints as `(x >= a) AND (x <= b)` with no brackets of its own, so it is left alone.
 */
function restoreBetween(s) {
  return s.replace(
    /\(\(([\w."]+) >= ([^()]+?)\) AND \(\1 <= ([^()]+?)\)\)/g,
    (_, col, lo, hi) => `(${col} BETWEEN ${lo.trim()} AND ${hi.trim()})`);
}

/**
 * The one thing `CREATE TABLE IF NOT EXISTS` cannot do: reach a table that already exists and is
 * NARROWER than the one described. A dump has no `ALTER TABLE ... ADD COLUMN` in it -- the column
 * is simply part of the CREATE -- so a baseline generated from one describes a fresh install and
 * silently leaves every older database a column short, which surfaces as the first object that
 * references the missing name failing to create. Both earlier squashes shipped with that hole.
 *
 * So each table's columns are restated as ADD COLUMN IF NOT EXISTS, once per table. On a fresh
 * install every clause is a no-op, because the CREATE above has just made them; on an upgrade they
 * add exactly what is missing.
 *
 * TWO THINGS THIS DOES NOT FIX, both worth knowing before trusting it:
 *
 *   * A column added by ALTER lands at the END of the table, where a fresh install has it in
 *     declaration order. The two databases are then the same schema in a different column order,
 *     which a dump records -- so an upgraded database and a fresh one do not share a digest, and
 *     the upgrade rehearsal reports the positions rather than claiming equality.
 *   * `NOT NULL` with no DEFAULT is refused on a populated table, and rightly: the migration that
 *     first added such a column backfilled it, and no rule here can reconstruct the backfill. Each
 *     one is listed on stderr so it is a decision rather than a surprise.
 *
 * Table constraints, LIKE clauses and the partition tail are skipped: only lines that declare a
 * column are lifted.
 */
function widenTable(b, createSql) {
  const m = createSql.match(/^CREATE (?:TABLE|FOREIGN TABLE) IF NOT EXISTS \S+ \(\n([\s\S]*?)\n\)/m);
  if (!m) return null;
  const cols = [];
  const constraints = [];
  for (const raw of splitTopLevel(m[1])) {
    const def = raw.trim();
    if (!def || /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE|LIKE)\b/i.test(def)) continue;
    // An inline table constraint is as unreachable as an inline column: the table exists, so the
    // CREATE is a no-op and the constraint never arrives. Named ones are re-stated guarded;
    // pg_dump names every constraint it writes, so an unnamed one here would be a surprise.
    const con = def.match(/^CONSTRAINT\s+(\S+)\s+([\s\S]+)$/i);
    if (con) { constraints.push([con[1], con[2]]); continue; }
    if (/^CONSTRAINT\b/i.test(def)) continue;
    const name = def.match(/^("[^"]+"|[a-z_][a-z0-9_$]*)\s/i);
    if (!name) continue;
    cols.push(def);
    if (/\bNOT NULL\b/.test(def) && !/\bDEFAULT\b/.test(def) && !/\bGENERATED\b/.test(def)) {
      needBackfill.push(`${b.schema}.${b.name}.${name[1]}`);
    }
  }
  if (!cols.length && !constraints.length) return null;
  const parts = [];
  if (cols.length) {
    parts.push(`ALTER TABLE ${b.schema}.${b.name}\n`
      + cols.map((c) => `    ADD COLUMN IF NOT EXISTS ${c}`).join(',\n') + ';');
    // A DEFAULT that MOVED reaches neither the CREATE (the table exists) nor the ADD COLUMN (the
    // column exists). `gateways.sparkplug_group` is the case that found this: its default was a
    // literal and became a function call, and an upgrade kept the literal for good. Restating it
    // is idempotent and costs nothing on a fresh install. GENERATED columns are skipped -- they
    // have no default to set -- and a column that has LOST its default is dropped explicitly,
    // which is the same statement read the other way.
    const defaults = cols
      .filter((c) => !/\bGENERATED\b/i.test(c))
      .map((c) => {
        const name = c.match(/^("[^"]+"|[a-z_][a-z0-9_$]*)\s/i)[1];
        const d = c.match(/\bDEFAULT\s+([\s\S]+?)(?:\s+NOT NULL)?$/i);
        return d ? `    ALTER COLUMN ${name} SET DEFAULT ${d[1].trim()}`
                 : `    ALTER COLUMN ${name} DROP DEFAULT`;
      });
    if (defaults.length) {
      parts.push(`ALTER TABLE ${b.schema}.${b.name}\n${defaults.join(',\n')};`);
    }
  }
  for (const [name, body] of constraints) {
    parts.push(guardedConstraint(`${b.schema}.${b.name}`, name,
      `ALTER TABLE ${b.schema}.${b.name}\n    ADD CONSTRAINT ${name} ${body};`));
  }
  return parts.join('\n\n');
}

/**
 * Split a CREATE TABLE's body on the commas that separate its entries, which is not the same as
 * splitting on lines or on every comma. `metric_catalog.metric_group` is
 * `GENERATED ALWAYS AS (CASE WHEN ... END) STORED` over five lines with commas inside it, and
 * either simpler rule cuts the expression in half and emits SQL that does not parse.
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0, quoted = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      cur += ch;
      if (ch === "'") { if (body[i + 1] === "'") cur += body[++i]; else quoted = false; }
      continue;
    }
    if (ch === "'") { quoted = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const needBackfill = [];

function rewrite(b) {
  const t = b.type.toUpperCase();
  let s = b.body.trimEnd();
  if (!s) return null;

  // Partition machinery that belongs to run time, not to the schema. The body is checked as well
  // as the name, for an object named after neither -- but not for a function, whose body may
  // legitimately mention a partition it builds.
  if (MONTHLY.test(b.name)) return null;
  if (t !== 'FUNCTION' && t !== 'PROCEDURE' && MONTHLY.test(s)) return null;

  // Folded into the partition's own CREATE, below.
  if (t === 'INDEX ATTACH' || t === 'TABLE ATTACH') return null;

  // `name` is `<table> <constraint>` for a constraint and the index's own name for an index, so
  // both are resolved against the statement's target rather than the block's title. Each form is
  // matched whole: an `ON\s+` with no word boundary finds the `on` that ends `causation` in
  // `idx_audit_trail_causation ON ONLY ...`, and takes `ONLY` for the table name.
  const target = bare(
    (s.match(/^CREATE (?:UNIQUE )?INDEX \S+ ON (?:ONLY )?(\S+)/im)
     || s.match(/^ALTER TABLE (?:ONLY )?(\S+)/im)
     || s.match(/\bON\s+(\S+)/i) || [])[1] || '');
  if (partitionOf.has(target) && t !== 'TABLE' && t !== 'ACL' && t !== 'DEFAULT ACL') return null;
  if (partitionedParents.has(target)) s = dropOnly(s);

  // `public` is shipped by the image and `timescale` by section 3, so both are already there.
  if (t === 'SCHEMA') return s.replace(/^CREATE SCHEMA /m, 'CREATE SCHEMA IF NOT EXISTS ');
  if (t === 'TABLE' || t === 'FOREIGN TABLE') {
    const p = partitionOf.get(bare(b.name));
    if (p) return `CREATE TABLE IF NOT EXISTS ${b.schema}.${b.name} PARTITION OF ${p.parent} ${p.bound};`;
    // A CHECK written inline in the table rather than as its own ALTER still went through the
    // dump's BETWEEN expansion.
    s = restoreBetween(s.replace(/^CREATE (TABLE|FOREIGN TABLE) /m, 'CREATE $1 IF NOT EXISTS '));
    const widen = widenTable(b, s);
    return widen ? `${s}\n\n${widen}` : s;
  }
  if (t === 'FUNCTION' || t === 'PROCEDURE') {
    return s.replace(/^CREATE FUNCTION /m, 'CREATE OR REPLACE FUNCTION ')
            .replace(/^CREATE PROCEDURE /m, 'CREATE OR REPLACE PROCEDURE ');
  }
  if (t === 'VIEW' && REBUILT_BY[b.name] && b.schema === 'public') return `SELECT ${REBUILT_BY[b.name]};`;
  if (t === 'VIEW') return s.replace(/^CREATE VIEW /m, 'CREATE OR REPLACE VIEW ');
  if (t === 'MATERIALIZED VIEW') return s.replace(/^CREATE MATERIALIZED VIEW /m, 'CREATE MATERIALIZED VIEW IF NOT EXISTS ');
  if (t === 'SEQUENCE') return s.replace(/^CREATE SEQUENCE /m, 'CREATE SEQUENCE IF NOT EXISTS ');
  if (t === 'INDEX') return s.replace(/^CREATE (UNIQUE )?INDEX /m, 'CREATE $1INDEX IF NOT EXISTS ');

  if (t === 'TRIGGER') {
    const m = s.match(/CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?\s+TRIGGER\s+(\S+)[\s\S]*?\bON\s+(\S+)/i);
    if (!m) return s;
    return `DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]};\n${s}`;
  }
  if (t === 'POLICY') {
    const m = s.match(/CREATE\s+POLICY\s+("[^"]+"|\S+)\s+ON\s+(\S+)/i);
    if (!m) return s;
    return `DROP POLICY IF EXISTS ${m[1]} ON ${m[2]};\n${s}`;
  }
  if (t === 'CONSTRAINT' || t === 'FK CONSTRAINT' || t === 'CHECK CONSTRAINT') {
    const m = s.match(/ADD\s+CONSTRAINT\s+(\S+)/i);
    const tbl = s.match(/ALTER TABLE(?:\s+ONLY)?\s+(\S+)/i);
    if (!m || !tbl) return s;
    return guardedConstraint(tbl[1], m[1], restoreBetween(s));
  }
  return s;
}

/**
 * Rule 2: added guarded, never dropped and re-added -- the re-add is the scan that fails on a
 * populated table, which is how a squash breaks the second boot rather than the first.
 *
 * THE EXCEPTION, AND IT IS NOT A WEAKENING OF THE RULE. The rule is about re-adding an IDENTICAL
 * constraint. A constraint whose DEFINITION has moved is a different matter: an upgrading database
 * holds `gateways_location_scope_valid` admitting two values where this file admits three, and a
 * guard that only asks whether the NAME exists leaves the narrower rule in force for good --
 * silently, since nothing errors and the constraint looks present. So the definition is compared,
 * and only a disagreement drops. The scan that follows is the point: it is validating the new rule
 * against the existing rows, which is exactly what the migration that widened it did.
 */
function guardedConstraint(table, name, statement) {
  const indented = statement.split('\n').map((l) => (l.trim() ? `    ${l}` : l)).join('\n');
  // `pg_get_constraintdef` renders what the dump's ADD CONSTRAINT clause says, so the two are
  // comparable as text. Anything this cannot parse falls back to the name-only guard.
  const def = statement.match(/ADD CONSTRAINT \S+\s+([\s\S]+?);\s*$/);
  const compare = def
    ? `\n  IF EXISTS (SELECT 1 FROM pg_constraint\n`
      + `              WHERE conname = '${esc(name)}'\n`
      + `                AND conrelid = '${esc(table)}'::regclass\n`
      + `                AND pg_get_constraintdef(oid) <> '${esc(def[1].replace(/\s+/g, ' ').trim())}') THEN\n`
      + `    ALTER TABLE ${table} DROP CONSTRAINT ${name};\n`
      + `  END IF;\n`
    : '';
  return `DO $c$ BEGIN\n${compare}`
       + `  IF NOT EXISTS (SELECT 1 FROM pg_constraint\n`
       + `                  WHERE conname = '${esc(name)}'\n`
       + `                    AND conrelid = '${esc(table)}'::regclass) THEN\n`
       + `${indented}\n`
       + `  END IF;\nEND $c$;`;
}

/**
 * A grant to `grafana_reader` has to survive the role not existing. The role is created only
 * where `BI_READER_PASSWORD` is set, and a dump records the resulting ACL as a bare GRANT that
 * fails with `role "grafana_reader" does not exist` on exactly the deployments the condition
 * exists for. NO PROBE CATCHES THIS: the fixtures set the password, so the role is there.
 */
function guardBiReader(sql) {
  if (!/grafana_reader/.test(sql)) return sql;
  return sql.split('\n').map((line) => {
    if (!/grafana_reader/.test(line) || !/^\s*(GRANT|REVOKE)\b/i.test(line)) return line;
    const stmt = line.trim().replace(/;\s*$/, '');
    return `DO $g$ BEGIN\n`
         + `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN\n`
         + `    EXECUTE '${stmt.replace(/'/g, "''")}';\n`
         + `  END IF;\nEND $g$;`;
  }).join('\n');
}

const out = [];
let kept = 0, dropped = 0, guarded = 0, parts = 0;
for (const b of blocks(dump)) {
  if (/^(SET|SELECT pg_catalog\.set_config)/m.test(b.body.trim()) && !b.name) continue;
  // Default privileges are hand-carried BEFORE section 4, because they apply only to objects
  // created after they run -- and the `supabase_admin` ones cannot be set by `postgres` at all.
  if (b.type.toUpperCase() === 'DEFAULT ACL') { dropped++; continue; }
  let s = rewrite(b);
  if (s === null) { dropped++; continue; }
  if (/PARTITION OF/.test(s)) parts++;
  const before = s;
  s = guardBiReader(s);
  if (s !== before) guarded++;
  kept++;
  out.push(`-- ${b.name} :: ${b.type}\n${s}\n`);
}

// ---------------------------------------------------------------------------------------------
// The declarations this file does NOT make, for names it does
// ---------------------------------------------------------------------------------------------
// `CREATE OR REPLACE FUNCTION` matches on the argument list, so declaring an eleven-argument
// `approve_quarantined_device` leaves a nine-argument one standing beside it and a caller passing
// nine still resolves to the old body. Nothing errors, nothing in a dump of THIS file mentions the
// stale one, and only an upgrade rehearsal shows it -- four of them survived the floor.
//
// NARROWED TO NAMES THIS FILE DECLARES, deliberately. A sweep of everything not on the list would
// also take any function an extension or an operator put in `public`, and this is a squash, not a
// tidy-up. Every name here has exactly one declaration by construction, so a second one is stale.
//
// The signatures come from pg_dump's own `-- Name: foo(integer, text); Type: FUNCTION` headers,
// which are the name and the IN-parameter TYPES. The run-time side is built from `proargtypes`
// for the same reason: `pg_get_function_identity_arguments` includes parameter NAMES
// (`has_role(allowed_roles text[])`), so comparing against it drops every function in the list.
const declared = blocks(dump)
  .filter((b) => ['FUNCTION', 'PROCEDURE'].includes(b.type.toUpperCase()) && b.schema === 'public')
  .map((b) => b.name);
if (declared.length) {
  const names = [...new Set(declared.map((s) => s.replace(/\(.*$/s, '')))].sort();
  out.push(
    '-- stale overloads :: SWEEP\n'
    + 'DO $overloads$\nDECLARE\n    r record;\nBEGIN\n'
    + '    -- SAME search_path pg_dump WROTE THE LIST UNDER, which is none. `format_type` qualifies\n'
    + '    -- a type only when it is not visible, so with `public` on the path a composite argument\n'
    + '    -- renders as `gateways` where the dump says `public.gateways` -- and every function\n'
    + '    -- taking one fails to match its own entry and is dropped. Reverts with the block.\n'
    + "    SET LOCAL search_path TO '';\n\n"
    + '    FOR r IN\n'
    + "        SELECT p.oid::regprocedure AS sig,\n"
    + "               p.proname || '(' || coalesce((SELECT string_agg(format_type(t, NULL), ', ' ORDER BY ord)\n"
    + "                                               FROM unnest(p.proargtypes) WITH ORDINALITY AS a(t, ord)), '')\n"
    + "                          || ')' AS ident\n"
    + '          FROM pg_proc p\n'
    + '          JOIN pg_namespace n ON n.oid = p.pronamespace\n'
    + "         WHERE n.nspname = 'public'\n"
    + `           AND p.proname = ANY (ARRAY[\n${names.map((n) => `               '${esc(n)}'`).join(',\n')}\n           ])\n`
    + '    LOOP\n'
    + `        IF r.ident <> ALL (ARRAY[\n${[...new Set(declared)].sort().map((s) => `            '${esc(s)}'`).join(',\n')}\n        ]) THEN\n`
    + '            EXECUTE format(\'DROP FUNCTION %s\', r.sig);\n'
    + "            RAISE NOTICE 'dropped %, which this baseline does not declare.', r.sig;\n"
    + '        END IF;\n'
    + '    END LOOP;\nEND\n$overloads$;\n');
  kept++;
}

process.stderr.write(
  `kept ${kept} object(s), dropped ${dropped} (monthly partitions, inherited indexes, default ACLs); `
  + `${partitionOf.size} partition(s) seen, ${parts} written as PARTITION OF; ${guarded} grant(s) guarded\n`);
if (needBackfill.length) {
  // NOT a list of problems. These are the columns whose widening clause would be REFUSED if an
  // upgrading database happened to lack that particular column AND hold rows -- PostgreSQL will
  // not add a NOT NULL column with no default to a populated table. On a fresh install, and on
  // any database that already has the column, every one is a no-op. Which of them bites is not
  // knowable from a dump; it depends on how old the database is, and the upgrade rehearsal is
  // what answers it. A count, so the number is watched rather than read.
  process.stderr.write(
    [`  ${needBackfill.length} of those are NOT NULL with no default, so widening a POPULATED table`,
     '  that lacks one would be refused. Run the upgrade rehearsal to find out whether any database',
     "  in scope actually lacks one; if so it needs its original migration's backfill.",
     ''].join('\n'));
}
console.log(out.join('\n--\n\n'));
