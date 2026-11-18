import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 484. The API reference documents the imported vocabularies (0306): the two tables as GET routes and no
// verb that writes them, the four functions as POST routes, a schema for each table with every column the
// migration declares (the file's format enum the CHECK's), and `site_vocabulary_id` on the metric
// catalog's schema. The tables have no write policy, so a route that offered a write would promise
// what the database refuses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems484 = [];
  const file = readdirSync(join(REPO, 'supabase/migrations')).find((f) => /^\d{4}_.*\.sql$/.test(f) && read(`supabase/migrations/${f}`).includes('CREATE TABLE IF NOT EXISTS public.site_vocabularies ('));
  if (!file) {
    fail('484: no migration creates site_vocabularies -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const sql = read(`supabase/migrations/${file}`);
  const spec = read('docs/openapi.yaml');
  const block = (path) => {
    const at = spec.indexOf(`\n  ${path}:\n`);
    return at < 0 ? '' : spec.slice(at + 1, spec.indexOf('\n  /', at + 2));
  };
  const columns = (table) => [...(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(\\n([\\s\\S]*?)\\n    CONSTRAINT `))?.[1] ?? '')
    .matchAll(/^ {4}([a-z_0-9]+) /gm)].map((m) => m[1]);
  const schema = (name) => {
    const at = spec.indexOf(`\n    ${name}:\n`);
    return at < 0 ? '' : spec.slice(at + 1, spec.indexOf('\n\n', at + 2));
  };

  for (const [route, table, schemaName] of [['/rest/v1/site_vocabularies', 'site_vocabularies', 'SiteVocabulary'], ['/rest/v1/site_vocabulary_concepts', 'site_vocabulary_concepts', 'SiteVocabularyConcept']]) {
    const path = block(route);
    if (!path) { problems484.push(`docs/openapi.yaml has no ${route}`); continue; }
    if (!path.includes('\n    get:')) problems484.push(`${route} documents no GET`);
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      if (path.includes(`\n    ${verb}:`)) problems484.push(`${route} documents ${verb.toUpperCase()}, which the table's policies refuse: only the three functions write it`);
    }
    const body = schema(schemaName);
    if (!body) { problems484.push(`docs/openapi.yaml has no schema ${schemaName}`); continue; }
    const cols = columns(table);
    if (cols.length === 0) problems484.push(`could not read the columns of ${table} from ${file}`);
    for (const column of cols) {
      if (!new RegExp(`\\n {8}${column}:`).test(`\\n${body}`)) problems484.push(`schema ${schemaName} lacks the column ${column}`);
    }
  }

  const formats = (sql.match(/site_vocabularies_source_format_valid\s+CHECK \(\(source_format = ANY \(ARRAY\[([^\]]*)\]\)\)\)/)?.[1] ?? '').match(/'([a-z-]+)'/g)?.map((m) => m.slice(1, -1)).sort().join(', ');
  const documented = (schema('SiteVocabulary').match(/source_format: \{ type: string, enum: \[([^\]]*)\]/)?.[1] ?? '').split(',').map((v) => v.trim()).filter(Boolean).sort().join(', ');
  if (!formats) problems484.push('could not read the formats of site_vocabularies_source_format_valid');
  else if (formats !== documented) problems484.push(`SiteVocabulary.source_format documents ${documented || 'nothing'}, the CHECK admits ${formats}`);

  for (const fn of ['import_site_vocabulary', 'remove_site_vocabulary', 'set_site_vocabulary_sharing', 'site_vocabulary_holders']) {
    const path = block(`/rest/v1/rpc/${fn}`);
    if (!path) problems484.push(`docs/openapi.yaml has no /rest/v1/rpc/${fn}`);
    else if (!path.includes('\n    post:')) problems484.push(`/rest/v1/rpc/${fn} documents no POST`);
    if (!new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`).test(sql)) problems484.push(`${file} does not declare ${fn}(), which the reference documents`);
  }
  if (!/\n {8}site_vocabulary_id:/.test(`\n${schema('MetricCatalogEntry')}`)) problems484.push('schema MetricCatalogEntry lacks site_vocabulary_id');
  if (!sql.includes('ADD COLUMN IF NOT EXISTS site_vocabulary_id uuid')) problems484.push(`${file} does not add metric_catalog.site_vocabulary_id`);

  if (problems484.length) {
    fail(`the API reference and the imported vocabularies disagree:\n${problems484.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('docs/openapi.yaml documents site_vocabularies and site_vocabulary_concepts as read-only routes with every column, the four functions as POSTs, the file formats the CHECK admits and site_vocabulary_id on the catalog');
  }
}
