#!/usr/bin/env node
/**
 * Generate the ASHRAE 223P vocabulary migration from the published open223 ontology.
 *
 *   node scripts/generate-ashrae223-vocabulary.mjs
 *
 * Source: https://github.com/open223/defs.open223.info -> ontologies/223p.ttl. The ontology
 * DECLARES ITS OWN LICENCE in-band, asserted by the rights holder rather than inferred:
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
 * sound. Turtle is not that: this file is 536 KB, its literals are sometimes triple-quoted and
 * multi-line, and -- the trap that actually bites -- **`rdfs:comment` appears INSIDE the nested
 * `sh:property [ ... ]` blank nodes as a SHACL constraint message**, several per class. A scan that
 * simply found `rdfs:comment` after a subject would silently describe `s223:Fan` as "A `Fan` shall
 * have at least one outlet using the medium `Fluid-Air`". So this tracks bracket depth and reads
 * predicates only at the top level of a subject block, and it tokenises strings properly instead of
 * matching quotes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ONTOLOGY_URL =
  'https://raw.githubusercontent.com/open223/defs.open223.info/main/ontologies/223p.ttl';

/** Pinned. The pin is asserted against the file, so an upstream release fails rather than lands. */
const ONTOLOGY_VERSION = 'v1.0.0-2026';
const ONTOLOGY_IRI = 'http://data.ashrae.org/standard223/1.0/model/all';

/** The concept namespace. Seeded rows carry `NAMESPACE + localName` as their semantic id. */
const NAMESPACE = 'http://data.ashrae.org/standard223#';

/**
 * Only the `s223:` namespace is seeded.
 *
 * The ontology `owl:imports <http://qudt.org/3.2.1/shacl/qudt-all>` for quantity kinds and units.
 * Following that import would pull in a second, much larger vocabulary under a different licence
 * needing its own check -- and units are already covered by the MTConnect unit vocabulary. So a
 * concept outside s223: is skipped rather than partially adopted.
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

/**
 * The subset of Turtle this file needs, read as a token stream rather than matched.
 *
 * It understands: prefixed names, absolute IRIs, single- and triple-quoted string literals with
 * escapes, datatype (`^^`) and language (`@en`) suffixes, the separators `; , .`, and the bracket
 * pairs `[ ] ( )`. It does NOT implement Turtle -- no collections beyond skipping them, no base
 * resolution, no numeric or boolean literal typing -- because nothing here needs those, and a
 * half-implementation that pretended otherwise would be worse than an honest subset.
 */
function* tokenise(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    if (ch === '#' ) {                                   // comment to end of line
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue; }

    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      i += quote.length;
      let value = '';
      while (i < n) {
        if (text[i] === '\\') {                          // keep escapes intact for unescaping below
          value += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (text.startsWith(quote, i)) { i += quote.length; break; }
        value += text[i];
        i += 1;
      }
      yield { type: 'literal', value: unescapeTurtle(value) };
      continue;
    }

    if (ch === '<') {
      const end = text.indexOf('>', i);
      const value = end < 0 ? '' : text.slice(i + 1, end);
      i = end < 0 ? n : end + 1;
      yield { type: 'iri', value };
      continue;
    }

    if (ch === ';' || ch === ',' || ch === '.' || ch === '[' || ch === ']' || ch === '(' || ch === ')') {
      // A '.' inside a prefixed name (s223:Fluid-Air.Something) is handled by the name branch
      // below, which consumes it; reaching here means a real statement terminator.
      i += 1;
      yield { type: 'punct', value: ch };
      continue;
    }

    if (ch === '^' && text[i + 1] === '^') { i += 2; yield { type: 'punct', value: '^^' }; continue; }
    if (ch === '@') {
      i += 1;
      let value = '';
      while (i < n && /[A-Za-z0-9-]/.test(text[i])) { value += text[i]; i += 1; }
      yield { type: 'lang', value };
      continue;
    }

    let value = '';
    while (i < n && !/[\s;,[\]()"'<>]/.test(text[i])) {
      // Stop at a '.' that terminates a statement -- i.e. one followed by whitespace or EOF --
      // but keep one that is part of a name.
      if (text[i] === '.' && (i + 1 >= n || /[\s]/.test(text[i + 1]))) break;
      value += text[i];
      i += 1;
    }
    if (value === '') { i += 1; continue; }
    yield { type: 'name', value };
  }
}

