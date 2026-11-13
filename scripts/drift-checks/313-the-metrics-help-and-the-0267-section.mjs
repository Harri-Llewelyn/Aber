import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 313. The Metrics help and the 0267 section give a rate's unit as the dialog and the trigger make it:
// the counter's unit followed by RATE_UNIT_SUFFIX, and UNITLESS_COUNTER with the suffix for a counter
// with none (mirror check 81 holds both to enforce_derived_metric()). A page naming another unit
// tells a person the wrong thing about a row they cannot edit.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const js = read('frontend/src/utils/derivedMetric.js');
  const suffix = js.match(/^export const RATE_UNIT_SUFFIX = '([^']+)'/m)?.[1];
  const bare = js.match(/^export const UNITLESS_COUNTER = '([^']+)'/m)?.[1];
  const problems313 = [];
  if (!suffix || !bare) problems313.push('could not read RATE_UNIT_SUFFIX and UNITLESS_COUNTER out of frontend/src/utils/derivedMetric.js');
  else {
    const claims = [
      ['help/pages/metrics.md', `or \`${bare}${suffix}\` for a counter with none`],
      ['supabase/README.md', `\`${bare}${suffix}\` for an input with none`],
    ];
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems313.push(`${file} does not say "${said}"`);
  }
  if (problems313.length) {
    fail('the docs give a derived rate\'s unit otherwise than the dialog and the trigger make it:\n' +
      problems313.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Metrics help and the 0267 section give a counter with no unit ${bare}${suffix}, as the dialog and enforce_derived_metric() do`);
  }
}
