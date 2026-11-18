import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 477. The credit CC BY 4.0 asks for reads the same where QUDT's text is shown. The Vocabulary tab says
// "Quantity kinds from QUDT 3.5.2, by QUDT.org, under CC BY 4.0", which is QUDT_ATTRIBUTION and the
// licence's name; the Vocabulary help and the vocabulary document say it in the same words; and the
// release in it is the one the generator reads, the one the vendored files are named for. A tab that
// credited a release the rows were not read from, or a help page that dropped the credit, would still
// build.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const problems477 = [];
  const { QUDT_ATTRIBUTION, QUDT_VERSION, QUDT_LICENCE_URL } = await import(pathToFileURL(join(REPO, 'frontend/src/utils/qudt.js')).href);
  const credit = `${QUDT_ATTRIBUTION} CC BY 4.0.`;

  for (const [where, text] of [
    ['help/pages/vocabulary.md', read('help/pages/vocabulary.md')],
    ['docs/vocabularies.md', read('docs/vocabularies.md')],
  ]) {
    // The help bolds the credit and the document quotes it, so the words are compared without markup.
    const plain = text.replaceAll('**', '').replaceAll('"', '').replace(/\s+/g, ' ');
    if (!plain.includes(credit.replace(/\.$/, ''))) problems477.push(`${where} does not carry the credit "${credit}"`);
  }

  const panel = read('frontend/src/components/common/QUDTVocabularyPanel.jsx');
  if (!panel.includes('QUDT_ATTRIBUTION') || !panel.includes('QUDT_LICENCE_URL') || !panel.includes('>CC BY 4.0</a>')) {
    problems477.push('the QUDT tab does not show QUDT_ATTRIBUTION with the licence linked as "CC BY 4.0"');
  }
  if (QUDT_LICENCE_URL !== 'https://creativecommons.org/licenses/by/4.0/') {
    problems477.push(`QUDT_LICENCE_URL is ${QUDT_LICENCE_URL}, not the CC BY 4.0 legal code's address`);
  }

  const files = read('scripts/generate-qudt-vocabulary.mjs').match(/qudt-(\d+\.\d+\.\d+)-(?:quantity-kinds|units)\.ttl/g) ?? [];
  const named = new Set(files.map((f) => f.match(/qudt-(\d+\.\d+\.\d+)-/)[1]));
  if (named.size !== 1 || !named.has(QUDT_VERSION)) {
    problems477.push(`the tab credits QUDT ${QUDT_VERSION}, and the generator reads files named for ${[...named].join(', ') || 'no release'}`);
  }

  if (problems477.length) {
    fail('the credit to QUDT.org is not the same everywhere QUDT\'s text is shown:\n' + problems477.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the QUDT tab, the Vocabulary help and the vocabulary document carry "${credit}", with the licence linked on the tab, for the release ${QUDT_VERSION} the generator reads`);
  }
}
