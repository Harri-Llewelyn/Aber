import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 314. Every kind of derived metric DERIVATION_KINDS offers is written out as its definition in the
// 0267 section, the OpenAPI description of the column and the column's own comment. A kind named in
// the dialog and in none of them is one an API caller cannot learn the shape of.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const block = read('frontend/src/utils/derivedMetric.js').match(/^export const DERIVATION_KINDS = \[([\s\S]*?)\n\]/m)?.[1] ?? '';
  const kinds = [...block.matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]);
  const problems314 = [];
  if (kinds.length < 3) problems314.push('could not read DERIVATION_KINDS out of frontend/src/utils/derivedMetric.js');
  else {
    const files = ['supabase/README.md', 'docs/openapi.yaml', 'supabase/migrations/0267_a_derived_metric_is_a_catalogue_row.sql'];
    for (const file of files) {
      const text = readDoc(file);
      for (const kind of kinds) if (!text.includes(`"kind": "${kind}"`)) problems314.push(`${file} does not write out {"kind": "${kind}", ...}`);
    }
  }
  if (problems314.length) {
    fail('a kind of derived metric is not written out where its shape is documented:\n' +
      problems314.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${kinds.length} kinds of derived metric, ${kinds.join(', ')}, are written out in the 0267 section, the OpenAPI description and the column comment`);
  }
}
