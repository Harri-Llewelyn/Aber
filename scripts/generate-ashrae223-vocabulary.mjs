#!/usr/bin/env node
/**
 * Generate the ASHRAE 223P vocabulary migration from the published open223 ontology.
 *
 *   node scripts/generate-ashrae223-vocabulary.mjs
 *
 * Source: scripts/vocabularies/223p-v1.0.0-2026.ttl, a byte-for-byte copy of
 * open223/defs.open223.info -> ontologies/223p.ttl at that release. Upstream no longer serves it:
 * its history was rewritten on 2026-10-16, and the regenerated file declares no licence
 * (docs/vocabularies.md, NOTICE.md). The ontology DECLARES ITS OWN LICENCE in-band, asserted by
 * the rights holder rather than inferred:
 *
 *   <http://data.ashrae.org/standard223/1.0/model/all> a owl:Ontology ;
 *       dcterms:license <http://www.apache.org/licenses/LICENSE-2.0> ;
 *       dcterms:rights "Copyright 2026 ASHRAE" ;
 *       owl:versionInfo "v1.0.0-2026" .
 *
 * That is the same footing generate-mtconnect-vocabulary.mjs relies on for Apache-2.0.
 *
 * ⚠ THE STANDARD ITSELF IS NOT PUBLISHED. ASHRAE 223 is still 223P / 223-202x, in public review.
 * This is a pre-publication ontology release, so a concept may move before the standard is final.
 * The generated migration header says so, and that caveat is the whole reason the version is
 * pinned here rather than tracked to whatever `main` holds today.
 *
 * NOT `open223/Standard223`. The obvious-looking `standard223-core.ttl` in that repository is a
 * 35-byte placeholder, and pointing this script at it would produce an empty vocabulary that looks
 * like a parsing failure.
 *
 * WHY A PARSER RATHER THAN A REGEX. The other generator reads NodeSet2 XML, where a narrow scan is
 * sound. Turtle is not that: **`rdfs:comment` appears INSIDE the nested `sh:property [ ... ]` blank
 * nodes as a SHACL constraint message**, several per class, so a scan would silently describe
 * `s223:Fan` as "A `Fan` shall have at least one outlet using the medium `Fluid-Air`". The reader
 * is scripts/lib/turtle.mjs, which the QUDT generator shares.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSubjects, valuesOf } from './lib/turtle.mjs';

/** Pinned by content: a different file is refused rather than read. */
const ONTOLOGY_FILE = 'scripts/vocabularies/223p-v1.0.0-2026.ttl';
const ONTOLOGY_SHA256 = '47bdad8925032c84e750e46b3649d102f4e41190c8161df3c9efa3265009b0e0';
const ONTOLOGY_VERSION = 'v1.0.0-2026';
const ONTOLOGY_IRI = 'http://data.ashrae.org/standard223/1.0/model/all';

/** The concept namespace. Seeded rows carry `NAMESPACE + localName` as their semantic id. */
const NAMESPACE = 'http://data.ashrae.org/standard223#';

/**
 * Only the `s223:` namespace is seeded.
 *
 * The ontology `owl:imports <http://qudt.org/3.2.1/shacl/qudt-all>` for quantity kinds and units.
 * QUDT is a separate vocabulary under a separate licence, seeded by
 * scripts/generate-qudt-vocabulary.mjs from its own release, so a concept outside s223: is skipped
 * here rather than partially adopted.
 */
const PREFIX = 's223:';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0002_seed_data.sql');
const BEGIN_MARKER = '-- >>> BEGIN GENERATED ashrae223_vocabulary';
const END_MARKER = '-- <<< END GENERATED ashrae223_vocabulary';

/**
 * Whitespace is collapsed, and that is not cosmetic.
 *
 * Several `rdfs:comment` literals are hard-wrapped across lines in the ontology. Emitted verbatim
 * they would put newlines inside a SQL string -- valid SQL, but it breaks the one-statement-per-line
 * shape that the digest, the seed-sync check and every `git diff` of this file assume, and it
 * renders as ragged text in a tooltip that is already one line tall.
 */
const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();
const sqlString = (value) => `'${collapse(value).replace(/'/g, "''")}'`;

const source = readFileSync(join(ROOT, ONTOLOGY_FILE));
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== ONTOLOGY_SHA256) {
  throw new Error(
    `${ONTOLOGY_FILE} is sha256:${sourceSha256}, pinned to sha256:${ONTOLOGY_SHA256}. ASHRAE 223 ` +
    `is still in public review: a new release is reviewed (diff, licence, seed) before the pin moves.`
  );
}
const turtle = source.toString('utf8');

