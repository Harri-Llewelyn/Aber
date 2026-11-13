import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 311. The Derived tab's docs say how many inputs a sum takes as utils/derivedMetric.js holds it
// (DERIVED_MAX_INPUTS, which mirror check 80 holds to 0267's shape function). A page saying another
// limit sends a person to build a sum the dialog will not let them finish, or tells them they may
// not.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const max = Number(read('frontend/src/utils/derivedMetric.js').match(/^export const DERIVED_MAX_INPUTS = (\d+)/m)?.[1]);
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const problems311 = [];
  if (!Number.isInteger(max) || !words[max]) problems311.push('could not read DERIVED_MAX_INPUTS out of frontend/src/utils/derivedMetric.js');
  else {
    const claims = [
      ['help/pages/metrics.md', `adds or subtracts two to ${words[max]} numeric metrics`],
      ['supabase/README.md', `the signed sum of two to ${words[max]} inputs`],
    ];
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems311.push(`${file} does not say "${said}"`);
  }
  if (problems311.length) {
    fail('the docs name the most inputs a sum takes otherwise than DERIVED_MAX_INPUTS holds it:\n' +
      problems311.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Metrics help and the 0267 section say a sum takes two to ${words[max]} inputs, as DERIVED_MAX_INPUTS holds`);
  }
}
