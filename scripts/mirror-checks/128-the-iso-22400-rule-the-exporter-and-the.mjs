import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, need, ok, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 128. The words an imported vocabulary's file is judged by, in the exporter and the dashboard (0306).
// The AAS export files a metric under KeyPerformanceIndicators when it was started from a published
// standard whose name begins `ISO 22400` (isKpiMetric() in shell.ts), and the dashboard says the same
// of a file (isIso22400File()) and cites a published standard as `name:edition` where the exporter
// does (siteFileLabel()). The prefix is the seeded standard's own spelling, STANDARDS.ISO22400; the
// two kinds of file are the table's CHECK. A prefix, a kind or a citation one side changes alone
// files a KPI as telemetry, or cites a file two ways.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { STANDARDS } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const ts = read('supabase/functions/_shared/aas/shell.ts');
  const js = read('frontend/src/utils/siteVocabulary.js');

  const prefix = need(ts, /file\?\.kind === "published_standard" && String\(file\.standard_name \?\? ""\)\.startsWith\("([^"]+)"\)/,
    'the ISO 22400 prefix rule in isKpiMetric() in supabase/functions/_shared/aas/shell.ts');
  if (prefix) compare('siteStandardRule', 'the prefix isKpiMetric() files a KPI by and STANDARDS.ISO22400', prefix[1], STANDARDS.ISO22400);
  const jsPrefix = need(js, /vocabulary\?\.kind === VOCABULARY_KINDS\.PUBLISHED &&\s+\(vocabulary\?\.standard_name \|\| ''\)\.startsWith\(STANDARDS\.ISO22400\)/,
    'isIso22400File() in utils/siteVocabulary.js');
  if (prefix && jsPrefix) ok.push('siteStandardRule: isIso22400File() judges a file by the same prefix and the same kind as isKpiMetric()');

  const kinds = need(js, /export const VOCABULARY_KINDS = Object\.freeze\(\{ PUBLISHED: '([^']+)', OWN: '([^']+)' \}\)/, 'VOCABULARY_KINDS in utils/siteVocabulary.js');
  const checkKinds = need(SCHEMA, /CONSTRAINT site_vocabularies_kind_valid\s+CHECK \(\(kind = ANY \(ARRAY\['([^']+)'::text, '([^']+)'::text\]\)\)\)/, 'site_vocabularies_kind_valid in the migrations');
  if (kinds && checkKinds) {
    compare('siteStandardRule', "the kinds of file the dashboard names and the table's CHECK admits", `${kinds[1]}, ${kinds[2]}`, `${checkKinds[1]}, ${checkKinds[2]}`);
    compare('siteStandardRule', 'the kind isKpiMetric() reads as a published standard and the one the table names', 'published_standard', kinds[1]);
  }

  const tsCitation = need(ts, /file\.standard_edition \? `\$\{file\.standard_name\}:\$\{file\.standard_edition\}` : file\.standard_name/, 'the citation in siteFileLabel() in shell.ts');
  const jsCitation = need(js, /return edition \? `\$\{name\}:\$\{edition\}` : name/, 'the citation in standardCitation() in utils/siteVocabulary.js');
  if (tsCitation && jsCitation) ok.push('siteStandardRule: the exporter and the dashboard cite a published standard as name:edition, the name alone without an edition');
}
