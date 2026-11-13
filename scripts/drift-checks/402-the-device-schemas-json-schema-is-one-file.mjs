import { allFiles, fail, pass, read, readDoc, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 402. The device schemas JSON Schema is one file, served at one path. The dashboard's static folder
// holds it, beside the automations one, and nothing else holds a copy; the page that describes the
// format, the migrations' README and the guard suite each name that path; and the folder the guard
// suite reads its fixtures from exists and holds both kinds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PATH = '/json-schema/device-schemas.schema.json';
  const FILE = `frontend/public${PATH}`;
  const problems402 = [];
  const copies = allFiles.filter((f) => /(^|\/)device-schemas\.schema\.json$/.test(f));
  if (copies.length !== 1 || copies[0] !== FILE) {
    problems402.push(`expected one device-schemas.schema.json, at ${FILE}; found ${copies.join(', ') || 'none'}`);
  }
  if (!readDoc('docs/device-schemas.md').includes(PATH)) problems402.push(`docs/device-schemas.md does not name ${PATH}`);
  if (!supabaseReadme().includes(PATH)) problems402.push(`supabase/README.md (with the unreleased notes folded in) does not name ${PATH}`);
  const suite = read('supabase/migrations/test_the_device_schemas_json_schema_and_the_function_agree.py');
  if (!suite.includes('"frontend" / "public" / "json-schema" / "device-schemas.schema.json"')) {
    problems402.push('the guard suite does not read the schema from frontend/public/json-schema/');
  }
  const fixtures = (kind) => allFiles.filter((f) => f.startsWith(`supabase/device-schemas-fixtures/${kind}/`) && f.endsWith('.json'));
  if (fixtures('valid').length === 0 || fixtures('invalid').length === 0) {
    problems402.push('supabase/device-schemas-fixtures/ holds no valid or no invalid fixture');
  }
  for (const f of fixtures('invalid')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !/^\$/.test(fixture.path ?? '') || typeof fixture.database !== 'boolean' || !('document' in fixture)) {
      problems402.push(`${f} is not {about, path, database, document}`);
    }
  }
  for (const f of fixtures('valid')) {
    const fixture = JSON.parse(read(f));
    if (typeof fixture.about !== 'string' || !('document' in fixture)) problems402.push(`${f} is not {about, document}`);
  }
  if (problems402.length) {
    fail(`the device schemas JSON Schema is not one file served at ${PATH}:\n${problems402.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the device schemas JSON Schema is one file, served at ${PATH}, named by its page, the migrations' README and the guard suite, over ${fixtures('valid').length} valid and ${fixtures('invalid').length} invalid fixtures`);
  }
}
