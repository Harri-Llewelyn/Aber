#!/usr/bin/env node
/**
 * Generate the VDA 5050 vocabulary migration from the JSON Schema of its `state` message.
 *
 *   node scripts/generate-vda5050-vocabulary.mjs
 *
 * Source: scripts/vocabularies/vda5050-3.0.0-state.schema, a byte-for-byte copy of
 * `json_schemas/state.schema` at tag 3.0.0 of github.com/VDA5050/VDA5050 (2026-03-18). The
 * repository is MIT, copyright 2024 Verband der Automobilindustrie, and its text is beside the file
 * (LICENSE-vda5050-MIT.txt). The VDA's README says its published PDF prevails where the two
 * differ: this reads the machine-readable half and claims nothing about conformance.
 *
 * The walk, and what it keeps and leaves out, are in scripts/lib/vda5050-vocabulary.mjs. This file
 * pins the source, renders the rows and writes the block.
 *
 * THE BLOCK IS IN 0302, NOT 0002. 0002 is released, and this vocabulary arrived after it, in a table
 * of its own (docs/vocabularies.md). scripts/check-vda5050-seed-sync.mjs recomputes the digest the
 * block carries, and CI runs this generator first, which fails on a source that has moved.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vocabularyRows } from './lib/vda5050-vocabulary.mjs';

/** Pinned by content: a different file is refused rather than read. */
const SCHEMA_FILE = 'scripts/vocabularies/vda5050-3.0.0-state.schema';
const SCHEMA_SHA256 = 'f00d6620e0d1d20efa99f8ce3bd1a25a578f0c01e96cc9b52548259f4847d307';
const VDA_VERSION = '3.0.0';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_FILE = 'supabase/migrations/0302_an_agv_reading_has_a_vocabulary.sql';
const BEGIN_MARKER = '-- >>> BEGIN GENERATED vda5050_vocabulary';
const END_MARKER = '-- <<< END GENERATED vda5050_vocabulary';

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
const orNull = (value, render) => (value === null ? 'NULL' : render(value));

const source = readFileSync(join(ROOT, SCHEMA_FILE));
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== SCHEMA_SHA256) {
  throw new Error(
    `${SCHEMA_FILE} is sha256:${sourceSha256}, pinned to sha256:${SCHEMA_SHA256}. A new release is ` +
    `read (its diff, its licence, the fields it adds) before the pin moves.`
  );
}
const rows = vocabularyRows(JSON.parse(source.toString('utf8')));

/**
 * One statement per row, as the other generated seeds are, so a regeneration is a clean diff. A row
 * is rewritten only where something differs: db-init replays this file on every boot, and a settled
 * database should write nothing.
 */
const statement = (row) =>
  `INSERT INTO public.vda5050_vocabulary VALUES (${sqlString(row.name)}, ${sqlString(row.datatype)}, ` +
  `${orNull(row.unit, sqlString)}, ${orNull(row.description, sqlString)}, ` +
  `${orNull(row.permittedValues, (values) => `ARRAY[${values.map(sqlString).join(', ')}]`)}, ` +
  `${sqlString(row.semanticId)})\n` +
  `ON CONFLICT (name) DO UPDATE SET\n` +
  `  datatype         = EXCLUDED.datatype,\n` +
  `  unit             = EXCLUDED.unit,\n` +
  `  description      = EXCLUDED.description,\n` +
  `  permitted_values = EXCLUDED.permitted_values,\n` +
  `  semantic_id      = EXCLUDED.semantic_id\n` +
  ` WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,\n` +
  `        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)\n` +
  `       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,\n` +
  `                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);`;

const body = rows.map(statement).join('\n');
const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
const header =
  `${BEGIN_MARKER} -- VDA 5050 ${VDA_VERSION}, ${rows.length} rows, sha256:${digest}\n` +
  `-- GENERATED from ${SCHEMA_FILE} by scripts/generate-vda5050-vocabulary.mjs.\n` +
  `-- Do not edit these rows by hand: change the script and re-run it. CI verifies the digest above.`;

// Normalised, as the check reads it: a CRLF checkout would otherwise mix the file's line endings.
const migration = readFileSync(join(ROOT, MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
const beginAt = migration.indexOf(BEGIN_MARKER);
const endAt = migration.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  throw new Error(`markers not found in ${MIGRATION_FILE}. Expected a block delimited by:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`);
}
writeFileSync(
  join(ROOT, MIGRATION_FILE),
  migration.slice(0, beginAt) + header + '\n' + body + '\n' + migration.slice(endAt),
  'utf8'
);

const byDatatype = rows.reduce((counts, row) => ({ ...counts, [row.datatype]: (counts[row.datatype] || 0) + 1 }), {});
console.log(`VDA 5050 ${VDA_VERSION}: wrote ${rows.length} rows into ${MIGRATION_FILE}`);
console.log(`  sha256:${digest}`);
console.log(`  ${Object.entries(byDatatype).map(([type, count]) => `${count} ${type}`).join(', ')}; ` +
            `${rows.filter(row => row.permittedValues).length} with permitted values`);
