import { lastDefinition, need, ok, problems, read, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 127. An imported vocabulary's limits, one set in three places (0306): the CHECKs of site_vocabularies
// and site_vocabulary_concepts, the arguments import_site_vocabulary() checks each field against, and
// SITE_VOCABULARY_LIMITS in utils/siteVocabulary.js, which the AAS reader skips a concept by. A limit the
// reader states and the table does not is a concept the reader keeps and the function refuses, and
// the reverse is one the reader skips that the database would take. The most concepts a file adds is
// the function's constant against the reader's.
// -------------------------------------------------------------------------------------------------
const COLUMNS = [
  // [JS key, table, column, argument key the function checks it by]
  ['name', 'site_vocabularies', 'name', 'name'],
  ['version', 'site_vocabularies', 'version', 'version'],
  ['licenceNote', 'site_vocabularies', 'licence_note', 'licence_note'],
  ['standardName', 'site_vocabularies', 'standard_name', 'standard_name'],
  ['standardEdition', 'site_vocabularies', 'standard_edition', 'standard_edition'],
  ['standardPublisher', 'site_vocabularies', 'standard_publisher', 'standard_publisher'],
  ['semanticId', 'site_vocabulary_concepts', 'semantic_id', 'semantic_id'],
  ['preferredName', 'site_vocabulary_concepts', 'preferred_name', 'preferred_name'],
  ['definition', 'site_vocabulary_concepts', 'definition', 'definition'],
  ['unit', 'site_vocabulary_concepts', 'unit', 'unit'],
  ['unitId', 'site_vocabulary_concepts', 'unit_id', 'unit_id'],
  ['dataType', 'site_vocabulary_concepts', 'data_type', 'data_type'],
];

export default function check() {
  const js = read('frontend/src/utils/siteVocabulary.js');
  const block = need(js, /export const SITE_VOCABULARY_LIMITS = Object\.freeze\(\{([^}]*)\}\)/, 'SITE_VOCABULARY_LIMITS in utils/siteVocabulary.js');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.import_site_vocabulary(', '$fn$;', 'import_site_vocabulary()');
  if (!block || !fn) return;
  const limits = new Map([...block[1].matchAll(/^\s*([a-zA-Z]+): (\d+),?$/gm)].map((m) => [m[1], m[2]]));

  const mismatches = [];
  let compared = 0;
  for (const [key, table, column] of COLUMNS) {
    const body = need(SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`), `the table ${table} in the migrations`);
    if (!body) return;
    const sqlLimit = body[1].match(new RegExp(`char_length\\(${column}\\) <= (\\d+)`))?.[1];
    if (!limits.has(key)) { problems.push(`siteVocabularyLimits: SITE_VOCABULARY_LIMITS has no ${key}`); continue; }
    if (!sqlLimit) { problems.push(`siteVocabularyLimits: ${table}.${column} has no length CHECK -- the table's shape changed, so this check is no longer checking it`); continue; }
    compared += 1;
    if (sqlLimit !== limits.get(key)) mismatches.push(`${key}: the table allows ${sqlLimit}, the reader ${limits.get(key)}`);
    // The function states the same limit where it checks the field.
    const argument = fn.body.match(new RegExp(`site_vocabulary_text_problem\\((?:p_file|v_item), '${column}', '(?:[^']|'')*', (\\d+),`))?.[1];
    if (argument !== sqlLimit) mismatches.push(`${key}: the table allows ${sqlLimit}, import_site_vocabulary() checks ${argument ?? 'nothing'}`);
  }
  const maxConcepts = need(fn.body, /c_max_concepts CONSTANT integer := (\d+);/, `c_max_concepts in import_site_vocabulary() (${fn.file})`);
  if (maxConcepts) {
    compared += 1;
    if (maxConcepts[1] !== limits.get('concepts')) mismatches.push(`concepts: import_site_vocabulary() takes ${maxConcepts[1]} a file, the reader ${limits.get('concepts')}`);
  }

  if (mismatches.length) problems.push(`siteVocabularyLimits: the reader's limits and the database's disagree (${fn.file}): ${mismatches.join('; ')}`);
  else ok.push(`siteVocabularyLimits: ${compared} limits of an imported vocabulary are the same in the tables, import_site_vocabulary() (${fn.file}) and the reader`);
}
