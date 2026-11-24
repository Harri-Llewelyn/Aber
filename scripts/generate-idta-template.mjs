#!/usr/bin/env node
/**
 * Generate the IDTA submodel-template seed from the templates kept in scripts/vocabularies/.
 *
 *   node scripts/generate-idta-template.mjs
 *   node scripts/generate-idta-template.mjs --vendor <downloaded.json> <the file to keep>
 *
 * Source: the JSON of each template in scripts/lib/idta-template.mjs's TEMPLATES, published by IDTA in
 * github.com/admin-shell-io/submodel-templates under CC BY 4.0, which scripts/vocabularies/README.md
 * gives the commit, the paths and the SHA-256 of. Each file is pinned by content: another is refused
 * rather than read. No network is used.
 *
 * `--vendor` writes the copy to keep from a file downloaded from that repository. It leaves out the
 * ConceptDescriptions whose text an IEC CDD or ECLASS dictionary issued, and prints both SHA-256s for
 * the README and TEMPLATES. Nothing else of the file changes.
 *
 * How a template is read is scripts/lib/idta-template.mjs. Each block is in the migration that seeds it
 * (0320 for the first two, never 0002, which is released). It is written only while that migration is
 * unreleased; once released, a block that would now read differently stops the run.
 * scripts/check-idta-seed-sync.mjs recomputes the digests the blocks carry.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { REGION, TEMPLATES, dictionaryConcepts, planBlocks, templateRows, vendoredText } from './lib/idta-template.mjs';
import { isUnreleased, regionAt, spliceRegion } from './lib/opcua-seed-blocks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const [flag, from, to] = process.argv.slice(2);
if (flag === '--vendor') {
  if (!from || !to) throw new Error('--vendor takes the downloaded file and the file to write');
  const source = readFileSync(resolve(from), 'utf8');
  const kept = vendoredText(source);
  writeFileSync(resolve(to), kept, 'utf8');
  console.log(`${from}\n  sha256:${sha256(source)} (${Buffer.byteLength(source)} bytes), ${dictionaryConcepts(JSON.parse(source)).length} ConceptDescriptions with IEC CDD or ECLASS text`);
  console.log(`${to}\n  sha256:${sha256(kept)} (${Buffer.byteLength(kept)} bytes), ${source === kept ? 'byte for byte the same' : 'those left out'}`);
  process.exit(0);
}
if (flag) throw new Error(`unknown argument ${flag}`);

function read(template) {
  const bytes = readFileSync(join(ROOT, template.file));
  const actual = sha256(bytes);
  if (actual !== template.sha256) {
    throw new Error(
      `${template.file} is sha256:${actual}, pinned to sha256:${template.sha256}. A new release is read ` +
      `(its diff, its licence, the elements it adds) before the pin moves.`
    );
  }
  return templateRows(JSON.parse(bytes.toString('utf8')), template);
}

for (const { block, header, body, rows } of planBlocks({ read })) {
  // Normalised, as the check reads it: a CRLF checkout would otherwise mix the file's line endings.
  const migration = readFileSync(join(ROOT, block.file), 'utf8').replace(/\r\n/g, '\n');
  const next = spliceRegion(migration, REGION, header, body, block.file);
  if (next === migration) {
    console.log(`${block.since}: ${rows} rows, unchanged`);
    continue;
  }
  if (!isUnreleased(block, ROOT)) {
    const at = regionAt(migration, REGION);
    console.error(`${block.file} is released, and its ${REGION.label} block would now read differently.`);
    console.error(`  It holds ${migration.slice(at.beginAt, migration.indexOf('\n', at.beginAt))}`);
    console.error(`  It would  ${header.slice(0, header.indexOf('\n'))}`);
    console.error('  A released migration is never edited: seed the change in a new migration\'s block (scripts/lib/idta-template.mjs).');
    process.exit(1);
  }
  writeFileSync(join(ROOT, block.file), next, 'utf8');
  console.log(`${block.since}: wrote ${rows} rows into ${block.file}`);
}
for (const template of TEMPLATES) {
  const { rows } = read(template);
  console.log(`  ${template.number} ${template.name} ${template.version}: ${rows.length} elements, ` +
    `${rows.filter((row) => row.parent_path === null).length} at the top, ${rows.filter((row) => row.definition).length} with a definition, ` +
    `${rows.filter((row) => row.example_value).length} with an example`);
}
