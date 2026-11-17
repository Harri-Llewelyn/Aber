import { allFiles, fail, pass, read, readDoc, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 430. The derived metrics JSON Schema is one file, served at one path. The dashboard's static folder
// holds it, beside the others, and nothing else holds a copy; the page that describes the format, the
// migrations' README and the guard suite each name that path; and the folder the guard suite reads its
// fixtures from exists and holds the three kinds: valid, invalid and changed (a description that differs).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PATH = '/json-schema/derived-metrics.schema.json';
  const FILE = `frontend/public${PATH}`;
  const problems430 = [];
  const copies = allFiles.filter((f) => /(^|\/)derived-metrics\.schema\.json$/.test(f));
  if (copies.length !== 1 || copies[0] !== FILE) {
    problems430.push(`expected one derived-metrics.schema.json, at ${FILE}; found ${copies.join(', ') || 'none'}`);
  }
  if (!readDoc('docs/derived-metrics.md').includes(PATH)) problems430.push(`docs/derived-metrics.md does not name ${PATH}`);
  if (!supabaseReadme().includes(PATH)) problems430.push(`supabase/README.md (with the unreleased notes folded in) does not name ${PATH}`);
  const suite = read('supabase/migrations/test_the_derived_metrics_json_schema_and_the_function_agree.py');
  if (!suite.includes('"frontend" / "public" / "json-schema" / "derived-metrics.schema.json"')) {
    problems430.push('the guard suite does not read the schema from frontend/public/json-schema/');
  }
  const fixtures = (kind) => allFiles.filter((f) => f.startsWith(`supabase/derived-metrics-fixtures/${kind}/`) && f.endsWith('.json'));
  if (fixtures('valid').length === 0 || fixtures('invalid').length === 0 || fixtures('changed').length === 0) {
    problems430.push('supabase/derived-metrics-fixtures/ holds no valid, no invalid or no changed fixture');
  }
  for (const f of fixtures('invalid')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !/^\$/.test(fixture.path ?? '') || typeof fixture.database !== 'boolean' || !('document' in fixture)) {
      problems430.push(`${f} is not {about, path, database, document}`);
    }
  }
  for (const f of fixtures('changed')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !('document' in fixture) || typeof fixture.before !== 'object' || typeof fixture.after !== 'object') {
      problems430.push(`${f} is not {about, before, after, document}`);
    }
  }
  for (const f of fixtures('valid')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !('document' in fixture)) problems430.push(`${f} is not {about, document}`);
  }
  if (problems430.length) {
    fail(`the derived metrics JSON Schema is not one file served at ${PATH}:\n${problems430.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the derived metrics JSON Schema is one file, served at ${PATH}, named by its page, the migrations' README and the guard suite, over ${fixtures('valid').length} valid, ${fixtures('invalid').length} invalid and ${fixtures('changed').length} changed fixtures`);
  }
}