function unescapeTurtle(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

/**
 * Top-level statements about `s223:` subjects.
 *
 * Depth tracking is the load-bearing part: a predicate is recorded only when no `[` is open, which
 * is what keeps a SHACL constraint's `rdfs:comment` from being read as the class's own.
 */
function parseConcepts(text) {
  const concepts = new Map();
  let subject = null;
  let predicate = null;
  let depth = 0;
  let objects = [];

  const flush = () => {
    if (subject && predicate && objects.length > 0) {
      const entry = concepts.get(subject);
      if (entry) {
        if (!entry[predicate]) entry[predicate] = [];
        entry[predicate].push(...objects);
      }
    }
    objects = [];
  };

  for (const token of tokenise(text)) {
    if (token.type === 'punct') {
      if (token.value === '[' || token.value === '(') { depth += 1; continue; }
      if (token.value === ']' || token.value === ')') { depth -= 1; continue; }
      if (depth > 0) continue;
      if (token.value === ',') continue;                  // more objects for the same predicate
      if (token.value === ';') { flush(); predicate = null; continue; }
      if (token.value === '.') { flush(); subject = null; predicate = null; continue; }
      if (token.value === '^^') continue;                 // datatype of the literal just read
      continue;
    }
    if (depth > 0) continue;
    if (token.type === 'lang') continue;

    if (!subject) {
      if (token.type === 'name' && token.value.startsWith(PREFIX)) {
        subject = token.value.slice(PREFIX.length);
        if (!concepts.has(subject)) concepts.set(subject, {});
      } else if (token.type === 'name' || token.type === 'iri') {
        // A subject this generator does not seed (the ontology header, a QUDT term). Consume its
        // statements by leaving `subject` null until the next '.'.
        subject = null;
      }
      predicate = null;
      objects = [];
      continue;
    }

    if (!predicate) {
      // `^^xsd:string` after a literal arrives as a name; it is skipped because a predicate is
      // only accepted immediately after a ';' or a subject, and '^^' clears nothing.
      predicate = token.value === 'a' ? 'rdf:type' : token.value;
      objects = [];
      continue;
    }

    if (token.type === 'literal') objects.push(token.value);
    else if (token.type === 'name' || token.type === 'iri') objects.push(token.value);
  }
  flush();
  return concepts;
}

const response = await fetch(ONTOLOGY_URL);
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${ONTOLOGY_URL}`);
const turtle = await response.text();

// THE PIN CHECK, for the same reason the OPC UA generator has one: everything below is only as
// trustworthy as the release it was read from, and 223P is pre-publication, so an upstream revision
// is a thing to review rather than absorb.
const versionMatch = turtle.match(/owl:versionInfo\s+"([^"]+)"/);
if (!versionMatch) throw new Error('no owl:versionInfo in the ontology; refusing to guess a version');
if (versionMatch[1] !== ONTOLOGY_VERSION) {
  throw new Error(
    `upstream ontology is ${versionMatch[1]}, pinned to ${ONTOLOGY_VERSION}. ASHRAE 223 is still ` +
    `in public review -- read the diff, update the pin, then re-run. Do not just bump the pin.`
  );
}
if (!turtle.includes(ONTOLOGY_IRI)) throw new Error(`ontology IRI ${ONTOLOGY_IRI} not found`);
if (!turtle.includes('http://www.apache.org/licenses/LICENSE-2.0')) {
  throw new Error('the ontology no longer declares the Apache-2.0 licence this generator relies on');
}

const concepts = parseConcepts(turtle);

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
  const types = statements['rdf:type'] || [];
  const kind = types.map((t) => KINDS[t]).find(Boolean);
  if (!kind) continue;                                    // a shape or an individual, not a concept

  const label = (statements['rdfs:label'] || [])[0] || name;
  const comment = (statements['rdfs:comment'] || [])[0] || null;
  const parent = (statements['rdfs:subClassOf'] || [])
    .find((v) => typeof v === 'string' && v.startsWith(PREFIX));

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
