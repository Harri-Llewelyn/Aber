import { allFiles, fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 292. The automations JSON Schema is one file, served at one path. The dashboard's static folder
// holds it and nothing else holds a copy; the page that describes the format, the migrations'
// README and the guard suite each name that path; and the folder the guard suite reads its
// fixtures from exists and holds both kinds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PATH = '/json-schema/automations.schema.json';
  const FILE = `frontend/public${PATH}`;
  const problems292 = [];
  const copies = allFiles.filter((f) => /(^|\/)automations\.schema\.json$/.test(f));
  if (copies.length !== 1 || copies[0] !== FILE) {
    problems292.push(`expected one automations.schema.json, at ${FILE}; found ${copies.join(', ') || 'none'}`);
  }
  for (const doc of ['docs/automations.md', 'supabase/README.md']) {
    if (!readDoc(doc).includes(PATH)) problems292.push(`${doc} does not name ${PATH}`);
  }
  const suite = read('supabase/migrations/test_the_automations_schema_and_the_function_agree.py');
  if (!suite.includes('"frontend" / "public" / "json-schema" / "automations.schema.json"')) {
    problems292.push('the guard suite does not read the schema from frontend/public/json-schema/');
  }
  const fixtures = (kind) => allFiles.filter((f) => f.startsWith(`supabase/automations-fixtures/${kind}/`) && f.endsWith('.json'));
  if (fixtures('valid').length === 0 || fixtures('invalid').length === 0) {
    problems292.push('supabase/automations-fixtures/ holds no valid or no invalid fixture');
  }
  for (const f of fixtures('invalid')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !/^\$/.test(fixture.path ?? '') || typeof fixture.database !== 'boolean' || !('document' in fixture)) {
      problems292.push(`${f} is not {about, path, database, document}`);
    }
  }
  if (problems292.length) {
    fail(`the automations JSON Schema is not one file served at ${PATH}:\n${problems292.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the automations JSON Schema is one file, served at ${PATH}, named by its page, the migrations' README and the guard suite, over ${fixtures('valid').length} valid and ${fixtures('invalid').length} invalid fixtures`);
  }
}
