import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 478. The four OEE KPIs cite OPC 40501-1 Annex C.2.4, and the seed, the documents and the help say
// the same thing. The migration that adds `iso22400_vocabulary.source` gives each of AVAILABILITY,
// EFFECTIVENESS, QUALITY and OEE the citation and no other row; the formula the citation quotes is the
// formula column's (0002), with the KPI's symbol in front and its brackets unwritten; and the
// vocabulary document, the Vocabulary help and the API reference name the annex, its clause and the
// version. A citation that moved in one place would leave a KPI crediting a version the documents do
// not mention, or a formula the annex does not give.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems478 = [];
  const CITATION = 'OPC 40501-1 v1.02.0, Annex C.2.4 (informative)';
  const OEE = ['AVAILABILITY', 'EFFECTIVENESS', 'QUALITY', 'OEE'];

  const file = readdirSync(join(REPO, 'supabase/migrations')).find(
    (f) => /^\d{4}_.*\.sql$/.test(f) && read(`supabase/migrations/${f}`).includes('ALTER TABLE public.iso22400_vocabulary ADD COLUMN IF NOT EXISTS source text'),
  );
  if (!file) {
    fail('478: no migration adds iso22400_vocabulary.source -- it moved, so this check is no longer checking anything');
    return;
  }
  const sql = read(`supabase/migrations/${file}`);

  // The VALUES rows of the UPDATE: ('NAME', '<description>', '<source>').
  const values = sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf(') AS c(name, description, source)'));
  const cited = new Map();
  for (const row of values.split("\n    ('").slice(1)) {
    const name = row.slice(0, row.indexOf("'"));
    const source = row.slice(row.lastIndexOf(",\n     '") + ",\n     '".length).replace(/'\)?,?\s*$/, '').replace(/''/g, "'");
    cited.set(name, source);
  }
  if (cited.size === 0) {
    fail('478: read no citation from the migration -- its UPDATE changed shape, so this check is no longer checking anything');
    return;
  }
  for (const name of OEE) {
    if (!cited.has(name)) problems478.push(`${file} gives ${name} no source`);
  }
  for (const name of cited.keys()) {
    if (!OEE.includes(name)) problems478.push(`${file} gives ${name} a source, and only the four OEE KPIs have one`);
  }
  for (const [name, source] of cited) {
    if (!source.startsWith(`${CITATION}: "`)) problems478.push(`${name}'s source does not begin with the citation "${CITATION}: ..."`);
    if (!source.includes('takes its KPI definitions from ISO 22400-2')) problems478.push(`${name}'s source does not say the annex takes its definitions from ISO 22400-2`);
  }

  // The quoted formula is the formula column's: `Availability = APT / PBT` and `A = APT / PBT`.
  const seed = read('supabase/migrations/0002_seed_data.sql');
  const bare = (text) => text.replace(/[()\s]/g, '');
  for (const [name, left] of [['AVAILABILITY', 'Availability'], ['EFFECTIVENESS', 'Effectiveness'], ['QUALITY', 'Quality rate']]) {
    const quoted = (cited.get(name) ?? '').match(/"([^"]+)"/)?.[1] ?? '';
    const row = seed.slice(seed.indexOf(`INSERT INTO public.iso22400_vocabulary VALUES ('${name}'`));
    const formula = row.slice(0, row.indexOf('\n')).match(/'([A-Z]+ = [^']+)', 'https:/)?.[1] ?? '';
    if (!quoted.startsWith(`${left} = `) || bare(quoted.slice(left.length + 3)) !== bare(formula.slice(formula.indexOf('=') + 1))) {
      problems478.push(`${name}: the source quotes "${quoted}" and the formula column holds "${formula}"`);
    }
  }

  const doc = read('docs/vocabularies.md');
  const section = doc.slice(doc.indexOf('### ISO 22400 and its source'), doc.indexOf('### Licences'));
  const help = read('help/pages/vocabulary.md');
  const api = read('docs/openapi.yaml');
  for (const [where, text, wanted] of [
    ['the ISO 22400 section of docs/vocabularies.md', section, ['OPC 40501-1 v1.02.0', 'Annex C', 'C.2.4', '`AVAILABILITY`, `EFFECTIVENESS`, `QUALITY` and `OEE`', 'Availability = APT / PBT', 'Effectiveness = PRI x PQ / APT', 'Quality rate = GQ / PQ']],
    ['help/pages/vocabulary.md', help, ['OPC 40501-1 v1.02.0, Annex C.2.4', '`AVAILABILITY`, `EFFECTIVENESS`, `QUALITY` and `OEE`']],
    ['docs/openapi.yaml', api, ['OPC 40501-1\n        v1.02.0 Annex C.2.4']],
  ]) {
    for (const claim of wanted) {
      if (!text.includes(claim)) problems478.push(`${where} does not say "${claim.replace(/\n\s*/g, ' ')}"`);
    }
  }

  if (problems478.length) {
    fail('the OEE KPIs\' source, the formulas it quotes and the documents disagree:\n' + problems478.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${cited.size} OEE KPIs cite ${CITATION} in ${file}, each quotes the formula the seed holds, and the vocabulary document, the help and the API reference name the annex`);
  }
}
