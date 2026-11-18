import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 485. The documents state the limits the AAS reader keeps, as PACKAGE_LIMITS in utils/aasPackage.js
// has them (0306): the largest file, the most entries, the largest entry and package once inflated, and
// the ratio at which an entry is a bomb. The vocabulary document and the Vocabulary help each say the
// numbers, and a limit changed in the code alone leaves a person who reads "25 MB" refused at 30.
// The reader and its test also name every refusal rule; the numbers are the part a person quotes.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems485 = [];
  const source = read('frontend/src/utils/aasPackage.js');
  // The number a limit is written as: `25 * MiB` is 25 (megabytes), `5000` is 5000.
  const limit = (name) => {
    const m = source.match(new RegExp(`${name}: (\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const limits = {
    file: limit('maxFileBytes'),
    entries: limit('maxEntries'),
    entry: limit('maxEntryBytes'),
    total: limit('maxTotalBytes'),
    ratio: limit('maxRatio'),
  };
  if (Object.values(limits).some((v) => v === null)) {
    fail('485: could not read PACKAGE_LIMITS from frontend/src/utils/aasPackage.js -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const thousands = (n) => n.toLocaleString('en-GB');
  const claims = [
    `${limits.file} MB`, `${thousands(limits.entries)} entries`, `${limits.entry} MB`, `${limits.total} MB`, `${limits.ratio} times`,
  ];
  for (const file of ['docs/vocabularies.md', 'help/pages/vocabulary.md']) {
    const text = read(file);
    for (const claim of claims) {
      if (!text.includes(claim)) problems485.push(`${file} does not say "${claim}", which aasPackage.js limits a package to`);
    }
  }
  if (problems485.length) {
    fail(`the documents and the AAS reader's limits disagree:\n${problems485.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/vocabularies.md and the Vocabulary help state the reader's limits: ${claims.join(', ')}`);
  }
}
