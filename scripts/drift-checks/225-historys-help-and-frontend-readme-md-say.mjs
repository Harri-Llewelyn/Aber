import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 225. History's help and frontend/README.md say how wide a text chart's bucket is held under Auto,
// as utils/history.js holds it (TEXT_BUCKET_MIN_PX). The width is why a text chart can read in
// larger buckets than the numbers beside it; a page naming another explains a size nobody sees.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const util = read('frontend/src/utils/history.js');
  const px = Number(util.match(/^export const TEXT_BUCKET_MIN_PX = (\d+)$/m)?.[1]);
  const problems225 = [];
  if (!Number.isInteger(px)) problems225.push('could not read TEXT_BUCKET_MIN_PX out of frontend/src/utils/history.js');
  else {
    if (!read('help/pages/history.md').includes(`whose buckets are each at least ${px} pixels wide`)) {
      problems225.push(`help/pages/history.md does not say "whose buckets are each at least ${px} pixels wide"`);
    }
    if (!read('frontend/README.md').includes(`\`TEXT_BUCKET_MIN_PX\` (${px}px)`)) {
      problems225.push(`frontend/README.md does not give \`TEXT_BUCKET_MIN_PX\` (${px}px)`);
    }
  }
  if (problems225.length) {
    fail('History\'s docs state a text chart\'s bucket width otherwise than utils/history.js holds it:\n' +
      problems225.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and the README hold a text chart's bucket to ${px}px under Auto, as TEXT_BUCKET_MIN_PX does`);
  }
}