// Everything below is only as trustworthy as the release it was read from, so the file's own
// claims are checked too.
const versionMatch = turtle.match(/owl:versionInfo\s+"([^"]+)"/);
if (!versionMatch) throw new Error('no owl:versionInfo in the ontology; refusing to guess a version');
if (versionMatch[1] !== ONTOLOGY_VERSION) {
  throw new Error(`the ontology says it is ${versionMatch[1]}, pinned to ${ONTOLOGY_VERSION}`);
}
if (!turtle.includes(ONTOLOGY_IRI)) throw new Error(`ontology IRI ${ONTOLOGY_IRI} not found`);
if (!turtle.includes('http://www.apache.org/licenses/LICENSE-2.0')) {
  throw new Error('the ontology no longer declares the Apache-2.0 licence this generator relies on');
}

const concepts = parseSubjects(turtle, PREFIX);

/** `s223:Class` and friends are themselves s223 terms, so the kind is read from rdf:type. */
const KINDS = {
  's223:Class': 'Class',
  's223:AbstractClass': 'AbstractClass',
  's223:Concept': 'Concept',
  's223:Relation': 'Relation',
  's223:RelationWithInverse': 'Relation',
  's223:SymmetricRelation': 'Relation',
  's223:EnumerationKind': 'EnumerationKind'
};

const rows = [];
for (const [name, statements] of [...concepts].sort(([a], [b]) => a.localeCompare(b))) {
  const types = valuesOf(statements, 'rdf:type');
  const kind = types.map((t) => KINDS[t]).find(Boolean);
  if (!kind) continue;                                    // a shape or an individual, not a concept

  const label = valuesOf(statements, 'rdfs:label')[0] || name;
  const comment = valuesOf(statements, 'rdfs:comment')[0] || null;
  const parent = valuesOf(statements, 'rdfs:subClassOf').find((v) => v.startsWith(PREFIX));

  rows.push(
    `INSERT INTO public.ashrae223_vocabulary VALUES (${sqlString(name)}, ${sqlString(kind)}, ` +
    `${sqlString(label)}, ${comment ? sqlString(comment) : 'NULL'}, ` +
    `${parent ? sqlString(parent.slice(PREFIX.length)) : 'NULL'}, ` +
    `${sqlString(NAMESPACE + name)})\n` +
    `ON CONFLICT (name) DO UPDATE SET\n` +
    `  concept_kind = EXCLUDED.concept_kind,\n` +
    `  label        = EXCLUDED.label,\n` +
    `  description  = EXCLUDED.description,\n` +
    `  subclass_of  = EXCLUDED.subclass_of,\n` +
    `  semantic_id  = EXCLUDED.semantic_id;`
  );
}

if (rows.length < 400) {
  // A parser that quietly stopped early is the failure mode with no symptom: the migration would
  // still apply and the vocabulary would simply be short. 223P declares well over 500 concepts.
  throw new Error(`only ${rows.length} concepts parsed, which is too few to be right`);
}

const body = rows.join('\n');
const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
const header =
  `${BEGIN_MARKER} -- ${ONTOLOGY_VERSION}, ${rows.length} rows, sha256:${digest}\n` +
  `-- GENERATED from the open223 ontology by scripts/generate-ashrae223-vocabulary.mjs.\n` +
  `-- Do not edit these rows by hand: change the script and re-run it.\n` +
  `-- CI verifies the digest above.`;

const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
const beginAt = migration.indexOf(BEGIN_MARKER);
const endAt = migration.indexOf(END_MARKER);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  throw new Error(`markers not found in ${MIGRATION}`);
}
writeFileSync(
  MIGRATION,
  migration.slice(0, beginAt) + header + '\n' + body + '\n' + migration.slice(endAt),
  'utf8'
);

const byKind = rows.reduce((acc, row) => {
  const kind = row.match(/VALUES \('[^']*', '([^']+)'/)[1];
  acc[kind] = (acc[kind] || 0) + 1;
  return acc;
}, {});
console.log(`ASHRAE 223P ${ONTOLOGY_VERSION}: wrote ${rows.length} rows into 0002_seed_data.sql`);
console.log(`  sha256:${digest}`);
console.log(`  ${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}`);
