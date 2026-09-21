#!/usr/bin/env node
/**
 * Generate the MTConnect vocabulary migration from the published MTConnect JSON Schema.
 *
 * The vocabulary is large (249 data item types, 123 subtypes, 100 units, 128 components) and is
 * maintained by the MTConnect Institute, not by us. Transcribing it by hand would be both
 * error-prone and unauditable, so the migration is generated and the generator is committed
 * alongside it: to adopt a newer MTConnect release, bump SCHEMA_URL and re-run.
 *
 *   node scripts/generate-mtconnect-vocabulary.mjs
 *
 * Source: https://github.com/mtconnect/schema -- Apache-2.0, which permits redistribution of
 * these values in a derived work. Note this is distinct from the MTConnect *specification*
 * documents, which carry separate terms, and from the Implementer License required to claim
 * MTConnect compliance in a product. Adopting the vocabulary is not a compliance claim.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = '2.8';
const SCHEMA_URL =
  `https://raw.githubusercontent.com/mtconnect/schema/master/MTConnectDevices_${SCHEMA_VERSION}_draft-04.schema.json`;

/**
 * THE LIVE SEED (`0002`), AND IT HAS TO BE. `supabase-db-init` globs `/migrations/*.sql`, which
 * does not recurse, so anything written into `archive/` is never executed -- and the documented
 * procedure for adopting a newer MTConnect release ("bump SCHEMA_VERSION and re-run") would change
 * nothing on any database and say so nowhere. The archived file is a historical record, not an
 * output, and is never written here.
 *
 * Only the delimited block is rewritten. Everything else in 0002 — the commentary above the block,
 * the ISO 22400 and OPC UA vocabularies, every operator-facing row — is hand-maintained and must
 * survive regeneration untouched.
 */
const SEED = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'supabase', 'migrations', '0002_seed_data.sql'
);
const BEGIN_MARKER = '-- >>> BEGIN GENERATED mtconnect_vocabulary';
const END_MARKER = '-- <<< END GENERATED mtconnect_vocabulary';

/**
 * The semantic id for a vocabulary entry.
 *
 * THIS IS WHY THE GENERATOR COULD NOT PREVIOUSLY WRITE THE SEED. It emitted only
 * `(kind, name, category)`, while the seeded rows carry `semantic_id` too — backfilled by the old
 * archived migration 0032 in a separate pass — so splicing its output in would have silently dropped every
 * semantic id on a fresh database. Emitting the fourth column here is what makes the seed
 * generable at all; it is not a convenience.
 *
 * The form matches 0032's SQL expression exactly, and both are mirrored by `mtconnectSemanticId()`
 * in `frontend/src/utils/standards.js`:
 *
 *     https://acs-cymru.local/semantics/mtconnect/v2.0/<Kind>/<name>
 *
 * SCOPED BY KIND, because a component and a data item type could share a name and `(kind, name)`
 * is the table's key. **The namespace pins `v2.0`, the major line — deliberately NOT
 * SCHEMA_VERSION.** An id that changed every time the vocabulary was regenerated would defeat the
 * point of being a stable handle, and `semantic_id` is the one column downstream systems key on.
 *
 * The namespace is `acs-cymru.local` and must stay that way: an id under `mtconnect.org` would
 * assert an interoperability nobody has agreed to. See the header of
 * supabase/migrations/archive/20260101000029_semantic_identifiers.sql.
 */
const KIND_SEGMENT = {
  DATA_ITEM_TYPE: 'DataItemType',
  SUB_TYPE: 'SubType',
  UNIT: 'Unit',
  NATIVE_UNIT: 'NativeUnit',
  COMPONENT: 'Component',
};
const SEMANTIC_BASE = 'https://acs-cymru.local/semantics/mtconnect/v2.0';
const semanticId = (kind, name) => {
  const segment = KIND_SEGMENT[kind];
  if (!segment) throw new Error(`no semantic-id segment defined for kind: ${kind}`);
  return `${SEMANTIC_BASE}/${segment}/${clean(name)}`;
};

/** Enum values sometimes carry regex escaping (e.g. "DEGREE/SECOND\\^2"). */
const clean = (value) => value.replace(/\\/g, '');
const sqlString = (value) => `'${clean(value).replace(/'/g, "''")}'`;

/** Enums live inside a `oneOf` wrapper in this schema, not directly on the definition. */
function enumOf(defs, name) {
  const node = defs[name];
  if (!node) throw new Error(`definition not found: ${name}`);
  for (const candidate of [...(node.oneOf ?? []), node]) {
    if (Array.isArray(candidate.enum)) return candidate.enum.map(clean);
  }
  throw new Error(`no enum on definition: ${name}`);
}

/**
 * Structural components are the definitions that can themselves carry DataItems -- that is what
 * makes them a place a metric can live, and therefore a metric-name prefix. `Component` is the
 * abstract base and `Device` is the root rather than a path segment, so neither is a group.
 */
