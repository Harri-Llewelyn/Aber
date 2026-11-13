import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 315. docs/vocabularies.md's derived-series paragraph points at the 0267 section by its heading, and
// no longer says nothing enforces the rule it states: the save refuses a semantic id and a standard on
// a derived metric. A stale "no check enforces this" tells whoever registers one that the rule is
// theirs to keep.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const heading = 'A derived metric is a catalogue row (0267)';
  const slug = heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  const problems315 = [];
  if (!supabaseReadme().includes(`\n### ${heading}\n`)) problems315.push(`supabase/README.md has no section "${heading}"`);
  const vocab = read('docs/vocabularies.md').replace(/\s+/g, ' ');
  if (!vocab.includes(`](../supabase/README.md#${slug})`)) problems315.push(`docs/vocabularies.md does not link to supabase/README.md#${slug}`);
  if (/no check enforces this/i.test(vocab)) problems315.push('docs/vocabularies.md still says no check enforces the derived-series rule, which the save checks of 0267 now do');
  if (problems315.length) {
    fail('the derived-series paragraph is out of step with the save checks:\n' +
      problems315.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`docs/vocabularies.md's derived-series paragraph links to the 0267 section (#${slug}) and says the save checks enforce its rule`);
  }
}
