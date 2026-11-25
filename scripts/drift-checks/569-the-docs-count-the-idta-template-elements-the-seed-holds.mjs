import { BLOCKS, REGION } from '../lib/idta-template.mjs';
import { rowsOf, splitStatements } from '../lib/idta-template-rows.mjs';
import { readDigestRegion } from '../lib/opcua-seed-blocks.mjs';
import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 569. The documents count the IDTA template elements the seed holds, and name each template with its
// release: the vocabulary document's section and its table, the API reference and the Vocabulary page's
// help. The counts are read from the blocks that execute, so a template added to one of them moves every
// claim here at once.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems569 = [];
  const seeded = BLOCKS.flatMap(({ file }) => {
    const region = readDigestRegion(read(file).replace(/\r\n/g, '\n'), REGION);
    return region?.body ? splitStatements(region.body).map(rowsOf) : [];
  }).filter(Boolean).map(({ template: [, name, number, version], rows }) => ({
    name, number, version, elements: rows.length, top: rows.filter((row) => row.parent_path === null).length,
  }));
  if (seeded.length === 0) {
    fail('569: no block seeds an IDTA template -- the seed\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const total = seeded.reduce((sum, { elements }) => sum + elements, 0);

  const doc = read('docs/vocabularies.md');
  const section = doc.slice(doc.indexOf('## IDTA submodel templates'), doc.indexOf('## IDTA Digital Nameplate'));
  const api = read('docs/openapi.yaml').replace(/\s+/g, ' ');
  const page = read('help/pages/vocabulary.md');
  const help = page.slice(page.indexOf('## The Templates tab'), page.indexOf('## The Imported tab'));
  if (!section.includes(`**${total} elements**`)) problems569.push(`docs/vocabularies.md's IDTA section does not count ${total} elements`);
  if (!api.includes(` ${total} elements of `)) problems569.push(`docs/openapi.yaml does not count ${total} template elements`);
  for (const { name, number, version, elements, top } of seeded) {
    if (!section.includes(`| ${name} ${version} (${number}) | ${elements} | ${top} |`)) {
      problems569.push(`docs/vocabularies.md's table does not give ${name} ${version} (${number}) ${elements} elements, ${top} at the top`);
    }
    if (!api.includes(`${name} ${version} (${number})`)) problems569.push(`docs/openapi.yaml does not name ${name} ${version} (${number})`);
    if (!help.includes(`**${name}** (${number})`)) problems569.push(`the Vocabulary page's help does not list **${name}** (${number}) under The Templates tab`);
  }

  if (problems569.length) {
    fail('the documents and the seeded IDTA templates disagree:\n' + problems569.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vocabulary document, the API reference and the Vocabulary page's help name the ${seeded.length} seeded IDTA templates and count their ${total} elements`);
  }
}
