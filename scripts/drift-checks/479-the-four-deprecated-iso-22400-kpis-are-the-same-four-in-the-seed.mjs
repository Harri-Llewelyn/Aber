import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, sectionOf, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 479. The four ISO 22400 KPIs the migration deprecates are the four the documents, the help and the
// upgrade note name, none of them is one of the four OEE KPIs, and each says the same window: announced
// in 1.9.0, removed no sooner than 1.10.0, as docs/releases.md's deprecation policy asks. The upgrade
// note's title says deprecated, which is what puts it under Deprecated in the release notes. A fifth
// row deprecated in the migration, or a document that left one out, would leave a reader unsure which
// KPIs are going.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems479 = [];
  const OEE = ['AVAILABILITY', 'EFFECTIVENESS', 'QUALITY', 'OEE'];

  const file = readdirSync(join(REPO, 'supabase/migrations')).find(
    (f) => /^\d{4}_.*\.sql$/.test(f) && read(`supabase/migrations/${f}`).includes('ADD COLUMN IF NOT EXISTS deprecated_reason text'),
  );
  if (!file) {
    fail('479: no migration adds iso22400_vocabulary.deprecated_reason -- it moved, so this check is no longer checking anything');
    return;
  }
  const sql = read(`supabase/migrations/${file}`);
  const update = sql.slice(sql.indexOf('SET deprecated_reason = c.reason'), sql.indexOf(') AS c(name, description, reason)'));
  const names = [...update.matchAll(/^\s{4}\('([A-Z_]+)',/gm)].map((m) => m[1]);
  if (names.length === 0) {
    fail('479: read no deprecated KPI from the migration -- its UPDATE changed shape, so this check is no longer checking anything');
    return;
  }
  for (const name of names.filter((n) => OEE.includes(n))) problems479.push(`${file} deprecates ${name}, which is an OEE KPI`);
  const reasons = update.split('\n').filter((line) => line.includes('removed no sooner than 1.10.0'));
  if (reasons.length !== names.length) {
    problems479.push(`${file} gives ${reasons.length} reasons that say "removed no sooner than 1.10.0", and deprecates ${names.length} KPIs`);
  }

  const note = sectionOf(upgradingGuide(), '### From 1.9.0, four ISO 22400 KPIs are deprecated');
  if (!note.startsWith('### From 1.9.0, ') || !note.split('\n')[0].includes('deprecated')) {
    problems479.push('the upgrade note does not open "### From 1.9.0, ... deprecated", which the release notes list under Deprecated');
  }
  const doc = read('docs/vocabularies.md');
  const section = doc.slice(doc.indexOf('### ISO 22400 and its source'), doc.indexOf('### Licences'));
  for (const [where, text] of [
    ['the upgrade note', note],
    ['the ISO 22400 section of docs/vocabularies.md', section],
    ['the settled row on the four KPIs in docs/vocabularies.md', doc.slice(doc.indexOf('| What happens to `UTILIZATION`'), doc.indexOf('| Is a 223P class a metric'))],
    ['help/pages/vocabulary.md', read('help/pages/vocabulary.md')],
    ['docs/openapi.yaml', read('docs/openapi.yaml').slice(read('docs/openapi.yaml').indexOf('/rest/v1/iso22400_vocabulary:'), read('docs/openapi.yaml').indexOf('/rest/v1/opcua_vocabulary:'))],
  ]) {
    for (const name of names) {
      if (!text.includes(`\`${name}\``)) problems479.push(`${where} does not name \`${name}\`, which ${file} deprecates`);
    }
    for (const name of OEE) {
      if (text.includes(`\`${name}\` is deprecated`) || text.includes(`\`${name}\` are deprecated`)) {
        problems479.push(`${where} calls the OEE KPI \`${name}\` deprecated`);
      }
    }
    if (!text.includes('1.10.0')) problems479.push(`${where} does not say the rows are removed no sooner than 1.10.0`);
  }

  if (problems479.length) {
    fail('the deprecated ISO 22400 KPIs differ between the migration and the documents:\n' + problems479.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${names.length} KPIs ${file} deprecates (${names.join(', ')}) are the ones the upgrade note, the vocabulary document, the help and the API reference name, with the 1.10.0 window, and none is an OEE KPI`);
  }
}