function componentsOf(defs) {
  const excluded = new Set(['Component', 'Device']);
  return Object.entries(defs)
    .filter(([name, node]) =>
      !excluded.has(name) && !name.endsWith('Enum') && JSON.stringify(node).includes('"DataItems"'))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

const response = await fetch(SCHEMA_URL);
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${SCHEMA_URL}`);
const schema = await response.json();
const defs = schema.definitions;

const dataItemTypes = [
  ...enumOf(defs, 'SampleEnum').map(name => [name, 'SAMPLE']),
  ...enumOf(defs, 'EventEnum').map(name => [name, 'EVENT']),
  ...enumOf(defs, 'ConditionEnum').map(name => [name, 'CONDITION'])
].sort((a, b) => a[0].localeCompare(b[0]));

const subTypes = enumOf(defs, 'DataItemSubTypeEnum').sort();
const units = enumOf(defs, 'UnitEnum').sort();
const nativeUnits = enumOf(defs, 'NativeUnitEnum').sort();
const components = componentsOf(defs);

// A type may legitimately appear in more than one category; the primary key would reject the
// duplicate silently under ON CONFLICT, so fail loudly instead of shipping a truncated vocabulary.
const seen = new Set();
for (const [name] of dataItemTypes) {
  if (seen.has(name)) throw new Error(`duplicate data item type across categories: ${name}`);
  seen.add(name);
}

/**
 * One statement per row, matching the seed's existing form exactly.
 *
 * NOT a single multi-row INSERT. The per-row form is what 0002 already contains, so regenerating
 * produces a clean diff rather than rewriting 598 lines into 3, and each row carries its own
 * `ON CONFLICT`, which is what lets the seed replay on every boot.
 *
 * `DO UPDATE SET category` ONLY, and that asymmetry is deliberate and load-bearing. `category` is
 * upstream fact and should be corrected on an existing database when MTConnect changes it.
 * `semantic_id` is an assertion that gets corrected BY HAND, so re-stamping it on every boot would
 * make a hand-entered crosswalk permanently unfixable — the row would revert on the next restart.
 * New rows still get their generated id on insert; existing ones keep whatever they hold.
 */
const statement = (kind, name, category) =>
  `INSERT INTO public.mtconnect_vocabulary VALUES (${sqlString(kind)}, ${sqlString(name)}, ` +
  `${category ? sqlString(category) : 'NULL'}, ${sqlString(semanticId(kind, name))})\n` +
  `ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;`;

const rows = [
  ...dataItemTypes.map(([name, category]) => statement('DATA_ITEM_TYPE', name, category)),
  ...subTypes.map(name => statement('SUB_TYPE', name, null)),
  ...units.map(name => statement('UNIT', name, null)),
  ...nativeUnits.filter(n => !units.includes(n)).map(name => statement('NATIVE_UNIT', name, null)),
  ...components.map(name => statement('COMPONENT', name, null))
];

/**
 * Splice the rows into the seed, between the markers, leaving every other byte of the file alone.
 *
 * The block is stamped with the schema version, the row count and a SHA-256 of its own body.
 * `scripts/check-mtconnect-seed-sync.mjs` recomputes that digest in CI, which is what detects a
 * hand-edited vocabulary — the thing the header two lines above the block asks nobody to do.
 *
 * A DIGEST RATHER THAN A SECOND COPY TO DIFF AGAINST. The previous check compared this file's
 * archived output with the seed, which is why it went on passing while the generator wrote
 * somewhere that never ran: both files were consistent and neither was live. A digest has nothing
 * to be consistent WITH except the thing that actually executes, and needs no network in CI —
 * re-running the generator would fetch from GitHub and make the pipeline depend on an upstream
 * host being reachable.
 */
const body = rows.join('\n');
const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
const header =
  `${BEGIN_MARKER} -- MTConnect ${SCHEMA_VERSION}, ${rows.length} rows, sha256:${digest}\n` +
  `-- GENERATED. Do not edit these rows by hand: bump SCHEMA_VERSION in\n` +
  `-- scripts/generate-mtconnect-vocabulary.mjs and re-run it. CI verifies the digest above.`;

// Normalised, matching scripts/check-mtconnect-seed-sync.mjs. Git checks this file out as CRLF on
// Windows; splicing an LF block into a CRLF file would produce a mixed-ending seed whose digest is
// over neither, so regenerating on Windows would emit a stamp CI then rejected.
const seed = readFileSync(SEED, 'utf8').replace(/\r\n/g, '\n');
const beginAt = seed.indexOf(BEGIN_MARKER);
const endAt = seed.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  throw new Error(
    `markers not found in ${SEED}. Expected a block delimited by:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`
  );
}
const lineEnd = seed.indexOf('\n', beginAt);
const updated = seed.slice(0, beginAt) + header + '\n' + body + '\n' + seed.slice(endAt);
writeFileSync(SEED, updated, 'utf8');

console.log(`MTConnect ${SCHEMA_VERSION}: wrote ${rows.length} rows into supabase/migrations/0002_seed_data.sql`);
console.log(`  sha256:${digest}`);
console.log(`  ${dataItemTypes.length} data item types, ${subTypes.length} subtypes, ${units.length} units, ` +
            `${nativeUnits.filter(n => !units.includes(n)).length} native units, ${components.length} components`);
