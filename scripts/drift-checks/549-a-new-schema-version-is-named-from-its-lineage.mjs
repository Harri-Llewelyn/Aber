import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 549. A new schema version is named from its lineage (0318), as the API reference, the format reference
// and the Schemas help say. The last migration to declare a function is the one that runs, so it is read
// there: neither fork_schema() nor apply_device_schemas() names a version from another's name
// (schema_version_base_name(), or the stem the parser gave until 0318), and device_schemas_parse() finds a
// name no lineage has through a version's lineage, because the version in force need not share that
// name. A redeclaration from an older body brings back X_v2_2_v3, or refuses a file that names X_v2_2
// once X_v3 is in force. Mirror check 142 holds the name itself.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems549 = [];
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const last = (fn) => {
    const needle = `CREATE OR REPLACE FUNCTION public.${fn}(`;
    const file = migrations.findLast((f) => read(f).includes(needle));
    if (!file) {
      problems549.push(`no migration declares ${fn}()`);
      return { file: '', body: '' };
    }
    const sql = read(file);
    const from = sql.indexOf(needle);
    const to = sql.indexOf('\n$$;', from);
    return { file, body: sql.slice(from, to < 0 ? undefined : to) };
  };
  const rules = [
    ['fork_schema', 'v_base := parent.lineage_name;', /schema_version_base_name/, "names a version from its parent's lineage_name"],
    ['apply_device_schemas', "v_name := (v_canon ->> 'lineage') || '_v' || v_version;", /schema_version_base_name|'stem'/,
      "names a draft from the checked schema's lineage"],
    ['device_schemas_parse', "s.status = 'active' AND s.lineage_root_id = ANY (v_roots)", /'stem'|status = 'active'[^;]*schema_version_base_name/,
      "looks for the version in force in the lineage of a version it found by name, and gives the writer no stem"],
  ];
  for (const [fn, wanted, unwanted, what] of rules) {
    const { file, body } = last(fn);
    if (body && (!body.includes(wanted) || unwanted.test(body))) problems549.push(`${fn}() in ${file} no longer ${what}`);
  }

  // The texts that say so, each in its own words.
  const told = [
    ['docs/device-schemas.md', '**A new version is named from its lineage.**'],
    ['help/pages/schemas.md', 'The draft takes the name the first version was built with, and its own number'],
    ['docs/openapi.yaml', "The draft's name is computed too: its lineage's name and its number,"],
  ];
  for (const [path, phrase] of told) {
    if (!read(path).includes(phrase)) problems549.push(`${path} no longer says "${phrase}"`);
  }
  if (!supabaseReadme().includes('### A new schema version is named from its lineage (0318)')) {
    problems549.push('supabase/README.md has no section "A new schema version is named from its lineage (0318)", which 0318 cites');
  }

  if (problems549.length) {
    fail(`a new schema version is not named from its lineage everywhere:\n${problems549.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('fork_schema() and apply_device_schemas() name a new version from its lineage and from no other name, device_schemas_parse() finds an older file\'s name through a version\'s lineage, and the API reference, the format reference and the Schemas help say so');
  }
}
