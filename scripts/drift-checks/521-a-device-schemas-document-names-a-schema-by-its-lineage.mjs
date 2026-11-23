import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 521. A document of device schemas names a schema by its lineage (0316), as docs/device-schemas.md and
// the Schemas help say. The last migration to declare a function is the one that runs, so each rule is
// read there: the export renders lineage_name and picks lineages by lineage_root_id, the checker finds
// a name by lineage_name before it tries a version's stem, and the writer compares the version in
// force the checker found. A redeclaration that goes back to the stem names an X_v2_2 version under
// its whole name again, and another site does not find it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems521 = [];
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const last = (fn) => {
    const needle = `CREATE OR REPLACE FUNCTION public.${fn}(`;
    const file = migrations.findLast((f) => read(f).includes(needle));
    if (!file) {
      problems521.push(`no migration declares ${fn}()`);
      return { file: '', body: '' };
    }
    const sql = read(file);
    const from = sql.indexOf(needle);
    const to = sql.indexOf('\n$$;', from);
    return { file, body: sql.slice(from, to < 0 ? undefined : to) };
  };
  const rules = [
    ['device_schema_stored_document', [/device_schema_document_of\(\s*s\.lineage_name,/], /schema_version_base_name/,
      'renders the schema under its lineage_name'],
    ['device_schemas_document', [/SELECT DISTINCT s\.lineage_root_id/, /ON p\.lineage_root_id = s\.lineage_root_id/], /schema_version_base_name/,
      'picks the lineages of the ids given by lineage_root_id'],
    ['device_schemas_parse', [/v_by_lineage := EXISTS \(SELECT 1 FROM public\.schemas s WHERE s\.lineage_name = v_name\)/,
      /'lineage', v_lineage, 'head', v_head_id/], null,
      'finds a name by lineage_name first, and hands the writer the lineage and the version in force it found'],
    ['apply_device_schemas', [/s\.id = \(v_canon ->> 'head'\)::uuid/, /device_schema_document_of\(\s*v_canon ->> 'lineage',/],
      /schema_version_base_name\(s\.schema_name\) = v_canon/,
      'compares the version in force the checker found, under its lineage\'s name'],
  ];
  for (const [fn, wanted, unwanted, what] of rules) {
    const { file, body } = last(fn);
    if (!body) continue;
    if (!wanted.every((re) => re.test(body)) || (unwanted && unwanted.test(body))) {
      problems521.push(`${fn}() in ${file} no longer ${what}`);
    }
  }

  // The texts that say so.
  const told = [
    ['docs/device-schemas.md', "**A schema is found by its lineage's name.**"],
    ['help/pages/schemas.md', '**A schema is found by the name its first version was built with.**'],
  ];
  for (const [path, phrase] of told) {
    if (!read(path).includes(phrase)) problems521.push(`${path} no longer says ${phrase}`);
  }
  if (!supabaseReadme().includes('### A document of device schemas names a schema by its lineage (0316)')) {
    problems521.push('supabase/README.md has no section "A document of device schemas names a schema by its lineage (0316)", which 0316 cites');
  }

  if (problems521.length) {
    fail(`a device schemas document does not name a schema by its lineage everywhere:\n${problems521.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('the device schemas export names a schema by its lineage_name and picks lineages by lineage_root_id, the checker finds a name by lineage_name first, the writer compares the version in force it found, and the format reference and the Schemas help say so');
  }
}
