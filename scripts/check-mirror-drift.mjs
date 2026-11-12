/**
 * Hold the SQL-to-JavaScript mirrors together by comparing the values both sides declare, not by
 * grepping for a literal's presence, which catches a rewrite and misses a re-tuning. The
 * `modelledMetrics` mirror is behaviour rather than a literal and has a fixture contract instead
 * (`test-harness/fixtures/modelled-metrics.json`).
 *
 * Usage: node scripts/check-mirror-drift.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const problems = [];
const ok = [];

/**
 * The whole applied chain, in filename order, the order db-init replays it in. There is no
 * applied-migrations ledger, so a later `CREATE OR REPLACE FUNCTION` of the same name wins, and a
 * guard reading an earlier definition reports an agreement it did not check. `archive/` stays out:
 * readdirSync is top-level only.
 */
const MIGRATION_DIR = 'supabase/migrations';
const MIGRATION_FILES = readdirSync(join(ROOT, MIGRATION_DIR))
  .filter((name) => /^[0-9]{4}_.*\.sql$/.test(name))
  .sort();

if (MIGRATION_FILES.length === 0) {
  console.error('No applied migrations found in supabase/migrations/. Nothing to check against.');
  process.exit(1);
}

/** The example metrics db-init applies on request (dbInit.exampleMetrics). No migration seeds one. */
const EXAMPLES = read('supabase/example-metrics.sql');

/** Every applied migration, in replay order, each headed by a marker naming its file. */
const SCHEMA = MIGRATION_FILES
  .map((name) => `-- >>> ${name}\n${read(`${MIGRATION_DIR}/${name}`)}`)
  .join('\n');

/**
 * The body of the last definition matching `needle`, and which migration it came from. Last,
 * because an earlier declaration is overwritten on every boot. `endMarker` bounds the body (`$$;`
 * for a function, `;` for a plain view), since 0001 carries unrelated `INTERVAL` literals.
 * `redeclarations` is reported so the output says which file was read.
 */
const lastDefinition = (needle, endMarker, what) => {
  const at = SCHEMA.lastIndexOf(needle);
  if (at < 0) {
    problems.push(
      `could not find ${what} in any applied migration -- the file's shape changed, so this check is no longer checking anything`
    );
    return null;
  }
  const stop = SCHEMA.indexOf(endMarker, at);
  const preceding = SCHEMA.slice(0, at);
  const marker = preceding.lastIndexOf('-- >>> ');
  const file = marker < 0 ? '(unknown)' : preceding.slice(marker + 7, preceding.indexOf('\n', marker));
  let redeclarations = 0;
  for (let i = SCHEMA.indexOf(needle); i >= 0; i = SCHEMA.indexOf(needle, i + 1)) redeclarations += 1;
  return { body: SCHEMA.slice(at, stop < 0 ? undefined : stop), file, redeclarations };
};

const need = (source, re, what) => {
  const m = source.match(re);
  if (!m) {
    problems.push(`could not find ${what} — the file's shape changed, so this check is no longer checking anything`);
    return null;
  }
  return m;
};

const compare = (mirror, label, jsValue, sqlValue) => {
  if (String(jsValue) !== String(sqlValue)) {
    problems.push(`${mirror}: ${label} disagree — JS has ${JSON.stringify(jsValue)}, SQL has ${JSON.stringify(sqlValue)}`);
  } else {
    ok.push(`${mirror}: ${label} = ${JSON.stringify(jsValue)}`);
  }
};

// 1. Sparkplug id derivation. It derives an immutable wire identity: `sparkplug_id` is `GENERATED
// ALWAYS ... STORED`, so a divergence cannot be corrected without re-provisioning every device.
{
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsDevice = need(js, /DEVICE_ID_PREFIX\s*=\s*'([^']+)'/, 'DEVICE_ID_PREFIX in sparkplugId.js');
  const jsGateway = need(js, /GATEWAY_ID_PREFIX\s*=\s*'([^']+)'/, 'GATEWAY_ID_PREFIX in sparkplugId.js');
  const jsHex = need(js, /HEX_CHARS\s*=\s*(\d+)/, 'HEX_CHARS in sparkplugId.js');
  const jsLength = need(js, /SPARKPLUG_ID_LENGTH\s*=\s*(\d+)/, 'SPARKPLUG_ID_LENGTH in sparkplugId.js');
  const jsRegex = need(js, /SPARKPLUG_ID_REGEX\s*=\s*\/\^\(([a-z|]+)\)\[0-9a-f\]\{(\d+)\}\$\//, 'SPARKPLUG_ID_REGEX in sparkplugId.js');

  // e.g. ('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21)). 0001 declares each
  // column twice, in its CREATE TABLE IF NOT EXISTS and in the ADD COLUMN IF NOT EXISTS that
  // converges an older table, so declarations are grouped by the table statement they sit in:
  // exactly devices and gateways, and every declaration of one table must agree.
  const declarations = [...SCHEMA.matchAll(
    /sparkplug_id text GENERATED ALWAYS AS \(\('([a-z]+)'::text \|\| substr\(encode\(uuid_send\(id\), 'hex'::text\), 1, (\d+)\)\)\) STORED/g
  )].map((m) => {
    const tables = [...SCHEMA.slice(0, m.index).matchAll(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?(?: IF EXISTS)?) public\.(\w+)/gm)];
    return { table: tables.length ? tables[tables.length - 1][1] : '(unknown)', prefix: m[1], width: m[2] };
  });
  const byTable = new Map();
  for (const d of declarations) {
    const key = `${d.prefix}/${d.width}`;
    byTable.set(d.table, (byTable.get(d.table) ?? new Set()).add(key));
  }
  const tableNames = [...byTable.keys()].sort().join(',');
  const conflicting = [...byTable].filter(([, forms]) => forms.size > 1);
  if (tableNames !== 'devices,gateways') {
    problems.push(`sparkplugId: expected generated sparkplug_id columns on devices and gateways, found them on "${tableNames}"`);
  } else if (conflicting.length > 0) {
    for (const [table, forms] of conflicting) {
      problems.push(`sparkplugId: ${table}.sparkplug_id is declared ${forms.size} different ways across the chain: ${[...forms].join(' vs ')}`);
    }
  } else if (jsDevice && jsGateway && jsHex && jsLength && jsRegex) {
    const generated = [...byTable.values()].map((forms) => [...forms][0].split('/'));
    ok.push(`sparkplugId: ${declarations.length} declarations resolve to one column each on devices and gateways`);
    const sqlPrefixes = generated.map(([prefix]) => prefix).sort();
    const sqlWidths = [...new Set(generated.map(([, width]) => width))];
    compare('sparkplugId', 'type prefixes', [jsDevice[1], jsGateway[1]].sort().join(','), sqlPrefixes.join(','));
    if (sqlWidths.length !== 1) {
      problems.push(`sparkplugId: the two generated columns disagree on hex width: ${sqlWidths.join(' vs ')}`);
    } else {
      compare('sparkplugId', 'hex character count', jsHex[1], sqlWidths[0]);
      // Internal consistency: 3-character prefix + hex width must be the declared total, and the
      // regex must agree with both. A wrong total silently breaks length-based validation.
      compare('sparkplugId', 'total id length', jsLength[1], String(jsDevice[1].length + Number(sqlWidths[0])));
      compare('sparkplugId', 'regex hex width', jsRegex[2], sqlWidths[0]);
      compare('sparkplugId', 'regex prefixes', jsRegex[1].split('|').sort().join(','), sqlPrefixes.join(','));
    }
  }
}

// 1b. A gateway's Sparkplug group. The Edit Gateway dialog refuses a value before saving it with
// sparkplugGroupProblem(); the table's CHECK and ingest_record_gateway_group() refuse it in the
// database. A character only one side refuses is a dialog that blocks a legal group, or one that
// lets the save fail with a constraint error.
{
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsChars = need(js, /SPARKPLUG_GROUP_FORBIDDEN\s*=\s*'([^']+)'/, 'SPARKPLUG_GROUP_FORBIDDEN in sparkplugId.js');
  const jsEmpty = /group === ''/.test(js);
  const check = need(
    SCHEMA,
    /CONSTRAINT gateways_sparkplug_group_format CHECK \(\(\(sparkplug_group <> ''::text\) AND \(sparkplug_group !~ '\[([^\]]+)\]'::text\)\)\)/,
    'gateways_sparkplug_group_format in the applied chain'
  );
  const gate = lastDefinition(
    'CREATE OR REPLACE FUNCTION public.ingest_record_gateway_group(',
    '$$;',
    'public.ingest_record_gateway_group()'
  );
  const gateChars = gate ? need(gate.body, /p_group ~ '\[([^\]]+)\]'/, 'the character class in ingest_record_gateway_group()') : null;
  const sorted = (chars) => [...chars].sort().join('');
  if (jsChars && check) {
    compare('sparkplugGroup', 'characters the dialog and the CHECK refuse', sorted(jsChars[1]), sorted(check[1]));
    if (!jsEmpty) problems.push('sparkplugGroup: sparkplugGroupProblem() no longer refuses the empty group the CHECK refuses');
  }
  if (jsChars && gateChars) {
    compare('sparkplugGroup', `characters the dialog and ${gate.file}'s gate refuse`, sorted(jsChars[1]), sorted(gateChars[1]));
  }
}

// 64. An area's and a cell's name. Their dialogs hold Save, and say why, with placeNameProblem();
// areas_name_topic_safe and cells_name_topic_safe refuse the name in the database. A character only
// one side refuses is a dialog that blocks a legal name, or one that lets the save fail with a
// constraint error.
{
  const js = read('frontend/src/utils/unsPath.js');
  const jsChars = need(js, /^const UNSAFE = \/\[([^\]]+)\]\//m, 'UNSAFE in unsPath.js');
  const jsEmpty = /export const placeNameProblem = [^\n]*!\(name \|\| ''\)\.trim\(\)/.test(js);
  const sorted = (chars) => [...chars].sort().join('');
  for (const table of ['areas', 'cells']) {
    const check = need(
      SCHEMA,
      new RegExp(`CONSTRAINT ${table}_name_topic_safe CHECK \\(\\(\\(name <> ''::text\\) AND \\(name !~ '\\[([^\\]]+)\\]'::text\\)\\)\\)`),
      `${table}_name_topic_safe in the applied chain`
    );
    if (jsChars && check) {
      compare('placeName', `characters the dialog and ${table}_name_topic_safe refuse`, sorted(jsChars[1]), sorted(check[1]));
    }
  }
  if (!jsEmpty) problems.push('placeName: placeNameProblem() no longer refuses the empty name the CHECKs refuse');
}

// 15. A person's display name. The dashboard's forms and manage-people's `add` refuse a name before
// sending it, with displayNameProblem(); person_profiles' CHECKs refuse it in the database. A
// character or a length only one side refuses is a form that blocks a legal name, or an add that
// creates the account and then fails to name it.
{
  const sides = [
    ['frontend/src/utils/displayName.js', read('frontend/src/utils/displayName.js')],
    ['supabase/functions/manage-people/displayName.ts', read('supabase/functions/manage-people/displayName.ts')],
  ];
  const sqlClass = need(
    SCHEMA,
    /CONSTRAINT person_profiles_display_name_printable CHECK \(display_name !~ '\[([^\]]+)\]'\)/,
    'person_profiles_display_name_printable in the applied chain'
  );
  const sqlLength = need(
    SCHEMA,
    /CONSTRAINT person_profiles_display_name_length CHECK \(char_length\(display_name\) BETWEEN 1 AND (\d+)\)/,
    'person_profiles_display_name_length in the applied chain'
  );
  for (const [file, source] of sides) {
    const jsClass = need(source, /DISPLAY_NAME_FORBIDDEN = \/\[([^\]]+)\]\//, `DISPLAY_NAME_FORBIDDEN in ${file}`);
    const jsLength = need(source, /DISPLAY_NAME_MAX = (\d+)/, `DISPLAY_NAME_MAX in ${file}`);
    if (jsClass && sqlClass) compare('displayName', `characters ${file} and the CHECK refuse`, jsClass[1], sqlClass[1]);
    if (jsLength && sqlLength) compare('displayName', `longest name ${file} and the CHECK allow`, jsLength[1], sqlLength[1]);
  }
}

// 74. An app's redirect addresses, one rule in two places (0260). app_redirect_problem() decides in
// the database and redirectAddressProblem() says it before the dialog asks. Both are held to
// test-harness/fixtures/app-redirect-addresses.json by their own tests, which must still read it, and
// the file must keep a case for each way an address is allowed and each way it is refused: a case
// removed leaves a rule only one side was ever tested on.
{
  const FIXTURE = 'test-harness/fixtures/app-redirect-addresses.json';
  const readers = [
    ['the database suite', 'supabase/migrations/test_an_administrator_registers_an_app_that_signs_people_in.py'],
    ["the dashboard's tests", 'frontend/src/__tests__/registerApp.test.jsx'],
  ];
  const cases = JSON.parse(read(FIXTURE)).cases ?? [];
  const rules = new Set(cases.map((c) => c.rule));
  const ALLOWED = [
    'https goes anywhere', 'http: localhost', 'http: .localhost names', 'http: loopback', 'http: private addresses',
    "http: the site's domain",
  ];
  const REFUSED = [
    'http elsewhere is refused', "the site's domain is a whole name", 'localhost is a whole name',
    'an address that is not one', 'no fragment', 'no wildcard', 'no comma', 'no user name', 'no space', 'no backslash',
    'https and http alone', 'not empty',
  ];
  const before74 = problems.length;
  for (const [who, file] of readers) {
    if (!read(file).includes('app-redirect-addresses.json')) problems.push(`redirectAddresses: ${who} (${file}) no longer reads ${FIXTURE}, so one side of the rule is untested against it`);
  }
  for (const rule of ALLOWED) {
    if (!cases.some((c) => c.rule === rule && c.ok === true)) problems.push(`redirectAddresses: ${FIXTURE} has no allowed case for "${rule}"`);
  }
  for (const rule of REFUSED) {
    if (!cases.some((c) => c.rule === rule && c.ok === false)) problems.push(`redirectAddresses: ${FIXTURE} has no refused case for "${rule}"`);
  }
  if (problems.length === before74) ok.push(`redirectAddresses: ${cases.length} cases across ${rules.size} rules, read by the database suite and the dashboard's tests`);
}

// 75. How much an app may be given, three places each (0260). register_app() takes 1 to c_max_uris
// redirect addresses, GoTrue refuses a client with more than ten, and the dialog's redirectAddressesProblem()
// stops at APP_REDIRECT_MAX; the name is 1 to c_max_name characters, and appNameProblem() stops at APP_NAME_MAX.
{
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.register_app(', '$$;', 'register_app() in the applied chain');
  const js = read('frontend/src/utils/apps.js');
  const sqlUris = fn && need(fn.body, /c_max_uris\s+CONSTANT integer := (\d+);/, 'c_max_uris in register_app()');
  const sqlName = fn && need(fn.body, /c_max_name\s+CONSTANT integer := (\d+);/, 'c_max_name in register_app()');
  const jsUris = need(js, /export const APP_REDIRECT_MAX = (\d+)/, 'APP_REDIRECT_MAX in utils/apps.js');
  const jsName = need(js, /export const APP_NAME_MAX = (\d+)/, 'APP_NAME_MAX in utils/apps.js');
  if (sqlUris && jsUris) compare('appLimits', `most redirect addresses register_app() (${fn.file}) and the dialog take`, jsUris[1], sqlUris[1]);
  if (sqlName && jsName) compare('appLimits', `longest app name register_app() (${fn.file}) and the dialog take`, jsName[1], sqlName[1]);
  // GoTrue's own limit (v2.197.0 validateRedirectURIList): a client with more is refused by its router.
  if (sqlUris && Number(sqlUris[1]) > 10) problems.push(`appLimits: register_app() takes ${sqlUris[1]} redirect addresses, and GoTrue (v2.197.0) refuses a client with more than 10`);
}

// 26. A person's picture. The dashboard uploads to, downloads from and deletes `<id>/avatar` in the
// avatars bucket; manage-people's Remove Access deletes the same object; storage-init.mjs creates
// the bucket with its types and limit; and 0213's CHECK and is_own_avatar_object() name the object.
// A name only one side uses is a picture nobody can read or one Remove Access leaves behind; a type
// or a limit only one side holds is a picker that offers what the bucket refuses.
{
  const ui = read('frontend/src/utils/picture.js');
  const fn = read('supabase/functions/manage-people/people.ts');
  const init = read('scripts/storage-init.mjs');
  const policies = read('supabase/storage-policies.sql');
  const uiBucket = need(ui, /^export const PICTURE_BUCKET = '([^']+)'$/m, 'PICTURE_BUCKET in frontend/src/utils/picture.js');
  const fnBucket = need(fn, /^export const PICTURE_BUCKET = "([^"]+)";$/m, 'PICTURE_BUCKET in manage-people/people.ts');
  const uiPath = need(ui, /^export const picturePath = \(userId\) => `\$\{userId\}(\/[^`]+)`$/m, 'picturePath() in frontend/src/utils/picture.js');
  const fnPath = need(fn, /^export const picturePath = \(userId: string\) => `\$\{userId\}(\/[^`]+)`;$/m, 'picturePath() in manage-people/people.ts');
  const uiTypes = need(ui, /^export const PICTURE_TYPES = \[([^\]]+)\]$/m, 'PICTURE_TYPES in frontend/src/utils/picture.js');
  const uiLimit = need(ui, /^export const PICTURE_STORED_MAX_BYTES = (\d+)$/m, 'PICTURE_STORED_MAX_BYTES in frontend/src/utils/picture.js');
  const initTypes = need(init, /^const AVATAR_MIME_TYPES = \[([^\]]+)\];$/m, 'AVATAR_MIME_TYPES in scripts/storage-init.mjs');
  const initLimit = need(init, /^const AVATAR_SIZE_LIMIT = (\d+);$/m, 'AVATAR_SIZE_LIMIT in scripts/storage-init.mjs');
  const initBucket = need(init, /id: '([^']+)',\s*public: false,\s*file_size_limit: AVATAR_SIZE_LIMIT,\s*allowed_mime_types: AVATAR_MIME_TYPES,/, "the bucket storage-init.mjs gives AVATAR_SIZE_LIMIT");
  const owner = lastDefinition('CREATE OR REPLACE FUNCTION public.is_own_avatar_object(', '$$;', 'is_own_avatar_object() in the applied chain');
  const ownerPath = owner && need(owner.body, /\(SELECT auth\.uid\(\)\)::text \|\| '(\/[^']+)'/, `the object is_own_avatar_object() admits (${owner.file})`);
  const check = need(SCHEMA, /CONSTRAINT person_profiles_avatar_path_is_the_owner_s CHECK \(\(\(avatar_path IS NULL\) OR \(avatar_path = \(\(user_id\)::text \|\| '(\/[^']+)'::text\)\)\)\)/, 'person_profiles_avatar_path_is_the_owner_s in the applied chain');
  const list = (m) => [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]).sort().join(',');

  if (uiBucket && fnBucket) compare('picture', 'bucket the dashboard and manage-people name', uiBucket[1], fnBucket[1]);
  if (uiBucket && initBucket) compare('picture', 'bucket the dashboard names and storage-init.mjs creates', uiBucket[1], initBucket[1]);
  if (uiBucket && !new RegExp(`bucket_id = '${uiBucket[1].replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}' AND public\\.is_own_avatar_object\\(`).test(policies)) {
    problems.push(`picture: no policy in supabase/storage-policies.sql admits the owner to the ${uiBucket[1]} bucket`);
  }
  if (uiPath && fnPath) compare('picture', 'object name the dashboard and manage-people use', uiPath[1], fnPath[1]);
  if (uiPath && ownerPath) compare('picture', `object name the dashboard uses and ${owner.file}'s is_own_avatar_object() admits`, uiPath[1], ownerPath[1]);
  if (uiPath && check) compare('picture', 'object name the dashboard uses and avatar_path\'s CHECK allows', uiPath[1], check[1]);
  if (uiTypes && initTypes) compare('picture', 'types the picker takes and the bucket admits', list(uiTypes), list(initTypes));
  if (uiLimit && initLimit) compare('picture', 'largest picture the page uploads and the bucket admits', uiLimit[1], initLimit[1]);
}

// 34. An area plan's turns. The Areas panel turns a plan by the quarter turns PLAN_ROTATIONS lists
// (utils/areaPlans.js), and 0221's CHECK admits the turns the column may hold. A turn only the
// dashboard offers is a button the database refuses; one only the CHECK admits is a row a client
// wrote that the dashboard draws unturned. planRotation() falls back to the column's default.
{
  const ui = read('frontend/src/utils/areaPlans.js');
  const uiTurns = need(ui, /^export const PLAN_ROTATIONS = \[([^\]]+)\]$/m, 'PLAN_ROTATIONS in frontend/src/utils/areaPlans.js');
  const uiFallback = need(ui, /return PLAN_ROTATIONS\.includes\(turn\) \? turn : (\d+)$/m, "planRotation()'s fallback in frontend/src/utils/areaPlans.js");
  const checks = [...SCHEMA.matchAll(/ADD CONSTRAINT areas_plan_rotation_quarter_turn CHECK \(\(plan_rotation = ANY \(ARRAY\[([^\]]+)\]\)\)\)/g)];
  const column = [...SCHEMA.matchAll(/ADD COLUMN IF NOT EXISTS plan_rotation smallint DEFAULT (\d+) NOT NULL/g)];
  if (!checks.length) problems.push('could not find areas_plan_rotation_quarter_turn in the applied chain — the file\'s shape changed, so this check is no longer checking anything');
  if (!column.length) problems.push('could not find areas.plan_rotation\'s ADD COLUMN in the applied chain — the file\'s shape changed, so this check is no longer checking anything');
  const list = (text) => text.split(',').map((t) => Number(t.trim())).sort((a, b) => a - b).join(',');

  if (uiTurns && checks.length) compare('planRotation', 'turns the panel offers and the CHECK admits', list(uiTurns[1]), list(checks.at(-1)[1]));
  if (uiFallback && column.length) compare('planRotation', "turn the dashboard draws for an unknown value and the column's default", uiFallback[1], column.at(-1)[1]);
}

// 18. What an email address looks like. Add Person and Change Email refuse an address in the
// dashboard (utils/people.js) and in manage-people before anything is asked, and
// ensure_first_administrator() and check_person_email_change() refuse one in the database. A shape
// one side accepts and another refuses is a form that sends what the server refuses, or a server
// that takes what the first administrator's setup would not.
{
  const asJs = (sqlPattern) => sqlPattern.replace(/\[:space:\]/g, '\\s');
  const sides = [
    ['frontend/src/utils/people.js', need(read('frontend/src/utils/people.js'), /^export const EMAIL = \/(.+)\/$/m, 'EMAIL in frontend/src/utils/people.js')?.[1]],
    ['supabase/functions/manage-people/people.ts', need(read('supabase/functions/manage-people/people.ts'), /^const EMAIL = \/(.+)\/;$/m, 'EMAIL in manage-people/people.ts')?.[1]],
  ];
  for (const [fn, what] of [['ensure_first_administrator', 'v_email'], ['check_person_email_change', 'v_email']]) {
    const def = lastDefinition(`CREATE OR REPLACE FUNCTION public.${fn}(`, '$$;', `${fn}() in the applied chain`);
    const sql = def && need(def.body, new RegExp(`${what} !~ '([^']+)'`), `the address test in ${fn}() (${def.file})`);
    sides.push([`${fn}() in ${def?.file}`, sql ? asJs(sql[1]) : undefined]);
  }
  const [[firstFile, first], ...rest] = sides;
  for (const [file, pattern] of rest) {
    if (first !== undefined && pattern !== undefined) compare('email', `address shape ${firstFile} and ${file} accept`, first, pattern);
  }
}

// 25. An ended session, recorded. end_my_session() (a person's own) and end_person_session() (an
// Administrator's, from the person's drawer) each record the session as its list returned it, and
// the Audit Trail names it with sessionLabel() (utils/sessions.js), the Sessions list's own words.
// A field sessionLabel() reads that a row lacks makes every recorded session "Not recorded"; a
// field list_my_sessions() does not return is one the row was never meant to keep, such as an
// address. person_sessions(), the drawer's list, returns list_my_sessions()'s columns but
// is_current, so an Administrator sees no more of a session than its holder does.
{
  const list = lastDefinition('CREATE OR REPLACE FUNCTION public.list_my_sessions()', '$$;', 'list_my_sessions() in the applied chain');
  const columnsOf = (def, name) => {
    const returned = def && need(def.body, /RETURNS TABLE\(([\s\S]*?)\)\s*LANGUAGE/, `the columns ${name} returns (${def.file})`);
    return returned ? returned[1].split(',').map((c) => c.trim().split(/\s+/)[0]) : null;
  };
  const columns = columnsOf(list, 'list_my_sessions()');
  const theirs = lastDefinition('CREATE OR REPLACE FUNCTION public.person_sessions(', '$$;', 'person_sessions() in the applied chain');
  const theirColumns = columnsOf(theirs, 'person_sessions()');
  const labelBody = need(read('frontend/src/utils/sessions.js'), /export function sessionLabel\(session\) \{([\s\S]*?)\n\}/, 'sessionLabel() in frontend/src/utils/sessions.js');
  const labelReads = labelBody ? [...new Set([...labelBody[1].matchAll(/session\??\.([a-z_]+)/g)].map((m) => m[1]))] : null;
  need(read('frontend/src/components/tabs/AuditTrailTab.jsx'), /import \{ sessionLabel \} from '\.\.\/\.\.\/utils\/sessions'/, 'the Audit Trail naming a recorded session with sessionLabel()');
  if (columns && theirColumns) {
    const expected = columns.filter((c) => c !== 'is_current').join(', ');
    if (theirColumns.join(', ') === expected) {
      ok.push(`sessionsEnded: person_sessions() returns list_my_sessions()'s columns but is_current = "${expected}"`);
    } else {
      problems.push(`sessionsEnded: person_sessions() (${theirs.file}) returns "${theirColumns.join(', ')}", not list_my_sessions()'s columns but is_current ("${expected}", ${list.file})`);
    }
  }
  for (const fn of ['end_my_session', 'end_person_session']) {
    const end = lastDefinition(`CREATE OR REPLACE FUNCTION public.${fn}(`, '$$;', `${fn}() in the applied chain`);
    const built = end && need(end.body, /jsonb_build_object\(([^;]*?)\)\s*INTO v_session/, `the session ${fn}() records (${end.file})`);
    const recorded = built ? [...built[1].matchAll(/'([a-z_]+)'\s*,/g)].map((m) => m[1]) : null;
    if (!columns || !recorded || !labelReads) continue;
    const before = problems.length;
    for (const key of recorded.filter((k) => !columns.includes(k))) {
      problems.push(`sessionsEnded: ${fn}() (${end.file}) records ${key}, which list_my_sessions() (${list.file}) does not return`);
    }
    for (const field of labelReads.filter((f) => !recorded.includes(f))) {
      problems.push(`sessionsEnded: sessionLabel() reads ${field}, which ${fn}() (${end.file}) does not record`);
    }
    if (recorded.length === 0) problems.push(`sessionsEnded: found no field ${fn}() (${end.file}) records`);
    if (problems.length === before) {
      ok.push(`sessionsEnded: ${fn}() records ${recorded.join(', ')} of list_my_sessions()'s columns, and sessionLabel() reads ${labelReads.join(', ')}`);
    }
  }
}

// 30. Aber's own apps. 0002 registers each OAuth client the stack uses under a pinned id on every
// boot, and stack_app_ids() is the list remove_app() refuses and the Apps tab marks Part of Aber.
// An id seeded and not listed can be removed, and comes back at the next boot; an id listed and not
// seeded marks an app the stack does not register.
{
  const seed = read(`${MIGRATION_DIR}/0002_seed_data.sql`);
  const seeded = [...seed.matchAll(/v_client_id CONSTANT UUID := '([0-9a-f-]{36})'/g)].map((m) => m[1]).sort();
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const listed = ids ? [...ids.body.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]).sort() : null;
  if (seeded.length === 0) {
    problems.push('stackApps: found no pinned OAuth client id in 0002_seed_data.sql -- the shape changed, so this check is no longer checking anything');
  } else if (listed) {
    compare('stackApps', `the apps 0002 seeds and stack_app_ids() (${ids.file}) lists`, seeded.join(', '), listed.join(', '));
  }
}

// 48. What an app's token reaches at the gateway. The API listener's app check (supabase/envoy.yaml)
// admits a token GoTrue issued to one of the stack's apps on all of /auth/v1/, and on the functions
// that app calls, by client id; each door listener signs in as a client of its own. An id
// stack_app_ids() does not list is an app the stack does not register, given a route; an id it lists
// that the stack-apps-sign-in policy lacks is an app of the stack held to the sign-in endpoints an
// outside app has; a function with no directory, or one the edge runtime's allow-list
// (functions/main/index.ts) does not name, is a route to nothing.
{
  const before = problems.length;
  const envoy = read('supabase/envoy.yaml').replace(/\r\n/g, '\n');
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const listed = ids ? [...ids.body.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]) : [];
  const start = envoy.indexOf('\n    - name: gateway\n');
  const next = envoy.indexOf('\n    - name: ', start + 1);
  const gateway = start < 0 ? '' : envoy.slice(start, next < 0 ? undefined : next);
  const rbacAt = gateway.indexOf('- name: envoy.filters.http.rbac');
  const rbac = rbacAt < 0 ? '' : gateway.slice(rbacAt, gateway.indexOf('- name: envoy.filters.http.router', rbacAt));
  const lines = rbac.split('\n');
  const at = lines.findIndex((l) => /^\s*policies:\s*$/.test(l));
  const indent = at < 0 ? -1 : lines[at].search(/\S/) + 2;
  const routes = {};
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (line.length - line.trimStart().length === indent && /^\s*[a-z0-9-]+:\s*$/.test(line)) current = { ids: [], fns: [] };
    if (!current) continue;
    for (const m of line.matchAll(/string_match: \{ exact: ([0-9a-f-]{36}) \}/g)) current.ids.push(m[1]);
    for (const m of line.matchAll(/url_path: \{ path: \{ exact: "\/functions\/v1\/([a-z0-9-]+)" \} \}/g)) current.fns.push(m[1]);
    for (const id of current.ids) routes[id] = [...new Set([...(routes[id] || []), ...current.fns])];
  }
  const doors = [...envoy.matchAll(/^\s+client_id: ([0-9a-f-]{36})\s*$/gm)].map((m) => m[1]);
  const registry = read('supabase/functions/main/index.ts');
  const block = registry.slice(registry.indexOf('const FUNCTION_REGISTRY'), registry.indexOf('\n};', registry.indexOf('const FUNCTION_REGISTRY')));
  const registered = new Set([...block.matchAll(/^\s+"([a-z0-9-]+)": \[/gm)].map((m) => m[1]));

  if (!rbac || at < 0) {
    problems.push('appRoutes: found no app check (rbac policies) on the gateway listener in supabase/envoy.yaml -- the shape changed, so this check is no longer checking anything');
  } else if (Object.keys(routes).length === 0 || doors.length === 0 || registered.size === 0) {
    problems.push('appRoutes: found no app route, door client or registered function -- the shape changed, so this check is no longer checking anything');
  } else {
    for (const id of [...Object.keys(routes), ...doors].filter((x) => !listed.includes(x))) {
      problems.push(`appRoutes: supabase/envoy.yaml names the client ${id}, which stack_app_ids() (${ids?.file}) does not list: an app the stack does not register is given a route`);
    }
    for (const id of listed.filter((x) => !(x in routes))) {
      problems.push(`appRoutes: stack_app_ids() (${ids?.file}) lists the client ${id}, which the gateway's stack-apps-sign-in policy does not name: its token reaches the sign-in endpoints an outside app's does, and not the rest of /auth/v1/`);
    }
    for (const fn of Object.values(routes).flat()) {
      if (!existsSync(join(ROOT, 'supabase/functions', fn, 'index.ts'))) {
        problems.push(`appRoutes: the gateway admits an app's token to /functions/v1/${fn}, and supabase/functions/${fn}/index.ts does not exist`);
      } else if (!registered.has(fn)) {
        problems.push(`appRoutes: the gateway admits an app's token to /functions/v1/${fn}, which FUNCTION_REGISTRY in functions/main/index.ts does not name, so the edge runtime answers 404`);
      }
    }
    if (problems.length === before) {
      ok.push(`appRoutes: ${Object.entries(routes).map(([id, fns]) => `${id} -> ${fns.join(', ')}`).join('; ')}; the doors sign in as ${doors.join(', ')}; every id is in stack_app_ids() and every function exists and is registered`);
    }
  }
}

// 59. Every site that changes the platform for a covered role asks the MFA switch (0251). A write
// policy calls require_mfa() beside each has_role() arm naming Administrator or Shopfloor_Manager,
// in its final form and in storage-policies.sql; a function whose final body names either role in
// has_role() calls it too. Anything else is in supabase/mfa-exemptions.json with its reason, and an
// entry there that names no such site is stale. A new write policy or function with neither fails.
{
  const before = problems.length;
  const exemptions = JSON.parse(read('supabase/mfa-exemptions.json'));
  const COVERED = /has_role\(ARRAY\[[^\]]*'(?:Administrator|Shopfloor_Manager)'/g;
  const count = (text, re) => (text.match(re) || []).length;
  // A machine-capable permission guards these, and require_mfa() admits every caller without a
  // covered role, so they call it though has_role() is not theirs.
  const GATED_BY_AUTHORITY = ['fork_schema', 'publish_schema_version', 'discard_schema_draft'];

  // Final policy forms: the last CREATE POLICY of each name on each table, in replay order.
  const policies = new Map();
  for (const m of SCHEMA.matchAll(/^CREATE POLICY (\S+) ON (\S+) FOR (\w+) [^\n]*$/gm)) policies.set(`${m[2]} ${m[1]}`, { cmd: m[3], text: m[0] });
  for (const m of read('supabase/storage-policies.sql').matchAll(/^CREATE POLICY "([^"]+)" ON storage\.objects\s+FOR (\w+)([\s\S]*?\);)$/gm)) {
    policies.set(`storage.objects ${m[1]}`, { cmd: m[2], text: m[3] });
  }
  const writes = [...policies].filter(([, p]) => p.cmd !== 'SELECT' && count(p.text, COVERED) > 0);
  for (const [name, p] of writes) {
    if (name in exemptions.policies) continue;
    if (count(p.text, /require_mfa\(\)/g) < count(p.text, COVERED)) {
      problems.push(`mfaSites: the ${p.cmd} policy ${name} admits Administrator or Shopfloor_Manager without require_mfa() beside each has_role(): add it, or exempt it in supabase/mfa-exemptions.json with its reason`);
    }
  }
  for (const name of Object.keys(exemptions.policies)) {
    if (!writes.some(([n]) => n === name)) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts the policy ${name}, which is no write policy naming a covered role`);
  }

  // Final function bodies, by name.
  const bodies = new Map();
  for (const m of SCHEMA.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\([\s\S]*?\bAS (\$[a-z_]*\$)([\s\S]*?)\2/g)) bodies.set(m[1], m[3]);
  const sites = [...bodies].filter(([, body]) => count(body, COVERED) > 0).map(([name]) => name);
  const ungated = sites.filter((name) => !bodies.get(name).includes('require_mfa()') && !(name in exemptions.functions));
  for (const name of ungated) {
    problems.push(`mfaSites: ${name}() names Administrator or Shopfloor_Manager in has_role() and calls no require_mfa(): call it after the role check if it changes the platform, or exempt it in supabase/mfa-exemptions.json with its reason`);
  }
  for (const name of Object.keys(exemptions.functions)) {
    if (!sites.includes(name)) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts ${name}(), whose final body names no covered role in has_role()`);
    else if (bodies.get(name).includes('require_mfa()')) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts ${name}(), which calls require_mfa(): drop the entry`);
    if (!String(exemptions.functions[name]).trim()) problems.push(`mfaSites: the exemption of ${name}() gives no reason`);
  }
  for (const name of GATED_BY_AUTHORITY.filter((n) => !bodies.get(n)?.includes('require_mfa()'))) {
    problems.push(`mfaSites: ${name}() no longer calls require_mfa(); a person changes the platform through it`);
  }
  if (!writes.length || !sites.length) {
    problems.push('mfaSites: found no write policy or function naming a covered role -- the shape changed, so this check is no longer checking anything');
  } else if (problems.length === before) {
    const gated = sites.filter((n) => bodies.get(n).includes('require_mfa()')).length;
    ok.push(`mfaSites: ${writes.length} write policies and ${gated + GATED_BY_AUTHORITY.length} functions ask require_mfa(); ${Object.keys(exemptions.functions).length} functions are exempt, each with its reason`);
  }
}

// 60. The MFA switch's predicate, in its four places (0251): mfa_satisfied() and require_mfa() in
// 0001, the session ending in 0251, the edge functions' _shared/secondFactor.ts with the consent
// gate, and the dashboard's utils/secondFactor.js. Each names the same setting, roles, federated
// methods, refusal sentence and code, and the gate's Grafana is stack_app_ids()'s first app.
{
  const before = problems.length;
  const satisfied = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_satisfied()', '$$;', 'mfa_satisfied() in the applied chain');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.require_mfa()', '$$;', 'require_mfa() in the applied chain');
  const ending = lastDefinition('CREATE OR REPLACE FUNCTION public.end_covered_door_sessions(', '$$;', 'end_covered_door_sessions() in the applied chain');
  const trigger = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_grant_ends_door_sessions()', '$$;', 'mfa_grant_ends_door_sessions() in the applied chain');
  const switched = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_switch_ends_door_sessions()', '$$;', 'mfa_switch_ends_door_sessions() in the applied chain');
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const ts = read('supabase/functions/_shared/secondFactor.ts');
  const gate = read('supabase/functions/consent-gate/gate.ts');
  const web = read('frontend/src/utils/secondFactor.js');
  const seed = read(`${MIGRATION_DIR}/0002_seed_data.sql`);
  const list = (src) => (src ? [...src.matchAll(/["']([A-Za-z_/]+)["']/g)].map((m) => m[1]).sort().join(', ') : null);
  // A literal search, not a regex built from the name.
  const tsConst = (name) => {
    const head = `export const ${name} = `;
    const at = ts.indexOf(head);
    if (at < 0) {
      problems.push(`could not find ${name} in _shared/secondFactor.ts — the file's shape changed, so this check is no longer checking anything`);
      return null;
    }
    return ts.slice(at + head.length, ts.indexOf(';', at));
  };
  if (satisfied && guard && ending && trigger && switched && ids) {
    const setting = tsConst('MFA_SETTING')?.replace(/"/g, '');
    for (const [where, body] of [['mfa_satisfied()', satisfied.body], ['mfa_switch_ends_door_sessions()', switched.body], ['mfa_grant_ends_door_sessions()', trigger.body]]) {
      if (!body.includes(`'${setting}'`)) problems.push(`mfaPredicate: ${where} does not read ${setting}, the setting _shared/secondFactor.ts reads`);
    }
    if (!seed.includes(`'${setting}',\n    to_jsonb(false),\n    'boolean'`)) problems.push(`mfaPredicate: 0002 does not declare ${setting} as a boolean, off`);
    const roles = list(tsConst('COVERED_ROLES'));
    for (const [where, body] of [['mfa_satisfied()', satisfied.body], ['end_covered_door_sessions()', ending.body], ['mfa_grant_ends_door_sessions()', trigger.body]]) {
      compare('mfaPredicate', `the covered roles in ${where} and _shared/secondFactor.ts`, roles, list((body.match(/ARRAY\[([^\]]*)\]/) || [])[1]));
    }
    const federated = list(tsConst('FEDERATED_METHODS'));
    compare('mfaPredicate', 'the federated methods in mfa_satisfied() and _shared/secondFactor.ts', federated,
      [...satisfied.body.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]).sort().join(', '));
    compare('mfaPredicate', 'the federated methods in utils/secondFactor.js and _shared/secondFactor.ts', federated,
      list((web.match(/export const FEDERATED_METHODS = \[([^\]]*)\]/) || [])[1]));
    const sentence = tsConst('MFA_REFUSAL')?.replace(/^"|"$/g, '');
    compare('mfaPredicate', 'the refusal in require_mfa() and _shared/secondFactor.ts', sentence, (guard.body.match(/RAISE EXCEPTION '([^']+)'/) || [])[1]);
    compare('mfaPredicate', 'the refusal in utils/secondFactor.js and _shared/secondFactor.ts', sentence, (web.match(/export const MFA_REQUIRED_MESSAGE = '([^']+)'/) || [])[1]);
    compare('mfaPredicate', 'the refusal code in require_mfa() and _shared/secondFactor.ts', tsConst('MFA_REFUSAL_CODE')?.replace(/"/g, ''),
      (guard.body.match(/DETAIL = '([^']+)'/) || [])[1]);
    const grafana = (ids.body.match(/'([0-9a-f-]{36})'/) || [])[1];
    compare('mfaPredicate', "Grafana's app in consent-gate and stack_app_ids()", (gate.match(/GRAFANA_CLIENT_ID = "([0-9a-f-]{36})"/) || [])[1], grafana);
    compare('mfaPredicate', "the app end_covered_door_sessions() keeps and stack_app_ids()'s Grafana", (ending.body.match(/<> '([0-9a-f-]{36})'::uuid/) || [])[1], grafana);
    if (problems.length === before) ok.push('mfaPredicate: the setting, roles, federated methods, refusal and Grafana agree across 0001, 0251, the functions and the dashboard');
  }
}

// 2. Gateway staleness, derived at read time on both sides, so the two thresholds must agree. The
// view is built inside `ensure_gateway_status_view()`, which later migrations call after adding a
// gateways column; the latest redeclaration is the one that runs.
{
  const js = read('frontend/src/utils/gatewayStatus.js');
  // 90_000 -- numeric separators are legal JS and must be stripped before parsing.
  const jsMs = need(js, /HEARTBEAT_STALE_MS\s*=\s*([\d_]+)/, 'HEARTBEAT_STALE_MS in gatewayStatus.js');

  const view = lastDefinition(
    'CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view()',
    '$$;',
    'public.ensure_gateway_status_view()'
  );

  if (view && jsMs) {
    const intervals = [...new Set([...view.body.matchAll(/INTERVAL '(\d+) seconds'/g)].map((m) => m[1]))];
    if (intervals.length === 0) {
      problems.push(`gatewayStatus: no \`INTERVAL 'N seconds'\` in the gateway_status view body (${view.file})`);
    } else if (intervals.length > 1) {
      // live_status and is_stale must use one threshold, or a gateway can be STALE and not is_stale.
      problems.push(`gatewayStatus: the view uses more than one threshold: ${intervals.join(', ')} seconds (${view.file})`);
    } else {
      compare('gatewayStatus', `staleness threshold (ms), from ${view.file}`, Number(jsMs[1].replace(/_/g, '')), Number(intervals[0]) * 1000);
    }

    // The enrolment lifecycle states, mirrored by gatewayLiveStatus(). They must short-circuit
    // ahead of the staleness arm on both sides: a gateway in AWAITING_BIRTH has a `last_heartbeat`
    // from its previous life, so a staleness test reached first reports STALE for an appliance that
    // has not published yet.
    const sqlStates = [...new Set(
      [...view.body.matchAll(/'(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    const jsStates = [...new Set(
      [...js.matchAll(/export const GATEWAY_STATUS_[A-Z_]+ = '(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    compare('gatewayStatus', 'enrolment lifecycle states', jsStates.join(','), sqlStates.join(','));

    if (sqlStates.length === 2) {
      // Position, not presence: in the SQL the states must appear in a WHEN branch before the
      // INTERVAL comparison, and in the JS before isHeartbeatStale() is consulted.
      const sqlLifecycleAt = view.body.search(/WHEN[^\n]*PENDING_ENROLLMENT/);
      const sqlStaleAt = view.body.search(/INTERVAL '\d+ seconds'/);
      const jsLifecycleAt = js.search(/GATEWAY_STATUS_PENDING_ENROLMENT|PENDING_ENROLLMENT/);
      const jsStaleAt = js.search(/isHeartbeatStale\(/);
      const sqlFirst = sqlLifecycleAt >= 0 && sqlStaleAt >= 0 && sqlLifecycleAt < sqlStaleAt;
      const jsFirst = jsLifecycleAt >= 0 && jsStaleAt >= 0 && jsLifecycleAt < jsStaleAt;
      if (!sqlFirst || !jsFirst) {
        problems.push(
          `gatewayStatus: the enrolment states must be decided BEFORE the staleness test on both sides ` +
            `(SQL ${sqlFirst ? 'ok' : 'WRONG ORDER'} in ${view.file}, JS ${jsFirst ? 'ok' : 'WRONG ORDER'}). ` +
            `An AWAITING_BIRTH gateway carries a stale last_heartbeat from its previous life and would report STALE.`
        );
      } else {
        ok.push('gatewayStatus: enrolment states short-circuit ahead of staleness on both sides');
      }
    }

    if (view.redeclarations > 1) {
      ok.push(`gatewayStatus: read the LAST of ${view.redeclarations} declarations of ensure_gateway_status_view() (${view.file})`);
    }
  }
}

// 68. What a change of type ends, one rule in the trigger and the Edit form (0252). The trigger, and
// 0252's one-off clean-up, move a gateway that leaves Remote out of the enrolment states
// gatewayStatus.js counts as pending. The form says a setup command is cancelled for the state
// issue_gateway_enrollment_token() writes, and reads a Remote gateway's credential from the column
// gateway_has_broker_credential()'s remote arm reads. A state one side adds leaves a gateway reading
// Awaiting setup after its type changed; another column has the form say nothing ends where the
// trigger revokes.
{
  const js = read('frontend/src/utils/gatewayStatus.js');
  const constants = new Map([...js.matchAll(/export const (GATEWAY_STATUS_[A-Z_]+) = '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]));
  const pending = need(js, /const PENDING_STATUSES = new Set\(\[([^\]]*)\]\)/, 'PENDING_STATUSES in gatewayStatus.js');
  const jsStates = pending
    ? [...pending[1].matchAll(/[A-Z_]+/g)].map((m) => constants.get(m[0]) ?? `(unresolved ${m[0]})`).sort().join(',')
    : null;
  const list = (text) => [...text.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort().join(',');

  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change(', '$$;',
    'clean_up_after_a_gateway_type_change()');
  const trigger = fn && need(fn.body, /NEW\.status IN \(([^)]*)\) THEN\s+NEW\.status := 'OFFLINE'/,
    `the states clean_up_after_a_gateway_type_change() ends (${fn.file})`);
  const cleanUp = need(SCHEMA, /UPDATE public\.gateways\s+SET status = 'OFFLINE'\s+WHERE deployment <> 'remote'\s+AND status IN \(([^)]*)\)/,
    "0252's one-off clean-up of the enrolment states");
  if (jsStates && trigger) compare('gatewayTypeChange', `the enrolment states the trigger ends (${fn.file}) and PENDING_STATUSES`, jsStates, list(trigger[1]));
  if (jsStates && cleanUp) compare('gatewayTypeChange', "the enrolment states 0252's clean-up ends and PENDING_STATUSES", jsStates, list(cleanUp[1]));

  const type = read('frontend/src/utils/gatewayType.js');
  const issue = lastDefinition('CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(', '$$;', 'issue_gateway_enrollment_token()');
  const issued = issue && need(issue.body, /UPDATE public\.gateways\s+SET status = '([A-Z_]+)'/, `the status issue_gateway_enrollment_token() writes (${issue.file})`);
  const jsSetup = need(type, /wasRemote && stored\.status === '([A-Z_]+)'/, "gatewayTypeChange()'s setup state in utils/gatewayType.js");
  if (issued && jsSetup) compare('gatewayTypeChange', `the state a setup command leaves (${issue.file}) and the form's`, jsSetup[1], issued[1]);

  const has = lastDefinition('CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(', '$$;', 'gateway_has_broker_credential()');
  const arm = has && need(has.body, /g\.deployment = 'remote' AND g\.([a-z_]+) IS NOT NULL/, `gateway_has_broker_credential()'s remote arm (${has.file})`);
  const jsArm = need(read('frontend/src/components/tabs/GatewaysTab.jsx'), /editingRemote \? !!editing\.([a-z_]+)/,
    "the Edit form's Remote credential in GatewaysTab.jsx");
  if (arm && jsArm) compare('gatewayTypeChange', `the column a Remote gateway's credential is read from (${has.file}) and the form's`, jsArm[1], arm[1]);
}

// 41. The playback worker's staleness. The playback dialog reads a heartbeat older than
// WORKER_STALE_MS as a worker that is not running, and platform_health_rows() raises
// playback_worker_stale past the same age, and leaves a playback out of job_stuck before it. Two
// thresholds would let the dialog call the worker running while the alert says it is not.
{
  const js = read('frontend/src/components/modals/StartPlaybackModal.jsx');
  const jsMs = need(js, /WORKER_STALE_MS\s*=\s*([\d_ *]+)\n/, 'WORKER_STALE_MS in StartPlaybackModal.jsx');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_health_rows()', '$$;',
    'public.platform_health_rows()');
  if (jsMs && fn) {
    const ms = jsMs[1].split('*').map((n) => Number(n.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
    const stale = need(fn.body.slice(fn.body.indexOf("'playback_worker_stale'::text")),
      /reported_at < now\(\) - interval '(\d+) minutes'/, `the playback_worker_stale arm's age (${fn.file})`);
    const fresh = need(fn.body.slice(fn.body.indexOf("'job_stuck'::text")),
      /reported_at >= now\(\) - interval '(\d+) minutes'/, `the job_stuck arm's heartbeat test (${fn.file})`);
    if (stale) compare('playbackWorkerStale', `the stale-worker alert's age (ms), from ${fn.file}`, ms, Number(stale[1]) * 60000);
    if (fresh) compare('playbackWorkerStale', `the age job_stuck leaves to it (ms), from ${fn.file}`, ms, Number(fresh[1]) * 60000);
  }
}

// 9. The historian's next backup. The Backups page says when the sidecar takes its next backup and
// which type by running nextHistorianBackup(); the sidecar decides with physical_backup_missed_slot()
// and physical_backup_type() in timescaledb/physical_backup.sql. The page's function is run at the
// boundary each SQL rule states, so a re-tuned threshold or a flipped comparison fails here rather
// than as a page promising a backup the sidecar will not take.
{
  const { nextHistorianBackup } = await import(
    pathToFileURL(join(ROOT, 'frontend/src/utils/historianBackupSchedule.js')).href
  );
  const sql = read('timescaledb/physical_backup.sql');
  const flatBody = (name) => {
    const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? '' : sql.slice(at, sql.indexOf('$;', at)).replace(/\s+/g, ' ');
  };
  const slotSql = flatBody('physical_backup_missed_slot');
  const typeSql = flatBody('physical_backup_type');
  const utcSlot = need(slotSql,
    /date_trunc\('day', p_now AT TIME ZONE 'UTC'\) \+ make_interval\(hours => p_hour\)/,
    'the UTC daily slot in physical_backup_missed_slot()');
  const slotRule = need(slotSql, /CASE WHEN at (<=?) p_now THEN at ELSE at - interval '(\d+) days?' END/,
    'the latest-slot rule in physical_backup_missed_slot()');
  const attemptRule = need(slotSql, /r\.kind IN \(([^)]*)\) AND r\.started_at (>=?) s\.at/,
    'the attempted-since rule in physical_backup_missed_slot()');
  const weekdayRule = need(typeSql,
    /WHEN extract\(dow FROM p_slot AT TIME ZONE 'UTC'\) = p_full_on THEN 'full'/,
    'the weekday rule in physical_backup_type()');
  const ageRule = need(typeSql, /WHEN f\.newest IS NULL OR f\.newest (<=?) p_now - interval '(\d+) days' THEN 'full'/,
    'the no-full and age rules in physical_backup_type()');

  const DAY = 24 * 60 * 60 * 1000;
  const HOUR_UTC = 2;
  const slot = Date.UTC(2026, 0, 7, HOUR_UTC);
  const iso = (ms) => new Date(ms).toISOString();
  const dow = (ms) => new Date(ms).getUTCDay();
  // Attempted at the slot, so the next is tomorrow's, `at`; full_on is then never at's weekday
  // unless a probe sets it.
  const at = slot + DAY;
  const offDay = (dow(at) + 3) % 7;
  const plan = (fields, now) => nextHistorianBackup({ hour_utc: HOUR_UTC, full_on: offDay, ...fields }, now);
  const kindWith = (lastFull, fullOn = offDay) =>
    plan({ last_attempt_at: iso(slot), last_full_at: lastFull === null ? null : iso(lastFull), full_on: fullOn }, slot + 3_600_000).kind;

  if (utcSlot && slotRule) {
    const onTheSlot = plan({ last_full_at: iso(slot - DAY) }, slot);
    compare('historianBackup', 'a slot reached exactly is today\'s (at <= now)',
      onTheSlot.at === slot ? '<=' : '<', slotRule[1]);
    const before = plan({ last_full_at: iso(slot - DAY) }, slot - 1);
    compare('historianBackup', 'the step back to the previous slot (days)', (slot - before.at) / DAY, slotRule[2]);
  }
  if (attemptRule) {
    const atSlot = plan({ last_attempt_at: iso(slot), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    const earlier = plan({ last_attempt_at: iso(slot - 1), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    if (!earlier.due) {
      problems.push('historianBackup: the page counts an attempt before the slot as one since it; the sidecar does not');
    } else {
      compare('historianBackup', 'an attempt at the slot counts (started_at >= slot)', atSlot.due ? '>' : '>=', attemptRule[2]);
    }

    // The page reads last_attempt_at from historian_backup_state(), every run but one kind; the
    // sidecar counts the kinds in its IN list. They agree while that list is every other kind.
    const runKinds = need(sql, /kind\s+text\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/, 'the run kinds in physical_backup_runs');
    const state = lastDefinition('CREATE OR REPLACE FUNCTION public.historian_backup_state()', '$;',
      'public.historian_backup_state()');
    const excluded = state && need(state.body.replace(/\s+/g, ' '),
      /\(SELECT max\(b\.started_at\) FROM runs b WHERE b\.kind <> '(\w+)'\)/,
      `last_attempt_at in historian_backup_state() (${state.file})`);
    if (runKinds && excluded) {
      const list = (s) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort().join(',');
      const counted = list(runKinds[1]).split(',').filter((k) => k !== excluded[1]).join(',');
      compare('historianBackup', `the run kinds that count as an attempt, from ${state.file}`, counted, list(attemptRule[1]));
    }
  }
  if (weekdayRule) {
    if (kindWith(slot - DAY, dow(at)) !== 'full' || kindWith(slot - DAY) !== 'diff') {
      problems.push('historianBackup: the page does not take a full on full_on\'s UTC weekday and a differential otherwise, as the sidecar does');
    } else {
      ok.push('historianBackup: a full on full_on\'s UTC weekday on both sides');
    }
  }
  if (ageRule) {
    if (kindWith(null) !== 'full') {
      problems.push('historianBackup: with no full yet the page expects a differential; the sidecar takes a full');
    }
    let days = null;
    for (let n = 1; n <= 60 && days === null; n += 1) {
      if (kindWith(at - n * DAY - 1) === 'full' && kindWith(at - n * DAY + 1) === 'diff') days = n;
    }
    const op = days === null ? '?' : kindWith(at - days * DAY) === 'full' ? '<=' : '<';
    compare('historianBackup', 'a full when the newest is older than', `${op} ${days} days`, `${ageRule[1]} ${ageRule[2]} days`);
  }
}

// 9b. The platform database's next backup. 0173 declares the historian's record and schedule
// functions in the platform database under the same names, and the Backups page runs the one
// nextHistorianBackup() for both, so section 9 covers the platform's sidecar only while each body is
// the historian's, the run kinds are the same, and platform_backup_state() counts an attempt as
// historian_backup_state() does.
{
  const historian = read('timescaledb/physical_backup.sql');
  const flat = (text) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const fn = (text, name) => {
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? null : flat(text.slice(at, text.indexOf('$;', at)));
  };
  for (const name of ['physical_backup_record', 'physical_backup_missed_slot', 'physical_backup_type',
    'physical_backup_record_schedule']) {
    const theirs = fn(historian, name);
    const ours = lastDefinition(`CREATE OR REPLACE FUNCTION public.${name}(`, '$;', `public.${name}() in the platform database`);
    if (!theirs) problems.push(`platformBackup: timescaledb/physical_backup.sql no longer declares ${name}()`);
    else if (ours && flat(ours.body) !== theirs) {
      problems.push(`platformBackup: ${name}() in ${ours.file} is not the historian's body (timescaledb/physical_backup.sql)`);
    } else if (ours) ok.push(`platformBackup: ${name}() in ${ours.file} is the historian's`);
  }
  const kinds = (text, what) => need(flat(text), /kind text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/, what)?.[1];
  const ourTable = lastDefinition('CREATE TABLE IF NOT EXISTS public.physical_backup_runs', ');', 'physical_backup_runs in the platform database');
  if (ourTable) {
    compare('platformBackup', 'the run kinds', kinds(ourTable.body, `the run kinds in ${ourTable.file}`),
      kinds(historian, 'the run kinds in timescaledb/physical_backup.sql'));
  }
  const attempt = (needle) => {
    const state = lastDefinition(needle, '$;', needle.slice(27));
    return state && need(flat(state.body), /\(SELECT max\(b\.started_at\) FROM runs b WHERE b\.kind <> '(\w+)'\)/,
      `last_attempt_at in ${needle.slice(27)}`)?.[1];
  };
  compare('platformBackup', 'the run kind last_attempt_at leaves out',
    attempt('CREATE OR REPLACE FUNCTION public.platform_backup_state()'),
    attempt('CREATE OR REPLACE FUNCTION public.historian_backup_state()'));
}

// 3. Effective cell resolution. NULL cell_id means inherit, so the COALESCE precedence is the rule:
// device first, gateway second.
{
  const js = read('frontend/src/utils/cellResolution.js');
  const view = lastDefinition(
    'CREATE OR REPLACE VIEW public.device_locations',
    ';',
    'public.device_locations'
  );

  if (view) {
    const body = view.body;

    const sqlCoalesce = need(body, /COALESCE\((\w)\.cell_id,\s*(\w)\.cell_id\)/, 'COALESCE precedence in device_locations');
    if (sqlCoalesce) {
      compare('cellResolution', 'COALESCE precedence', 'device,gateway',
        `${sqlCoalesce[1] === 'd' ? 'device' : 'gateway'},${sqlCoalesce[2] === 'g' ? 'gateway' : 'device'}`);
    }

    // The three arms that resolve to no cell must do so on both sides: site-wide by assertion,
    // shadow and simulated because they are lanes rather than places. The JS pattern tolerates the
    // arms as one disjunction but requires each term.
    const flat = body.replace(/\s+/g, ' ');
    const nullArms = [
      ['site_wide', /WHEN \(d\.location_scope = 'site_wide'::text\) THEN NULL::uuid/.test(flat),
        /scope === SCOPE_SITE_WIDE[^?]*\? null :/.test(js)],
      ['shadow', /WHEN COALESCE\(g\.is_shadow, false\) THEN NULL::uuid/.test(flat),
        /\(\s*shadow \|\|/.test(js)],
      ['simulated', /WHEN COALESCE\(g\.is_simulated, false\) THEN NULL::uuid/.test(flat),
        /\|\| simulated \|\|/.test(js)]
    ];
    for (const [arm, sqlOk, jsOk] of nullArms) {
      if (!sqlOk || !jsOk) {
        problems.push(`cellResolution: the ${arm} branch must resolve to no cell on both sides (SQL ${sqlOk ? 'ok' : 'MISSING'}, JS ${jsOk ? 'ok' : 'MISSING'})`);
      } else {
        ok.push(`cellResolution: ${arm} resolves to no cell on both sides`);
      }
    }

    // Precedence: a shadow gateway is necessarily simulated, so testing simulated first makes the
    // shadow lane unreachable. Both sides must ask about shadow first.
    const sqlShadowFirst = flat.indexOf("THEN 'shadow'::text") < flat.indexOf("THEN 'simulated'::text");
    const jsShadowFirst = js.indexOf('if (shadow) source = SOURCE_SHADOW') < js.indexOf('source = SOURCE_SIMULATED');
    if (!sqlShadowFirst || !jsShadowFirst) {
      problems.push(`cellResolution: shadow must be tested before simulated on both sides (SQL ${sqlShadowFirst ? 'ok' : 'WRONG ORDER'}, JS ${jsShadowFirst ? 'ok' : 'WRONG ORDER'})`);
    } else {
      ok.push('cellResolution: shadow resolves ahead of simulated on both sides');
    }

    // The seven location_source labels are a closed set the UI switches on. `THEN` and `ELSE`,
    // because 'unassigned' is the CASE's fall-through. The alternation is spelled out so adding a
    // lane is a deliberate edit here too.
    const sqlSources = [...new Set([...body.matchAll(/(?:THEN|ELSE) '(site_wide|area_wide|explicit|inherited|unassigned|simulated|shadow)'::text/g)].map((m) => m[1]))].sort();
    const jsSources = [...new Set([...js.matchAll(/export const SOURCE_[A-Z_]+ = '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    compare('cellResolution', 'location_source labels', jsSources.join(','), sqlSources.join(','));
  }
}

// 27. A device's place in the Unified Namespace. device_uns_paths gives each skipped device one
// reason; the bridge counts it under that label on aber_ingestion_uns_skipped_total, and the
// dashboard says it in words. A reason the view gives and the bridge does not label is counted as
// location_unknown, and one the dashboard has no sentence for reads as unexplained. The bridge's
// two run-time reasons are its own. And the bridge selects the view's columns by name.
{
  const view = lastDefinition('CREATE OR REPLACE VIEW public.device_uns_paths', ';', 'public.device_uns_paths');
  const py = read('ingestion/uns_publish.py');
  const js = read('frontend/src/utils/unsPath.js');
  const pyReasons = need(py, /^SKIP_REASONS = \(([\s\S]*?)^\)/m, 'SKIP_REASONS in uns_publish.py');
  const jsSentences = need(js, /^const SKIP_SENTENCES = \{([\s\S]*?)^\}/m, 'SKIP_SENTENCES in unsPath.js');
  const pySelect = need(py, /\.table\(PATH_VIEW\)\s*\.select\("([^"]+)"\)/, "uns_publish.py's select on PATH_VIEW");
  const pyView = need(py, /^PATH_VIEW = "([a-z_]+)"/m, 'PATH_VIEW in uns_publish.py');
  if (view && pyReasons && jsSentences && pySelect && pyView) {
    const sqlReasons = [...new Set([...view.body.matchAll(/THEN '([a-z_]+)'::text/g)].map((m) => m[1]))].sort();
    const python = [...pyReasons[1].matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]);
    const runtime = python.filter((r) => !sqlReasons.includes(r)).sort();
    const sentences = [...jsSentences[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    compare('unsPath', `reasons the bridge labels beyond the view's (${view.file})`, 'location_unknown,publish_error', runtime.join(','));
    compare('unsPath', 'reasons the view gives that the bridge labels', sqlReasons.filter((r) => python.includes(r)).join(','), sqlReasons.join(','));
    compare('unsPath', "reasons the dashboard words, and the view's", sentences.join(','), sqlReasons.join(','));
    compare('unsPath', 'the view the bridge reads', pyView[1], 'device_uns_paths');
    const viewColumns = need(read(`${MIGRATION_DIR}/${view.file}`), /IS DISTINCT FROM '([a-z_,]+)'/,
      `the column list ${view.file}'s self-check asserts`);
    if (viewColumns) {
      const missing = pySelect[1].split(',').filter((col) => !viewColumns[1].split(',').includes(col));
      compare('unsPath', "columns the bridge selects that the view's self-check does not hold", '', missing.join(','));
    }
  }
}

// 4. RBAC grants. `DEFAULT_ROLE_PERMISSIONS_MAP` in usePermissions.js is the static fallback the
// dashboard renders from when no `role_permissions` rows resolve, so a divergence offers controls
// the database refuses, or hides a capability. The SQL side is replayed, not read from one file:
// the seed grants and a later migration withdraws.
{
  const constants = read('frontend/src/constants.js');
  const hook = read('frontend/src/hooks/usePermissions.js');

  /** A named block's body, bounded by the first `};` after its declaration. */
  const block = (source, declaration, what) => {
    const at = source.indexOf(declaration);
    if (at < 0) {
      problems.push(`rbacGrants: could not find ${what} -- the file's shape changed, so this check is no longer checking anything`);
      return null;
    }
    const stop = source.indexOf('};', at);
    return source.slice(at, stop < 0 ? undefined : stop);
  };

  const permBlock = block(constants, 'export const PERMISSION_UUIDS = {', 'PERMISSION_UUIDS in constants.js');
  const mapBlock = block(hook, 'const DEFAULT_ROLE_PERMISSIONS_MAP = {', 'DEFAULT_ROLE_PERMISSIONS_MAP in usePermissions.js');

  if (permBlock && mapBlock) {
    // KEY -> uuid, so a disagreement can be reported by the name a reader recognises. Bounded to
    // the PERMISSION_UUIDS block: constants.js carries other uuid-shaped literals.
    const uuidByKey = new Map([...permBlock.matchAll(/(\w+):\s*'([0-9a-f-]{36})'/g)].map((m) => [m[1], m[2]]));
    const keyByUuid = new Map([...uuidByKey].map(([k, v]) => [v, k]));
    const everyPermission = [...uuidByKey.values()];

    // Each role's entry is either the whole set or an explicit list. `Object.values(...)` is
    // Administrator's spelling: it holds every permission by definition.
    const jsGrants = new Map();
    for (const m of mapBlock.matchAll(/(\w+):\s*(Object\.values\(PERMISSION_UUIDS\)|\[[^\]]*\])/g)) {
      const [, role, value] = m;
      const uuids = value.startsWith('Object.values')
        ? everyPermission
        : [...value.matchAll(/PERMISSION_UUIDS\.(\w+)/g)].map((p) => uuidByKey.get(p[1]));
      if (uuids.some((u) => u === undefined)) {
        problems.push(`rbacGrants: ${role} names a PERMISSION_UUIDS key that constants.js does not declare`);
        continue;
      }
      jsGrants.set(role, new Set(uuids));
    }

    const roleNameById = new Map(
      [...SCHEMA.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '(\w+)'/g)].map((m) => [m[1], m[2]])
    );

    const sqlGrants = new Map([...roleNameById.values()].map((name) => [name, new Set()]));
    for (const m of SCHEMA.matchAll(/INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)/g)) {
      const role = roleNameById.get(m[1]);
      if (role) sqlGrants.get(role).add(m[2]);
    }

    // The withdrawals, and the parser refuses to guess: only the `role_id = N AND permission_id IN
    // (...)` shape is understood, so a DELETE written another way fails rather than being counted
    // and not applied.
    const deleteStatements = [...SCHEMA.matchAll(/DELETE FROM public\.role_permissions/g)].length;
    const parsedDeletes = [...SCHEMA.matchAll(
      /DELETE FROM public\.role_permissions\s+WHERE role_id = (\d+)\s+AND permission_id IN \(([^;]*?)\);/g
    )];
    if (parsedDeletes.length !== deleteStatements) {
      problems.push(
        `rbacGrants: the chain has ${deleteStatements} DELETE(s) from role_permissions and this check ` +
          `understands ${parsedDeletes.length} of them. Teach it the new shape -- an unparsed withdrawal ` +
          `makes the SQL side look more generous than the database is.`
      );
    }
    for (const m of parsedDeletes) {
      const role = roleNameById.get(m[1]);
      if (!role) continue;
      for (const u of m[2].matchAll(/'([0-9a-f-]{36})'/g)) sqlGrants.get(role).delete(u[1]);
    }

    const named = (set) => [...set].map((u) => keyByUuid.get(u) || u).sort().join(',');
    for (const [role, jsSet] of jsGrants) {
      const sqlSet = sqlGrants.get(role);
      if (!sqlSet) {
        problems.push(`rbacGrants: usePermissions.js has a fallback for '${role}', which public.roles does not seed`);
        continue;
      }
      compare('rbacGrants', `${role}'s permissions`, named(jsSet), named(sqlSet));
    }

    // The other direction: a role seeded with grants and missing from the map falls through to no
    // permissions when the embed comes back empty.
    const unmapped = [...sqlGrants].filter(([role, set]) => set.size > 0 && !jsGrants.has(role)).map(([role]) => role);
    if (unmapped.length) {
      problems.push(
        `rbacGrants: ${unmapped.join(', ')} hold(s) seeded permissions with no entry in ` +
          `DEFAULT_ROLE_PERMISSIONS_MAP, so the fallback renders an empty dashboard for that role`
      );
    } else {
      ok.push(`rbacGrants: every seeded role has a fallback entry (${jsGrants.size} roles)`);
    }
  }
}

// 16. A pinned machine identity's name and renewal, JavaScript to SQL. The Access Control page names
// the pinned identities from KNOWN_PRINCIPALS; service_token_health_rows() names them for the
// Service Token Expiring alert, and says which renew with `npm run keys:rotate`, the identities whose
// mintCommand is that. Apart, the alert names an identity the page does not list under that name,
// or tells an Administrator to issue a token the page does not offer.
{
  const js = read('frontend/src/utils/serviceIdentities.js');
  const block = need(js, /export const KNOWN_PRINCIPALS = \{([\s\S]*?)\n\}/, 'KNOWN_PRINCIPALS in serviceIdentities.js');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.service_token_health_rows()', '$$;',
    'public.service_token_health_rows()');
  if (block && fn) {
    const jsRows = [...block[1].matchAll(/'([0-9a-f-]{36})': \{\s*name: '([^']+)'[\s\S]*?mintCommand: '([^']+)'/g)]
      .map((m) => `${m[1]} ${m[2]} ${m[3] === 'npm run keys:rotate' ? 'keys_rotate' : 'access_control'}`);
    const sqlRows = [...fn.body.matchAll(/\('([0-9a-f-]{36})'::uuid, '([^']+)', '(\w+)'\)/g)]
      .map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    if (jsRows.length === 0 || sqlRows.length === 0) {
      problems.push(`pinnedIdentities: found no pinned identity in ${jsRows.length ? fn.file : 'KNOWN_PRINCIPALS'} -- the shape changed, so this check is no longer checking anything`);
    } else {
      compare('pinnedIdentities', `name and renewal of each pinned identity, from ${fn.file}`,
        jsRows.sort().join('; '), sqlRows.sort().join('; '));
    }
  }
}

// 5. RETIRED BY 0108. `proposable_link_tags()` was dropped with the three link proposal lanes it
// validated for; a link has only ever been attached by the direct edit, which stores `link_tag`
// against no CHECK. The tag vocabulary now lives in EntityLinksModal alone, so there is no second
// copy here to drift from.

// 6. The Directory's local-namespace qualification, TypeScript to Python. `schemas.id` and
// `directory_services.id` are locally minted, and the edge function and `directory_publish.py` both
// attach the qualification; the strings are compared, since two different sentences would read as
// two different claims, and the MQTT half is where it matters most, with no route or documentation
// beside the bytes.
{
  const ts = read('supabase/functions/fplus-directory/index.ts');
  const py = read('ingestion/directory_publish.py');
  const tsNote = need(ts, /const LOCAL_SCHEMA_NOTE = "([^"]+)"/, 'LOCAL_SCHEMA_NOTE in fplus-directory/index.ts');
  const pyNote = need(py, /^LOCAL_SCHEMA_NOTE = "([^"]+)"/m, 'LOCAL_SCHEMA_NOTE in directory_publish.py');
  if (tsNote && pyNote) {
    compare('directoryNamespaceNote', 'the local-schema qualification', pyNote[1], tsNote[1]);
  }

  // The service note is a string literal inline in the /v1/service handler rather than a named
  // constant. Checked in the same pair so the second qualification cannot drift.
  const tsService = need(ts, /note: "(Stack service endpoints[^"]+)"/, 'the /v1/service note in fplus-directory/index.ts');
  const pyService = need(py, /^LOCAL_SERVICE_NOTE = "([^"]+)"/m, 'LOCAL_SERVICE_NOTE in directory_publish.py');
  if (tsService && pyService) {
    compare('directoryServiceNote', 'the local-service qualification', pyService[1], tsService[1]);
  }
}

// 39. The System page's figures, by name. 0223 seeds one directory_figures row per figure, and the
// page reads each row by its key (FIGURE_KEYS in frontend/src/utils/systemFigures.js). A key on one
// side only is a tile that reads "not observed" for ever, which looks like Prometheus not answering.
// The API reference's DirectoryFigure enum names the same seven.
{
  const seed = SCHEMA.slice(SCHEMA.lastIndexOf('INSERT INTO public.directory_figures (key) VALUES'));
  const seeded = need(seed, /^INSERT INTO public\.directory_figures \(key\) VALUES([\s\S]*?)ON CONFLICT/,
    'the directory_figures seed in the applied migrations');
  const js = need(read('frontend/src/utils/systemFigures.js'), /export const FIGURE_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/,
    'FIGURE_KEYS in frontend/src/utils/systemFigures.js');
  const spec = need(read('docs/openapi.yaml'), /\n {4}DirectoryFigure:\n[\s\S]*?enum: \[([^\]]*)\]/,
    "DirectoryFigure's key enum in docs/openapi.yaml");
  if (seeded && js && spec) {
    const keys = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const sql = keys(seeded[1], /\('([a-z_]+)'\)/g);
    compare('systemFigureKeys', 'the figures the System page reads', keys(js[1], /'([a-z_]+)'/g), sql);
    compare('systemFigureKeys', 'the figures the API reference names', keys(spec[1], /([a-z_]+)/g), sql);
  }
}

// 47. History's read, one rule in two places. telemetry_carried() (0233) reads the rollup whose
// width divides the bucket, and api.js names the same rollups and widths (TELEMETRY_RESOLUTIONS),
// from which History's resolutions are built. A width only one side has is a resolution the page
// offers and the function reads from a coarser rollup, or the other way. Each of History's widths
// must be a bucket the function takes, and the page's row cap must fit under the function's bound.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const rollups = need(api, /const TELEMETRY_RESOLUTIONS = \{([\s\S]*?)\n\};/, 'TELEMETRY_RESOLUTIONS in frontend/src/api.js');
  const history = need(api, /export const HISTORY_RESOLUTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/, 'HISTORY_RESOLUTIONS in frontend/src/api.js');
  const cap = need(api, /^const TELEMETRY_MAX_ROWS = (\d+);$/m, 'TELEMETRY_MAX_ROWS in frontend/src/api.js');
  if (def && rollups && history && cap) {
    const UNIT_MINUTES = { minute: 1, minutes: 1, hour: 60, hours: 60 };
    const sql = [...def.body.matchAll(/v_source := '(telemetry_\w+)'; v_width := interval '(\d+) (minutes?|hours?)'/g)]
      .map((m) => `${m[1]}=${Number(m[2]) * UNIT_MINUTES[m[3]]}`).sort().join(', ');
    const js = [...rollups[1].matchAll(/relation: '(telemetry_\w+)', bucketMinutes: (\d+)/g)]
      .map((m) => `${m[1]}=${m[2]}`).sort().join(', ');
    compare('historyRead', 'the rollups and their widths in minutes, in api.js and telemetry_carried()', js, sql);

    const bound = need(def.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${def.file}`);
    const least = need(def.body, /v_secs < (\d+) OR v_secs % (\d+) <> 0/, `the smallest bucket in ${def.file}`);
    if (bound && least) {
      if (Number(cap[1]) > Number(bound[1])) {
        problems.push(`historyRead: the page's row cap (${cap[1]}) is over telemetry_carried()'s bound (${bound[1]}), so a read the page makes is refused`);
      } else {
        ok.push(`historyRead: the page's row cap (${cap[1]}) fits under telemetry_carried()'s bound (${bound[1]})`);
      }
      // History's widths, each as minutes: a literal, or a rollup's bucketMinutes by its key.
      const byKey = Object.fromEntries([...rollups[1].matchAll(/'(\w+)': \{ relation: '\w+', bucketMinutes: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
      const widths = [...history[1].matchAll(/minutes: (?:TELEMETRY_RESOLUTIONS\['(\w+)'\]\.bucketMinutes|(\d+))/g)]
        .map((m) => (m[1] ? byKey[m[1]] : Number(m[2])));
      const refused = widths.filter((w) => !(Number.isInteger(w) && w * 60 >= Number(least[1]) && (w * 60) % Number(least[2]) === 0));
      if (!widths.length) {
        problems.push('historyRead: found no width in HISTORY_RESOLUTIONS -- its shape changed, so this check is no longer checking anything');
      } else if (refused.length) {
        problems.push(`historyRead: History offers ${refused.join(', ')}-minute buckets, which telemetry_carried() refuses`);
      } else {
        ok.push(`historyRead: telemetry_carried() takes each of History's ${widths.length} widths (${widths.join(', ')} minutes)`);
      }
    }
  }
}

// 69. History's change read, one rule in two places. telemetry_changes() (0254) falls back past
// its default max_changes and past the raw readings one series may bring across, and reads at most
// so many series; api.js states the same for the page, which passes that cap, names both in its
// words and reads in parts of that many series. A value only one side has is a chart labelled with
// a cap the function does not hold, or a read the function refuses.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_changes(', '$fn$;', 'telemetry_changes()');
  const api = read('frontend/src/api.js');
  const changes = need(api, /^export const HISTORY_MAX_CHANGES = (\d+);$/m, 'HISTORY_MAX_CHANGES in frontend/src/api.js');
  const readings = need(api, /^export const HISTORY_CHANGE_READINGS = (\d+);$/m, 'HISTORY_CHANGE_READINGS in frontend/src/api.js');
  const series = need(api, /^export const HISTORY_CHANGE_SERIES = (\d+);$/m, 'HISTORY_CHANGE_SERIES in frontend/src/api.js');
  if (def && changes && readings && series) {
    const sqlDefault = need(def.body, /max_changes integer DEFAULT (\d+)/, `max_changes' default in ${def.file}`);
    const sqlMost = need(def.body, /c_max_changes\s+CONSTANT integer := (\d+);/, `the most max_changes may be in ${def.file}`);
    const sqlReadings = need(def.body, /c_max_readings CONSTANT bigint := (\d+);/, `the readings bound in ${def.file}`);
    const sqlSeries = need(def.body, /c_max_series\s+CONSTANT integer := (\d+);/, `the series bound in ${def.file}`);
    if (sqlDefault && sqlMost && sqlReadings && sqlSeries) {
      compare('changeRead', 'the changes past which a chart shows its buckets, in api.js and telemetry_changes()', changes[1], sqlDefault[1]);
      compare('changeRead', 'the readings one series may bring across, in api.js and telemetry_changes()', readings[1], sqlReadings[1]);
      compare('changeRead', 'the series one read may carry, in api.js and telemetry_changes()', series[1], sqlSeries[1]);
      if (Number(changes[1]) > Number(sqlMost[1])) {
        problems.push(`changeRead: the page's cap (${changes[1]}) is over the ${sqlMost[1]} telemetry_changes() takes, so every read is refused`);
      } else {
        ok.push(`changeRead: the page's cap (${changes[1]}) is one telemetry_changes() takes (1 to ${sqlMost[1]})`);
      }
    }
  }
}

// 70. What History's change read says of a series, one closed set in three places: the values
// telemetry_changes() (0254) gives `read`, CHANGE_READS in utils/history.js, which the page draws
// each by, and the API reference's TelemetryChangesRow enum. A value only the function gives is a
// chart the page draws from the wrong read.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_changes(', '$fn$;', 'telemetry_changes()');
  const js = need(read('frontend/src/utils/history.js'), /export const CHANGE_READS = Object\.freeze\(\{([\s\S]*?)\}\)/,
    'CHANGE_READS in frontend/src/utils/history.js');
  const spec = need(read('docs/openapi.yaml'), /\n {4}TelemetryChangesRow:\n[\s\S]*?\n {8}read: \{ type: string, enum: \[([^\]]*)\]/,
    "TelemetryChangesRow's read enum in docs/openapi.yaml");
  if (def && js && spec) {
    const sorted = (values) => [...new Set(values)].sort().join(', ');
    const sql = sorted([...def.body.matchAll(/\bread := '([a-z_]+)';/g)].map((m) => m[1]));
    compare('changeReads', 'the reads the page draws by', sorted([...js[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])), sql);
    compare('changeReads', 'the reads the API reference names', sorted(spec[1].split(',').map((v) => v.trim())), sql);
  }
}

// 79. History's hour-of-day read, one rule in two places. telemetry_hour_of_day() (0265) refuses
// more hours times devices than telemetry_carried() takes, which it reads at one hour, and api.js
// states the same bound for the Cell tab, which checks it before it asks and says the longest window
// it allows. It returns the columns the page's hourGrid() reads, and takes the arguments
// readHourOfDay() sends. A bound the page holds and the function does not is a heatmap the page
// offers and the function refuses; a column or an argument one side names is a heatmap that draws
// nothing.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_hour_of_day(', '$fn$;', 'telemetry_hour_of_day()');
  const carried = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const bound = need(api, /^export const HOUR_OF_DAY_MAX_ROWS = (\d+);$/m, 'HOUR_OF_DAY_MAX_ROWS in frontend/src/api.js');
  const call = need(api, /supabase\.rpc\('telemetry_hour_of_day', \{([^}]*)\}\)/, "readHourOfDay()'s rpc call in frontend/src/api.js");
  const doc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readHourOfDay: async/, "readHourOfDay()'s @returns in frontend/src/api.js");
  if (def && carried && bound && call && doc) {
    const sqlBound = need(def.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${def.file}`);
    const carriedBound = need(carried.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${carried.file}`);
    const args = need(def.body, /telemetry_hour_of_day\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (sqlBound && carriedBound && args) {
      compare('hourOfDayRead', 'the rows one read may take, in api.js and telemetry_hour_of_day()', bound[1], sqlBound[1]);
      compare('hourOfDayRead', 'the rows telemetry_hour_of_day() takes and telemetry_carried(), which it reads, takes', sqlBound[1], carriedBound[1]);
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
      compare('hourOfDayRead', 'the arguments readHourOfDay() sends and telemetry_hour_of_day() takes',
        names(call[1], /^\s*(\w+):/gm), names(args[1], /^\s*(\w+) [a-z]/gm));
      compare('hourOfDayRead', 'the columns readHourOfDay() documents and telemetry_hour_of_day() returns',
        names(doc[1], /(\w+): /g), names(args[2], /^\s*(\w+) [a-z]/gm));
    }
  }
}

// 88. History's Area read, one rule in two places. telemetry_carried_by_group() (0276) reads every
// device through telemetry_carried(), which refuses more than c_max_rows buckets times devices, and
// api.js states the same bound for the Area tab, which keeps the finest resolution it asks for inside
// it (pickGroupResolution()). It takes the arguments readCarriedByGroup() sends. A bound the page
// holds and the function does not is a chart the page offers and the function refuses; an argument one
// side names is an Area tab that draws nothing.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried_by_group(', '$fn$;', 'telemetry_carried_by_group()');
  const carried = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const bound = need(api, /^export const HISTORY_GROUP_READ_ROWS = (\d+);$/m, 'HISTORY_GROUP_READ_ROWS in frontend/src/api.js');
  // Up to the call's closing line, not the first brace: bucket is a template literal.
  const call = need(api, /supabase\.rpc\('telemetry_carried_by_group', \{([\s\S]*?)\n\s*\}\)/, "readCarriedByGroup()'s rpc call in frontend/src/api.js");
  if (def && carried && bound && call) {
    const carriedBound = need(carried.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${carried.file}`);
    const args = need(def.body, /telemetry_carried_by_group\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (carriedBound && args) {
      compare('groupRead', 'the rows one read may take, in api.js and telemetry_carried(), which telemetry_carried_by_group() reads', bound[1], carriedBound[1]);
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
      compare('groupRead', 'the arguments readCarriedByGroup() sends and telemetry_carried_by_group() takes',
        names(call[1], /^\s*(\w+):/gm), names(args[1], /^\s*(\w+) [a-z]/gm));
    }
  }
}

// 89. History's Area read, the columns. telemetry_carried_by_group() returns the columns
// readCarriedByGroup() documents, and the page reads no column it does not return: groupSeries() takes
// bucket_ts, mean_double, total_double and measured, and the Area tab files a row by group_key. A column
// the page reads and the function does not return is a chart of nothing, and a column documented and not
// returned sends a reader looking for it.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried_by_group(', '$fn$;', 'telemetry_carried_by_group()');
  const api = read('frontend/src/api.js');
  const doc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readCarriedByGroup: async/, "readCarriedByGroup()'s @returns in frontend/src/api.js");
  const series = need(read('frontend/src/utils/history.js'), /export function groupSeries\(([\s\S]*?)\n\}\n/, 'groupSeries() in frontend/src/utils/history.js');
  const area = read('frontend/src/components/tabs/HistoryArea.jsx');
  if (def && doc && series) {
    const args = need(def.body, /telemetry_carried_by_group\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (args) {
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort();
      const columns = names(args[2], /^\s*(\w+) [a-z]/gm);
      compare('groupColumns', 'the columns readCarriedByGroup() documents and telemetry_carried_by_group() returns',
        names(doc[1], /(\w+): /g).join(', '), columns.join(', '));
      const read = new Set([...series[1].matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
      for (const m of area.matchAll(/\brow\.(group_key)\b/g)) read.add(m[1]);
      const missing = [...read].filter((c) => !columns.includes(c));
      if (missing.length) problems.push(`groupColumns: the Area tab reads ${missing.join(', ')}, which telemetry_carried_by_group() does not return`);
      else ok.push(`groupColumns: the columns the Area tab reads, ${[...read].sort().join(', ')}, are ones telemetry_carried_by_group() returns`);
    }
  }
}

// 56. History's Overview read, one rule in two places. telemetry_coverage() (0245) caps a read's
// devices, lets only a small selection sum a block, reads a larger one at the device rollups' own
// widths, and bounds the buckets it reads; api.js states the same for the page, which reads in parts
// of that many devices and caps a large selection's window. A value only one side has is a read the
// page makes and the function refuses.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_coverage(', '$fn$;', 'telemetry_coverage()');
  const api = read('frontend/src/api.js');
  const history = read('frontend/src/utils/history.js');
  const devices = need(api, /^export const COVERAGE_MAX_DEVICES = (\d+);$/m, 'COVERAGE_MAX_DEVICES in frontend/src/api.js');
  const small = need(api, /^export const COVERAGE_SMALL_SELECTION = (\d+);$/m, 'COVERAGE_SMALL_SELECTION in frontend/src/api.js');
  const hours = need(api, /^export const COVERAGE_LARGE_MAX_HOURS = (\d+);$/m, 'COVERAGE_LARGE_MAX_HOURS in frontend/src/api.js');
  const widths = need(api, /^export const COVERAGE_ROLLUP_MINUTES = Object\.freeze\(\[(\d+), (\d+)\]\);$/m, 'COVERAGE_ROLLUP_MINUTES in frontend/src/api.js');
  const fiveHours = need(history, /^export const LARGE_FIVE_MINUTE_HOURS = (\d+)$/m, 'LARGE_FIVE_MINUTE_HOURS in frontend/src/utils/history.js');
  if (def && devices && small && hours && widths && fiveHours) {
    const sqlDevices = need(def.body, /c_max_devices\s+CONSTANT integer := (\d+);/, `the device cap in ${def.file}`);
    const sqlSmall = need(def.body, /c_small\s+CONSTANT integer := (\d+);/, `the small selection in ${def.file}`);
    const sqlBuckets = need(def.body, /c_max_buckets\s+CONSTANT bigint := (\d+);/, `the bucket bound in ${def.file}`);
    const sqlWidths = need(def.body, /v_secs NOT IN \((\d+), (\d+)\)/, `the widths a large selection reads in ${def.file}`);
    if (sqlDevices && sqlSmall && sqlBuckets && sqlWidths) {
      compare('coverageRead', 'the devices one read may carry, in api.js and telemetry_coverage()', devices[1], sqlDevices[1]);
      compare('coverageRead', 'the selection that may sum a block, in api.js and telemetry_coverage()', small[1], sqlSmall[1]);
      compare('coverageRead', "a large selection's block widths in seconds, in api.js and telemetry_coverage()",
        `${widths[1] * 60}, ${widths[2] * 60}`, `${sqlWidths[1]}, ${sqlWidths[2]}`);
      // The longest windows the page gives a full read: 5-minute buckets, then hourly ones, plus the
      // block holding the window's start.
      const widest = Math.max(Number(fiveHours[1]) * 12 + 1, Number(hours[1]) + 1) * Number(devices[1]);
      if (widest > Number(sqlBuckets[1])) {
        problems.push(`coverageRead: ${devices[1]} devices over the page's longest windows read ${widest} buckets, over telemetry_coverage()'s ${sqlBuckets[1]}`);
      } else {
        ok.push(`coverageRead: ${devices[1]} devices over the page's longest windows read ${widest} buckets, under telemetry_coverage()'s ${sqlBuckets[1]}`);
      }
    }
  }
}

// 40. A read of a service's logs, one rule in three places. service-logs (logs.ts) refuses a level,
// a range, a filter or a fixed window outside its rule, 0225's record_service_logs_read() refuses
// the same, and System › Logs (utils/serviceLogs.js) offers them. A value the page offers and the
// function refuses is a picker that fails; one the function reads and 0225 refuses is a read never
// shown, since no line is released unrecorded. The tab's spans must fit the widest window, and the
// arguments the function names in its call must be the ones 0225 declares, or every read is a 503.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.record_service_logs_read(', '$$;',
    'record_service_logs_read()');
  const ts = read('supabase/functions/service-logs/logs.ts');
  const js = read('frontend/src/utils/serviceLogs.js');
  const quoted = (text) => [...(text || '').matchAll(/'([^']*)'/g)].map((m) => m[1]).join(', ');
  const tsLevels = need(ts, /export const LEVELS = \[([^\]]*)\]/, 'LEVELS in service-logs/logs.ts');
  const tsRanges = need(ts, /export const RANGES[^=]*= \{([^}]*)\}/, 'RANGES in service-logs/logs.ts');
  const tsFilter = need(ts, /export const FILTER_MAX = (\d+)/, 'FILTER_MAX in service-logs/logs.ts');
  const tsService = need(ts, /export const SERVICE_MAX = (\d+)/, 'SERVICE_MAX in service-logs/logs.ts');
  const tsLines = need(ts, /export const MAX_LINES = (\d+)/, 'MAX_LINES in service-logs/logs.ts');
  const tsWindow = need(ts, /export const LONGEST_WINDOW_HOURS = (\d+)/, 'LONGEST_WINDOW_HOURS in service-logs/logs.ts');
  const tsCall = need(ts, /caller\.rpc\("record_service_logs_read", \{([\s\S]*?)\n {4}\}\);/,
    "service-logs/logs.ts's call to record_service_logs_read()");
  const jsLevels = need(js, /export const LOG_LEVELS = \[([\s\S]*?)\n\]/, 'LOG_LEVELS in frontend/src/utils/serviceLogs.js');
  const jsRanges = need(js, /export const LOG_RANGES = \[([\s\S]*?)\n\]/, 'LOG_RANGES in frontend/src/utils/serviceLogs.js');
  const jsFilter = need(js, /export const LOG_FILTER_MAX = (\d+)/, 'LOG_FILTER_MAX in frontend/src/utils/serviceLogs.js');
  const jsLines = need(js, /export const LOG_LINES_MAX = (\d+)/, 'LOG_LINES_MAX in frontend/src/utils/serviceLogs.js');
  const jsSpans = need(js, /export const LOG_SPANS = \[([^\]]*)\]/, 'LOG_SPANS in frontend/src/utils/serviceLogs.js');
  if (def && tsWindow && tsCall && jsSpans) {
    const sqlWindow = need(def.body, /p_to - p_from > interval '(\d+) hours'/, `the widest window in ${def.file}`);
    const sqlArgs = need(def.body, /record_service_logs_read\(([\s\S]*?)\)\s+RETURNS/, `the arguments ${def.file} declares`);
    if (sqlWindow) compare('serviceLogsRead', 'the widest fixed window, in hours, in the function and 0225', tsWindow[1], sqlWindow[1]);
    if (sqlArgs) {
      const declared = [...sqlArgs[1].matchAll(/\b(p_[a-z]+) /g)].map((m) => m[1]).join(', ');
      const sent = [...new Set([...tsCall[1].matchAll(/\b(p_[a-z]+):/g)].map((m) => m[1]))].join(', ');
      compare('serviceLogsRead', 'the arguments the function sends and 0225 declares', sent, declared);
    }
    // A span's longest length in hours: a day and a week an hour longer when the clocks go back.
    const LONGEST_SPAN_HOURS = { day: 25, week: 7 * 24 + 1, month: 31 * 24 + 1, year: 366 * 24 + 1 };
    const spans = [...jsSpans[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const over = spans.filter((sp) => !(LONGEST_SPAN_HOURS[sp] <= Number(tsWindow[1])));
    if (spans.length === 0) {
      problems.push('serviceLogsRead: found no span in LOG_SPANS -- its shape changed, so this check is no longer checking anything');
    } else if (over.length) {
      problems.push(`serviceLogsRead: System › Logs offers ${over.join(', ')}, which can be longer than the ${tsWindow[1]} hours service-logs reads`);
    } else {
      ok.push(`serviceLogsRead: the spans System › Logs offers (${spans.join(', ')}) fit ${tsWindow[1]} hours`);
    }
  }
  if (def && tsLevels && tsRanges && tsFilter && tsService && tsLines && jsLevels && jsRanges && jsFilter && jsLines) {
    const sqlLevels = need(def.body, /p_level = ANY \(ARRAY\[([^\]]*)\]\)/, `the levels record_service_logs_read() takes (${def.file})`);
    const sqlRanges = need(def.body, /p_range = ANY \(ARRAY\[([^\]]*)\]\)/, `the ranges record_service_logs_read() takes (${def.file})`);
    const sqlFilter = need(def.body, /char_length\(coalesce\(p_filter, ''\)\) > (\d+)/, `the filter's limit in ${def.file}`);
    const sqlService = need(def.body, /char_length\(p_service\) NOT BETWEEN 1 AND (\d+)/, `the service's limit in ${def.file}`);
    const values = (text) => [...text.matchAll(/value: '([^']*)'/g)].map((m) => m[1]).join(', ');
    const tsRangeKeys = [...tsRanges[1].matchAll(/"([^"]+)":/g)].map((m) => m[1]).join(', ');
    const tsLevelList = [...tsLevels[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(', ');
    if (sqlLevels && sqlRanges && sqlFilter && sqlService) {
      compare('serviceLogsRead', 'the levels the function takes and 0225 records', tsLevelList, quoted(sqlLevels[1]));
      compare('serviceLogsRead', 'the levels System › Logs offers and 0225 records', values(jsLevels[1]), quoted(sqlLevels[1]));
      compare('serviceLogsRead', 'the ranges the function takes and 0225 records', tsRangeKeys, quoted(sqlRanges[1]));
      compare('serviceLogsRead', 'the ranges System › Logs offers and 0225 records', values(jsRanges[1]), quoted(sqlRanges[1]));
      compare('serviceLogsRead', "the filter's limit in the function and 0225", tsFilter[1], sqlFilter[1]);
      compare('serviceLogsRead', "the filter's limit in System › Logs and 0225", jsFilter[1], sqlFilter[1]);
      compare('serviceLogsRead', "a service name's limit in the function and 0225", tsService[1], sqlService[1]);
    }
    compare('serviceLogsRead', 'the most lines a read returns, which System › Logs asks for', jsLines[1], tsLines[1]);
  }
}

// 42. Each Audit Trail kind's domain is the one audit_domain_for() files its rows under. The
// Entity filter's Security group is AUDIT_TRAIL_ENTITY_TYPES' security domain, offered only to the
// roles audit_trail_select_security admits. A kind filed asset in the database and security here is
// hidden from a Shopfloor Manager who can read its rows; one filed security there and asset here is
// offered to a role that only ever reads "no events". audit_domain_for() names the asset tables and
// files everything else under security, its fail-closed default.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_domain_for(', '$$;', 'audit_domain_for()');
  const js = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_ENTITY_TYPES = \[([\s\S]*?)\n\];/,
    'AUDIT_TRAIL_ENTITY_TYPES in frontend/src/constants.js');
  if (def && js) {
    const asset = need(def.body, /WHEN p_entity_type IN \(([^)]*)\)\s*THEN 'asset'/,
      `the asset tables audit_domain_for() names (${def.file})`);
    const kinds = [...js[1].matchAll(/table: '([a-z_]+)',[^}]*domain: '(asset|security)'/g)].map((m) => [m[1], m[2]]);
    if (asset && kinds.length === 0) {
      problems.push('auditTrailDomains: found no kind in AUDIT_TRAIL_ENTITY_TYPES -- its shape changed, so this check is no longer checking anything');
    } else if (asset) {
      const assetTables = new Set([...asset[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
      const sqlDomain = (table) => (assetTables.has(table) ? 'asset' : 'security');
      compare('auditTrailDomains', `the domain of each of the ${kinds.length} kinds the Audit Trail filters by`,
        kinds.map(([table, domain]) => `${table}:${domain}`).join(', '),
        kinds.map(([table]) => `${table}:${sqlDomain(table)}`).join(', '));
    }
  }
}

// 43. Which kinds each Audit Trail action is written for, and the classes such a row can be in.
// audit_trail_action_kinds() (0229) declares it and AUDIT_TRAIL_ACTION_KINDS mirrors it; the
// Entity, Action and class filters narrow each other by the mirror. A pair the database has and
// the dashboard lacks hides a value that can occur; one the dashboard has and the database lacks
// offers one that cannot. Compared as (action, kind, class) triples, so the grouping may differ.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds(', '$$;',
    'audit_trail_action_kinds()');
  const js = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_ACTION_KINDS = \[([\s\S]*?)\n\];/,
    'AUDIT_TRAIL_ACTION_KINDS in frontend/src/constants.js');
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const triples = (rows) => rows
    .flatMap(([action, kinds, classes]) => kinds.flatMap((k) => classes.map((c) => `${action} ${k} ${c}`)))
    .sort();
  if (def && js) {
    const sqlRows = [...def.body.matchAll(/\('([A-Z_]+)',\s*ARRAY\[([^\]]*)\],\s*ARRAY\[([^\]]*)\]\)/g)]
      .map((m) => [m[1], words(m[2]), words(m[3])]);
    const jsRows = [...js[1].matchAll(/\['([A-Z_]+)',\s*\[([^\]]*)\],\s*\[([^\]]*)\]\]/g)]
      .map((m) => [m[1], words(m[2]), words(m[3])]);
    if (sqlRows.length === 0 || jsRows.length === 0) {
      problems.push(`auditTrailActionKinds: found no row in ${sqlRows.length ? 'AUDIT_TRAIL_ACTION_KINDS' : `audit_trail_action_kinds() (${def.file})`} -- its shape changed, so this check is no longer checking anything`);
    } else {
      compare('auditTrailActionKinds', `the ${triples(sqlRows).length} (action, kind, class) triples (${def.file})`,
        triples(jsRows).join('; '), triples(sqlRows).join('; '));
    }
  }
}

// 44. The Audit Trail's classes, by name. audit_event_class() (0228) answers one of them, each has
// its partial index, the dashboard lists them in AUDIT_TRAIL_CLASSES (the address's `?class=` words
// and the legend's order) and draws one marker per class (MARKERS). A class the function answers
// and the dashboard lacks draws no marker of its own; one with no index is read row by row.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_event_class(', '$$;', 'audit_event_class()');
  const constants = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_CLASSES = \[([^\]]*)\]/,
    'AUDIT_TRAIL_CLASSES in frontend/src/constants.js');
  const tab = need(read('frontend/src/components/tabs/AuditTrailTab.jsx'), /export const MARKERS = \{([\s\S]*?)\n\}/,
    'MARKERS in frontend/src/components/tabs/AuditTrailTab.jsx');
  if (def && constants && tab) {
    const answered = [...new Set([...def.body.matchAll(/THEN '([a-z]+)'|ELSE '([a-z]+)'/g)].map((m) => m[1] || m[2]))].sort();
    const indexed = [...SCHEMA.matchAll(/CREATE INDEX IF NOT EXISTS idx_audit_trail_class_([a-z]+) ON public\.audit_trail[^;]*= '([a-z]+)';/g)]
      .filter((m) => m[1] === m[2]).map((m) => m[1]).sort();
    const listed = [...constants[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    compare('auditTrailClasses', `the classes audit_event_class() answers (${def.file}) and AUDIT_TRAIL_CLASSES`,
      [...listed].sort().join(', '), answered.join(', '));
    compare('auditTrailClasses', 'the classes with an index of their own and AUDIT_TRAIL_CLASSES',
      [...listed].sort().join(', '), indexed.join(', '));
    const drawn = [...tab[1].matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]);
    compare('auditTrailClasses', "MARKERS' classes, in order, and AUDIT_TRAIL_CLASSES",
      drawn.join(', '), listed.join(', '));
  }
}

// 45. An alert's acknowledgement reasons, one closed set in three places (0231): the CHECK on
// platform_alerts, acknowledge_alert()'s own refusal, and the dialog's list. A reason the dialog
// offers and the database lacks is refused on every save; one the database admits and the dialog
// lacks can never be chosen. Compared in order, so the dialog lists them as the CHECK does.
{
  const check = need(SCHEMA, /ADD CONSTRAINT platform_alerts_acknowledgement_reason_valid CHECK \(\(acknowledgement_reason = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'platform_alerts_acknowledgement_reason_valid in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.acknowledge_alert(', '$$;', 'acknowledge_alert()');
  const js = need(read('frontend/src/utils/alertAcknowledgement.js'),
    /export const ALERT_ACKNOWLEDGEMENT_REASONS = \[([\s\S]*?)\n\]/, 'ALERT_ACKNOWLEDGEMENT_REASONS in utils/alertAcknowledgement.js');
  const refused = fn && need(fn.body, /NOT p_reason = ANY \(ARRAY\[([^\]]*)\]\)/, `acknowledge_alert()'s list of reasons (${fn.file})`);
  if (check && refused && js) {
    const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
    const offered = [...js[1].matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]).join(', ');
    compare('alertAcknowledgementReasons', 'the reasons the CHECK admits and the dialog offers', offered, words(check[1]));
    compare('alertAcknowledgementReasons', `the reasons acknowledge_alert() admits (${fn.file}) and the dialog offers`,
      offered, words(refused[1]));
  }
}

// 46. Who may acknowledge an alert, and who may withdraw anyone's acknowledgement (0231). The alert
// counter offers Acknowledge and Withdraw by ALERT_ACKNOWLEDGE_ROLES and ALERT_WITHDRAW_ANY_ROLES; the
// functions decide by has_role(). A role the counter offers and the database refuses meets an
// error on every click; one it leaves out never sees the button.
{
  const ack = lastDefinition('CREATE OR REPLACE FUNCTION public.acknowledge_alert(', '$$;', 'acknowledge_alert()');
  const withdraw = lastDefinition('CREATE OR REPLACE FUNCTION public.withdraw_alert_acknowledgement(', '$$;',
    'withdraw_alert_acknowledgement()');
  const js = read('frontend/src/utils/alertAcknowledgement.js');
  const jsAck = need(js, /export const ALERT_ACKNOWLEDGE_ROLES = \[([^\]]*)\]/, 'ALERT_ACKNOWLEDGE_ROLES');
  const jsAny = need(js, /export const ALERT_WITHDRAW_ANY_ROLES = \[([^\]]*)\]/, 'ALERT_WITHDRAW_ANY_ROLES');
  const roles = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).sort().join(', ');
  if (ack && withdraw && jsAck && jsAny) {
    const ackSql = need(ack.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/, `acknowledge_alert()'s roles (${ack.file})`);
    const gateSql = need(withdraw.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/,
      `withdraw_alert_acknowledgement()'s callers (${withdraw.file})`);
    const anySql = need(withdraw.body, /IS DISTINCT FROM v_uid\s+AND NOT public\.has_role\(ARRAY\[([^\]]*)\]\)/,
      `withdraw_alert_acknowledgement()'s roles that withdraw anyone's (${withdraw.file})`);
    if (ackSql) compare('alertAcknowledgementRoles', 'the roles that may acknowledge', roles(jsAck[1]), roles(ackSql[1]));
    if (gateSql) compare('alertAcknowledgementRoles', 'the roles that may withdraw their own', roles(jsAck[1]), roles(gateSql[1]));
    if (anySql) compare('alertAcknowledgementRoles', "the roles that may withdraw anyone's", roles(jsAny[1]), roles(anySql[1]));
  }
}

// 53. Who may schedule, change and end a suppression window (0240). A drawer offers its acts by
// SUPPRESSION_WINDOW_ROLES; each of the three writers decides by has_role(). A role the drawer
// offers and a writer refuses meets an error on every click; one it leaves out never sees them.
{
  const jsRoles = need(read('frontend/src/utils/alertSuppression.js'),
    /export const SUPPRESSION_WINDOW_ROLES = \[([^\]]*)\]/, 'SUPPRESSION_WINDOW_ROLES in utils/alertSuppression.js');
  const roles = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).sort().join(', ');
  for (const name of ['schedule_alert_suppression_window', 'change_alert_suppression_window', 'end_alert_suppression_window']) {
    const fn = lastDefinition(`CREATE OR REPLACE FUNCTION public.${name}(`, '$$;', `${name}()`);
    const sql = fn && need(fn.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/, `${name}()'s roles (${fn.file})`);
    if (jsRoles && sql) compare('suppressionWindowRoles', `the roles ${name}() admits and the drawers offer`, roles(jsRoles[1]), roles(sql[1]));
  }
}

// 54. A suppression window's reason, one limit in three places (0240): the CHECK, the writers'
// refusal and the dialog's field. A dialog that takes more is refused on save; one that takes less
// cuts a reason the database would keep.
{
  const check = need(SCHEMA, /ADD CONSTRAINT alert_suppression_windows_reason_valid CHECK \(\(\(char_length\(reason\) >= 1\) AND \(char_length\(reason\) <= (\d+)\)/,
    'alert_suppression_windows_reason_valid in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.schedule_alert_suppression_window(', '$$;',
    'schedule_alert_suppression_window()');
  const refused = fn && need(fn.body, /char_length\(v_reason\) > (\d+) THEN/, `schedule_alert_suppression_window()'s limit (${fn.file})`);
  const js = need(read('frontend/src/utils/alertSuppression.js'), /export const SUPPRESSION_REASON_MAX = (\d+)/,
    'SUPPRESSION_REASON_MAX in utils/alertSuppression.js');
  if (check && js) compare('suppressionReasonMax', "the reason's limit in the CHECK and the dialog", js[1], check[1]);
  if (refused && js) compare('suppressionReasonMax', `the reason's limit schedule_alert_suppression_window() refuses past (${fn.file}) and the dialog`, js[1], refused[1]);
}

// 71. The automations vocabulary, one set of patterns, names and limits in four places (0255, 0256):
// the JSON Schema the dashboard serves, automations_parse()'s constants and lists, and the CHECKs on
// the tables. A pattern the schema accepts and the function refuses is an editor that offers a file
// the database turns back; the reverse is one that refuses what the database would apply. The guard
// suite holds the two over fixtures; this holds the words and numbers that no fixture reaches.
{
  const schema = JSON.parse(read('frontend/public/json-schema/automations.schema.json'));
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.automations_parse(', '$$;', 'automations_parse()');
  const key = need(SCHEMA, /CONSTRAINT automations_key_format CHECK \(\(key ~ '([^']+)'::text\)\)/, 'automations_key_format in the migrations');
  const hold = need(SCHEMA, /CONSTRAINT automation_triggers_hold_valid CHECK \(\(\(hold_seconds >= 0\) AND \(hold_seconds <= (\d+)\)\)\)/,
    'automation_triggers_hold_valid in the migrations');
  const severity = need(SCHEMA, /CONSTRAINT automation_actions_alert_shape\s+CHECK \(\(\(kind <> 'alert'::text\) OR \(severity = ANY \(ARRAY\[([^\]]*)\]\)\)\)\)/,
    'automation_actions_alert_shape in the migrations');
  const platform = need(SCHEMA, /ADD CONSTRAINT platform_alerts_severity_valid CHECK \(\(severity = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'platform_alerts_severity_valid in the migrations');
  const constant = (name) => parse && need(parse.body.split('\n').find((line) => line.trim().startsWith(`${name} `)) ?? '',
    /CONSTANT (?:text|integer) := '?([^';]+)'?;/, `${name} in automations_parse() (${parse.file})`);
  const words = (list) => [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).join(', ');
  const { automation, thresholdTrigger, alertAction, deviceId } = schema.$defs;
  const id = constant('c_id');
  const forPattern = constant('c_for');
  const uuid = constant('c_uuid');
  const limits = ['c_max_automations', 'c_max_triggers', 'c_max_devices'].map(constant);
  if (id && key) {
    compare('automationsVocabulary', `the id pattern in the schema and in automations_parse() (${parse.file})`,
      automation.properties.id.pattern, id[1]);
    compare('automationsVocabulary', 'the id pattern in the schema and in the table CHECK',
      automation.properties.id.pattern, key[1]);
  }
  if (forPattern && hold) {
    compare('automationsVocabulary', `the pattern of for in the schema and in automations_parse() (${parse.file})`,
      thresholdTrigger.properties.for.pattern, forPattern[1]);
    // Three digits of an hour at most, and the table holds that many seconds.
    const digits = Number(thresholdTrigger.properties.for.pattern.match(/\{0,(\d)\}/)?.[1]) + 1;
    compare('automationsVocabulary', 'the longest hold in hours the for pattern allows and the table CHECK holds',
      10 ** digits - 1, Number(hold[1]) / 3600);
  }
  if (uuid) {
    compare('automationsVocabulary', 'the device id pattern in the schema and in automations_parse()', deviceId.pattern, uuid[1]);
  }
  if (limits.every(Boolean)) {
    compare('automationsVocabulary', "the most automations in a file, triggers in an automation and devices in a trigger, in the schema and in automations_parse()",
      [schema.maxItems, automation.properties.triggers.maxItems, thresholdTrigger.properties.device.oneOf[1].maxItems].join(', '),
      limits.map((m) => m[1]).join(', '));
  }
  if (severity && platform) {
    compare('automationsVocabulary', 'the severities of the schema and the actions table',
      alertAction.properties.severity.enum.join(', '), words(severity[1]));
    compare('automationsVocabulary', 'the severities of the actions table and platform_alerts', words(severity[1]), words(platform[1]));
  }
  if (parse) {
    const listed = need(parse.body, /NOT \(v_val #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/, `automations_parse()'s severities (${parse.file})`);
    if (listed) {
      compare('automationsVocabulary', `the severities automations_parse() admits (${parse.file}) and the schema`,
        words(listed[1]), alertAction.properties.severity.enum.join(', '));
    }
    compare('automationsVocabulary', `the trigger and action types automations_parse() admits (${parse.file}) and the schema`,
      [...parse.body.matchAll(/\(v_val #>> '\{\}'\) <> '([a-z]+)'/g)].map((m) => m[1]).join(', '),
      [thresholdTrigger.properties.trigger.const, alertAction.properties.action.const].join(', '));
    // The keys each level admits, in the order the function checks them: automation, trigger, action.
    const admitted = [...parse.body.matchAll(/NOT v_key = ANY \(ARRAY\[([^\]]*)\]\)/g)]
      .map((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((k) => k[1]).sort().join(', '));
    compare('automationsVocabulary', `the keys automations_parse() admits on an automation, a trigger and an action (${parse.file}) and the schema's properties`,
      admitted.join(' | '),
      [automation, thresholdTrigger, alertAction].map((d) => Object.keys(d.properties).sort().join(', ')).join(' | '));
  }
}

// 62. The longest suppression window, one default and one range in three places: 0002's seed and
// bounds, the writers' check, which falls back to the default outside the range, and the dialog,
// which does the same where the setting cannot be read. A dialog with another default offers an
// end the writers refuse, or refuses one they would keep.
{
  const seed = need(SCHEMA, /seed_setting\(\s*'alerts\.suppression_max_days',\s*to_jsonb\((\d+)\)/,
    "alerts.suppression_max_days' seed in 0002");
  const bounds = need(SCHEMA, /SET min_value = (\d+), max_value = (\d+)\s+WHERE key = 'alerts\.suppression_max_days'/,
    "alerts.suppression_max_days' bounds in 0002");
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(', '$$;',
    'check_alert_suppression_window_length()');
  const fallback = fn && need(fn.body, /IF v_days IS NULL OR v_days < (\d+) OR v_days > (\d+) THEN\s+v_days := (\d+);/,
    `check_alert_suppression_window_length()'s fallback (${fn.file})`);
  const js = read('frontend/src/utils/alertSuppression.js');
  const jsDays = need(js, /export const SUPPRESSION_MAX_DAYS = (\d+)$/m, 'SUPPRESSION_MAX_DAYS in utils/alertSuppression.js');
  const jsMin = need(js, /export const SUPPRESSION_MAX_DAYS_MIN = (\d+)$/m, 'SUPPRESSION_MAX_DAYS_MIN in utils/alertSuppression.js');
  const jsMax = need(js, /export const SUPPRESSION_MAX_DAYS_MAX = (\d+)$/m, 'SUPPRESSION_MAX_DAYS_MAX in utils/alertSuppression.js');
  if (seed && jsDays) compare('suppressionMaxDays', 'the longest window the dialog falls back to and 0002 seeds', jsDays[1], seed[1]);
  if (fallback && jsDays) compare('suppressionMaxDays', `the longest window the dialog and the writers' check (${fn.file}) fall back to`, jsDays[1], fallback[3]);
  if (bounds && jsMin && jsMax) compare('suppressionMaxDays', "the setting's range in the dialog and 0002's bounds", `${jsMin[1]} to ${jsMax[1]}`, `${bounds[1]} to ${bounds[2]}`);
  if (fallback && jsMin && jsMax) compare('suppressionMaxDays', `the setting's range in the dialog and the writers' check (${fn.file})`, `${jsMin[1]} to ${jsMax[1]}`, `${fallback[1]} to ${fallback[2]}`);
}

// 63. Where the longest suppression window is set, named in two places as 0002 files it: the
// writers' refusal and the hint under the dialog's end field. A key moved to another category
// leaves both pointing at a tab that no longer holds it.
{
  const seeded = need(SCHEMA, /seed_setting\(\s*'alerts\.suppression_max_days',\s*to_jsonb\(\d+\),\s*'number',\s*'([^']+)'/,
    "alerts.suppression_max_days' category in 0002");
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(', '$$;',
    'check_alert_suppression_window_length()');
  const refused = fn && need(fn.body, /set on Settings › ([^.']+)\./, `the tab check_alert_suppression_window_length()'s sentence names (${fn.file})`);
  const js = need(read('frontend/src/utils/alertSuppression.js'), /export const SUPPRESSION_MAX_DAYS_PLACE = 'Settings › ([^']+)'/,
    'SUPPRESSION_MAX_DAYS_PLACE in utils/alertSuppression.js');
  if (seeded && js) compare('suppressionMaxDaysPlace', "the Settings tab the dialog names and 0002's category", js[1], seeded[1]);
  if (seeded && refused) compare('suppressionMaxDaysPlace', `the Settings tab the writers' refusal names (${fn.file}) and 0002's category`, refused[1], seeded[1]);
}

// 55. History's alerts, two numbers in two places. The Alerts tab asks alert_occurrences() (0243)
// for ALERT_HISTORY_LIMIT and one more, which must fit under the function's bound, or every read is
// refused. Where alerts.retention_days cannot be read, the tab says alerts are kept for
// ALERT_RETENTION_DAYS, which must be the value 0002 seeds.
{
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.alert_occurrences(', '$fn$;', 'alert_occurrences()');
  const limit = need(read('frontend/src/api.js'), /^export const ALERT_HISTORY_LIMIT = (\d+);$/m, 'ALERT_HISTORY_LIMIT in frontend/src/api.js');
  const days = need(read('frontend/src/utils/alertHistory.js'), /^export const ALERT_RETENTION_DAYS = (\d+)$/m,
    'ALERT_RETENTION_DAYS in frontend/src/utils/alertHistory.js');
  const seeded = need(SCHEMA, /seed_setting\(\s*'alerts\.retention_days',\s*to_jsonb\((\d+)\)/, "alerts.retention_days' seed in 0002");
  const bound = def && need(def.body, /c_max_rows CONSTANT integer := (\d+);/, `the row bound in ${def.file}`);
  if (limit && bound) {
    if (Number(limit[1]) + 1 > Number(bound[1])) {
      problems.push(`alertHistory: the Alerts tab asks for ${Number(limit[1]) + 1} rows, over alert_occurrences()'s bound (${bound[1]}), so every read is refused`);
    } else {
      ok.push(`alertHistory: the Alerts tab's ${Number(limit[1]) + 1} rows fit under alert_occurrences()'s bound (${bound[1]})`);
    }
  }
  if (days && seeded) compare('alertHistory', 'the days alerts are kept, as the tab falls back to and 0002 seeds', days[1], seeded[1]);
}

// 57. How long a Grafana alert's confirmation holds (0247). grafana-alert-webhook stamps
// last_confirmed_at on every post, and Grafana posts a firing alert again every repeat_interval
// (policies.yaml). platform_alert_confirmation_window() allows that interval plus a margin before an
// alert is reminded no more. A shorter window than the interval stops the reminders of every alert
// still firing; a longer one keeps reminding about a resolve that never arrived.
{
  const policies = read('grafana/provisioning/alerting/policies.yaml');
  const repeat = need(policies, /^\s*repeat_interval:\s*(\d+)h\s*$/m, 'repeat_interval in grafana/provisioning/alerting/policies.yaml');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const arm = fn && need(fn.body, /ELSE interval '(\d+) hours' \+ interval '(\d+) hours?'/,
    `platform_alert_confirmation_window()'s Grafana arm (${fn.file})`);
  if (repeat && arm) {
    compare('alertConfirmationWindow', `Grafana's repeat_interval (hours) and the window's interval (${fn.file})`, repeat[1], arm[1]);
  }
}

// 82. How long an automation's alert confirmation holds (0247, 0271). evaluate_automations() stamps
// last_confirmed_at on every run, and pg_cron runs it on the schedule 0271 gives. The window
// platform_alert_confirmation_window() allows a condition: fingerprint must be longer than that
// interval: a window no longer than the run interval stops the reminders of every automation alert
// still firing, and a far longer one keeps reminding about an alert nothing has confirmed for hours.
{
  const job = need(SCHEMA, /ensure_cron_job\(\s*'evaluate_automations',\s*'([^']+)'/, 'the evaluate_automations job in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const arm = fn && need(fn.body, /WHEN starts_with\(p_fingerprint, 'condition:'\) THEN interval '(\d+) minutes'/,
    `platform_alert_confirmation_window()'s condition: arm (${fn.file})`);
  if (job && arm) {
    // `* * * * *` is every minute and `*/N * * * *` every N; anything else is not read.
    const every = /^\* \* \* \* \*$/.test(job[1]) ? 1 : Number(job[1].match(/^\*\/(\d+) \* \* \* \*$/)?.[1]);
    if (!Number.isInteger(every) || every < 1) {
      problems.push(`alertConfirmationWindow: the evaluate_automations schedule "${job[1]}" is neither every minute nor every N minutes, so the window cannot be held to it`);
    } else if (Number(arm[1]) <= every) {
      problems.push(`alertConfirmationWindow: the evaluator runs every ${every} minute(s) and its confirmation holds ${arm[1]}, which stops the reminders of every automation alert still firing (${fn.file})`);
    } else {
      ok.push(`alertConfirmationWindow: an automation alert's confirmation (${arm[1]} minutes) outlasts the evaluator's interval (${every} minute${every === 1 ? '' : 's'})`);
    }
  }
}

// 83. What marks an alert as an automation's, one prefix in four places (0255, 0271): the dashboard's
// isAutomationAlert() reads it, automation_alert_fingerprint() composes every trigger's fingerprint
// with it, evaluate_automations() names its own alert with it, and platform_alert_confirmation_window()
// gives it its window. A prefix one of them spells differently is an automation's alert opening
// Grafana, or a reminder that is never sent.
{
  const js = need(read('frontend/src/constants.js'), /isAutomationAlert = \(alert\) => String\(alert\?\.fingerprint \?\? ''\)\.startsWith\('([^']+)'\)/,
    'isAutomationAlert() in constants.js');
  const compose = lastDefinition('CREATE OR REPLACE FUNCTION public.automation_alert_fingerprint(', '$$;', 'automation_alert_fingerprint()');
  const composed = compose && need(compose.body, /WHEN p_entity_id IS NULL OR p_metric_name IS NULL THEN '([^']+)' \|\|/,
    `automation_alert_fingerprint()'s prefix (${compose.file})`);
  const evaluator = lastDefinition('CREATE OR REPLACE FUNCTION public.evaluate_automations(', '$$;', 'evaluate_automations()');
  const own = evaluator && need(evaluator.body, /c_not_evaluated CONSTANT text := '([^']+)'/,
    `evaluate_automations()'s own fingerprint (${evaluator.file})`);
  const window = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const windowed = window && need(window.body, /WHEN starts_with\(p_fingerprint, '([^']+)'\)/,
    `platform_alert_confirmation_window()'s condition: arm (${window.file})`);
  if (js && composed && own && windowed) {
    compare('automationAlertPrefix', `the dashboard's prefix and the one automation_alert_fingerprint() composes (${compose.file})`, js[1], composed[1]);
    compare('automationAlertPrefix', `the dashboard's prefix and the one the evaluator's own alert starts with (${evaluator.file})`,
      js[1], own[1].slice(0, js[1].length));
    compare('automationAlertPrefix', `the dashboard's prefix and the one the confirmation window answers for (${window.file})`, js[1], windowed[1]);
  }
}

// 58. The Notifications vocabulary, one closed set in each place it is written (0247, 0248): the
// severities a route may name, as notification_setting_guard() admits them, notification_severity_carried()
// ranks them and the Settings page offers them; and the events a message may be, as the queue's CHECK
// admits them, the delivery log labels them and the dispatcher types them. A severity offered and
// refused fails every save; an event the log cannot name shows as its raw word.
{
  const notifications = read('frontend/src/utils/notifications.js');
  const dispatch = read('supabase/functions/notification-dispatch/dispatch.ts');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_setting_guard(', '$$;', 'notification_setting_guard()');
  const rank = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_severity_carried(', '$$;',
    'notification_severity_carried()');
  const offered = need(notifications, /export const SEVERITIES = \[([\s\S]*?)\n\]/, 'SEVERITIES in utils/notifications.js');
  const admitted = guard && need(guard.body, /NOT \(NEW\.value #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/,
    `notification_setting_guard()'s severities (${guard.file})`);
  const ranked = rank && need(rank.body, /array_position\(ARRAY\[([^\]]*)\], p_severity\)/,
    `notification_severity_carried()'s ranking (${rank.file})`);
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
  if (offered && admitted && ranked) {
    const js = [...offered[1].matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]).join(', ');
    compare('notificationSeverities', `the severities the page offers and the guard admits (${guard.file})`, js, words(admitted[1]));
    compare('notificationSeverities', `the severities the page offers and the route ranks, lowest first (${rank.file})`, js, words(ranked[1]));
  }

  const check = need(SCHEMA, /CONSTRAINT notification_deliveries_event_valid\s+CHECK \(\(event = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'notification_deliveries_event_valid in the migrations');
  const labels = need(notifications, /export const EVENT_LABELS = \{([^}]*)\}/, 'EVENT_LABELS in utils/notifications.js');
  const typed = need(dispatch, /export type Event = ([^;]*);/, 'the Event type in notification-dispatch/dispatch.ts');
  if (check && labels && typed) {
    const sql = words(check[1].replace(/::text/g, ''));
    compare('notificationEvents', 'the events the delivery log labels and the queue admits',
      [...labels[1].matchAll(/([a-z]+):/g)].map((m) => m[1]).join(', '), sql);
    compare('notificationEvents', 'the events the dispatcher types and the queue admits',
      [...typed[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).join(', '), sql);
  }
}

// 76. The channels a message may go down, one closed set in each place it is written (0247, 0262):
// the queue's CHECK admits them, the delivery log names each, notification_channel_is_configured()
// has an arm for each, and notification_channel_reaches() says which alerts each may carry. A
// channel the log cannot name shows as its raw word; one the configured test lacks is queued
// for never or always, and its messages wait or fail with no sentence.
{
  const notifications = read('frontend/src/utils/notifications.js');
  // The last declaration stands: 0247 creates the table with one channel and 0262 replaces the CHECK.
  const declared = [...SCHEMA.matchAll(/CONSTRAINT notification_deliveries_channel_valid\s+CHECK \(\(channel = ANY \(ARRAY\[([^\]]*)\]\)\)\)/g)];
  const check = declared.length ? declared[declared.length - 1] : null;
  if (!check) problems.push('notificationChannels: found no notification_deliveries_channel_valid in the migrations -- the shape this check reads has changed');
  const labels = need(notifications, /export const CHANNEL_LABELS = \{([^}]*)\}/, 'CHANNEL_LABELS in utils/notifications.js');
  const configured = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_channel_is_configured(', '$;',
    'notification_channel_is_configured()');
  const reaches = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_channel_reaches(', '$;',
    'notification_channel_reaches()');
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
  if (check && labels) {
    const sql = words(check[1].replace(/::text/g, ''));
    compare('notificationChannels', 'the channels the delivery log labels and the queue admits',
      [...labels[1].matchAll(/([a-z]+):/g)].map((m) => m[1]).join(', '), sql);
    if (configured) {
      compare('notificationChannels', `the channels the queue admits and notification_channel_is_configured() has an arm for (${configured.file})`,
        sql, [...configured.body.matchAll(/WHEN '([a-z]+)' THEN/g)].map((m) => m[1]).join(', '));
    }
    if (reaches) {
      compare('notificationChannels', `the channels the queue admits and notification_channel_reaches() rules on (${reaches.file})`,
        sql, [...reaches.body.matchAll(/WHEN '([a-z]+)' THEN/g)].map((m) => m[1]).join(', '));
    }
  }
}

// 77. The Notifications keys the page names are the keys the migrations seed, and the guard checks
// each: a key the page reads that nothing seeds is an empty read, and one the guard does not name
// takes any value an Administrator types, which the dispatcher then reads as it can.
{
  const notifications = read('frontend/src/utils/notifications.js');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_setting_guard(', '$;', 'notification_setting_guard()');
  const named = [...notifications.matchAll(/^export const [A-Z_]+_KEY = '(notifications\.[a-z_]+)'$/gm)].map((m) => m[1]).sort();
  const seeded = [...SCHEMA.matchAll(/seed_setting\(\s*'(notifications\.[a-z_]+)'/g)].map((m) => m[1]).sort();
  if (!named.length) {
    problems.push('notificationKeys: found no notifications.* key in utils/notifications.js -- the shape this check reads has changed');
  } else {
    compare('notificationKeys', 'the Notifications keys the page names and the migrations seed', named.join(', '), seeded.join(', '));
    if (guard) {
      const guarded = [...guard.body.matchAll(/WHEN '(notifications\.[a-z_]+)' THEN/g)].map((m) => m[1]).sort();
      compare('notificationKeys', `the Notifications keys the page names and the guard checks (${guard.file})`, named.join(', '), guarded.join(', '));
    }
  }
}

// 78. The desktop-notification choice, one column in two places (0264). user_settings.desktop_notifications
// is off by default, and the browser's copy of it (useDesktopNotifications.js) starts off too, so a
// first paint and a row never written agree. The dashboard reads and writes the column by name,
// utils/userSettings.js selecting it and useUserSettings.js saving to it: a name that differs reads
// back as nothing and saves as an error, which the page turns into a choice held in one browser.
{
  const declared = [...SCHEMA.matchAll(/ADD COLUMN IF NOT EXISTS (desktop_notifications) boolean DEFAULT (true|false) NOT NULL/g)].at(-1);
  if (!declared) problems.push('could not find user_settings.desktop_notifications in any applied migration -- the file\'s shape changed, so this check is no longer checking anything');
  const hook = need(read('frontend/src/hooks/useDesktopNotifications.js'), /^const DEFAULT_ON = (true|false)$/m,
    'DEFAULT_ON in frontend/src/hooks/useDesktopNotifications.js');
  const selected = need(read('frontend/src/utils/userSettings.js'), /\.select\('([^']*)'\)/, "the columns readUserSettings() selects in frontend/src/utils/userSettings.js");
  const saved = need(read('frontend/src/hooks/useUserSettings.js'), /save\('(desktop_notifications)', next\)/,
    'the column the desktop notifications choice is saved to in frontend/src/hooks/useUserSettings.js');
  if (declared && hook) compare('desktopNotifications', 'the default, in the migrations and the browser copy', hook[1], declared[2]);
  if (declared && selected) compare('desktopNotifications', "whether the dashboard reads the column the migrations add", selected[1].split(',').includes(declared[1]), true);
  if (declared && saved) compare('desktopNotifications', 'the column the dashboard saves and the one the migrations add', saved[1], declared[1]);
}

// -------------------------------------------------------------------------------------------------
// 7. The MTConnect semantic id the Add Metric form derives is the id `mtconnect_vocabulary` seeds
// for that data item type, and the id every MTConnect row of the example metrics carries (#457):
// each SELECTs the id of the concept it names, so that concept must be the name's last segment.
// The form's own function is run, so a change to the namespace or the kind segment on either side
// fails here rather than as a form-created metric naming no concept.
// -------------------------------------------------------------------------------------------------
{
  const { mtconnectSemanticId } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const vocabulary = [...SCHEMA.matchAll(
    /^INSERT INTO public\.mtconnect_vocabulary VALUES \('DATA_ITEM_TYPE', '([^']+)', (?:'[^']*'|NULL), '([^']+)'\)/gm
  )];
  // (name, concept) per row of the MTConnect insert: the first and fourth literals of each tuple.
  const mtconnectInsert = EXAMPLES.match(/SELECT[^;]*?'MTConnect'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /);
  const catalog = mtconnectInsert
    ? [...mtconnectInsert[1].matchAll(/\(\s*'([^']+)',\s*\d+,\s*'(?:[^']|'')*',\s*'([^']+)',/g)]
    : [];
  const vocabularyId = new Map(vocabulary.map(([, type, id]) => [type, id]));
  if (vocabulary.length === 0 || catalog.length === 0) {
    problems.push('mtconnectSemanticId: found no seeded DATA_ITEM_TYPE or example MTConnect metric -- the file\'s shape changed, so this check is no longer checking anything');
  } else {
    const derived = (name) => mtconnectSemanticId(name.split('/').pop());
    const strays = [
      ...vocabulary.filter(([, type, id]) => mtconnectSemanticId(type) !== id)
        .map(([, type, id]) => `vocabulary ${type}: seeded ${id}, form derives ${mtconnectSemanticId(type)}`),
      ...catalog.filter(([, name, concept]) => derived(name) !== vocabularyId.get(concept))
        .map(([, name, concept]) => `example ${name}: carries ${concept}'s id ${vocabularyId.get(concept)}, form derives ${derived(name)}`),
    ];
    if (strays.length) problems.push(`mtconnectSemanticId: ${strays.slice(0, 5).join('; ')}`);
    else ok.push(`mtconnectSemanticId: ${vocabulary.length} data item types and ${catalog.length} example metrics agree`);
  }
}

// -------------------------------------------------------------------------------------------------
// 8. The ASHRAE 223P metric group. The form's prefill (utils/ashrae223.js) and the seed must name the
// same one, it must be the only group registered under the standard, and the example metrics must
// file under it: they forked once (#456), the form filing under `Building` while the seeded metrics
// sat under an unregistered `BMS`.
// -------------------------------------------------------------------------------------------------
{
  const js = need(read('frontend/src/utils/ashrae223.js'), /export const ASHRAE223_GROUP = '([^']+)'/,
    'ASHRAE223_GROUP in utils/ashrae223.js');
  const registered = [...SCHEMA.matchAll(
    /INSERT INTO public\.metric_groups \(id, name, description, standard\)\s*VALUES \('[^']*', '([^']+)',\s*'(?:[^']|'')*',\s*'ASHRAE 223P'\)/g
  )].map((m) => m[1]);
  // The example metrics' INSERT ... SELECT over a VALUES list, which names the standard once.
  const seededGroups = new Set(
    [...EXAMPLES.matchAll(/INSERT INTO public\.metric_catalog \([^)]*\)\s*SELECT[^;]*?'ASHRAE 223P'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /g)]
      .flatMap((m) => [...m[1].matchAll(/\(\s*'([^'/]+)\/[^']*',/g)].map((v) => v[1]))
  );
  if (js && seededGroups.size === 0) {
    problems.push('ashrae223Group: found no example ASHRAE 223P metric -- the file\'s shape changed, so half of this check is no longer checking anything');
  }
  if (js && registered.length !== 1) {
    problems.push(`ashrae223Group: expected one metric group registered under ASHRAE 223P, found ${JSON.stringify(registered)}`);
  } else if (js) {
    compare('ashrae223Group', 'the group 223P metrics file under', js[1], registered[0]);
    const strays = [...seededGroups].filter((g) => g !== registered[0]);
    if (strays.length) {
      problems.push(`ashrae223Group: example 223P metrics file under ${JSON.stringify(strays)}, not the registered '${registered[0]}'`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 80. A derived metric's kinds and the most inputs a sum takes, SQL and JavaScript (0267). The shape
// function refuses any kind it does not list and a sum of more inputs than its limit; the Add Derived
// Metric dialog offers DERIVATION_KINDS and stops adding at DERIVED_MAX_INPUTS. A kind the dialog
// offers and the database refuses fails every save; a kind the database admits and the dialog lacks
// can never be added. Compared in order, so the dialog lists them as the function does.
// -------------------------------------------------------------------------------------------------
{
  const shape = lastDefinition('CREATE OR REPLACE FUNCTION public.derivation_shape_problem(', '$$;', 'derivation_shape_problem()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const kindsJs = need(js, /export const DERIVATION_KINDS = \[([\s\S]*?)\n\]/, 'DERIVATION_KINDS in utils/derivedMetric.js');
  const maxJs = need(js, /export const DERIVED_MAX_INPUTS = (\d+)/, 'DERIVED_MAX_INPUTS in utils/derivedMetric.js');
  const kindsSql = shape && need(shape.body, /NOT IN \(('counter_rate'[^)]*)\)/, `derivation_shape_problem()'s kinds (${shape.file})`);
  const maxSql = shape && need(shape.body, /c_max_inputs CONSTANT integer := (\d+)/, `derivation_shape_problem()'s input limit (${shape.file})`);
  if (kindsJs && maxJs && kindsSql && maxSql) {
    compare('derivedKinds', `the kinds the dialog offers and the shape function admits (${shape.file})`,
      [...kindsJs[1].matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]).join(', '),
      [...kindsSql[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', '));
    compare('derivedKinds', `the most inputs a sum takes in the dialog and in the shape function (${shape.file})`, maxJs[1], maxSql[1]);
  }
}

// 81. How a derived metric's unit and datatypes follow its inputs, SQL and JavaScript (0267).
// enforce_derived_metric() sets the unit (an input's unit followed by '/HOUR' for a rate, COUNT for a
// counter with none), reads numbers in a range of Sparkplug codes and states in three, and takes only a
// Double. The dialog shows the unit it will take and offers inputs by the same codes. A unit the dialog
// shows and the database does not set contradicts the row it creates; an input it offers and the
// database refuses fails the save.
{
  const trigger = lastDefinition('CREATE OR REPLACE FUNCTION public.enforce_derived_metric(', '$$;', 'enforce_derived_metric()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const suffixJs = need(js, /export const RATE_UNIT_SUFFIX = '([^']+)'/, 'RATE_UNIT_SUFFIX in utils/derivedMetric.js');
  const bareJs = need(js, /export const UNITLESS_COUNTER = '([^']+)'/, 'UNITLESS_COUNTER in utils/derivedMetric.js');
  const typeJs = need(js, /export const DERIVED_DATATYPE = (\d+)/, 'DERIVED_DATATYPE in utils/derivedMetric.js');
  const rangeJs = need(js, /export const NUMBER_DATATYPE_RANGE = \[(\d+), (\d+)\]/, 'NUMBER_DATATYPE_RANGE in utils/derivedMetric.js');
  const statesJs = need(js, /export const STATE_DATATYPES = \[([\d, ]+)\]/, 'STATE_DATATYPES in utils/derivedMetric.js');
  const suffixSql = trigger && need(trigger.body, /c_hour_suffix CONSTANT text := '([^']+)'/, `enforce_derived_metric()'s rate suffix (${trigger.file})`);
  const bareSql = trigger && need(trigger.body, /coalesce\(v_unit, '([^']+)'\) \|\| c_hour_suffix/, `enforce_derived_metric()'s unit for a counter with none (${trigger.file})`);
  const typeSql = trigger && need(trigger.body, /IF NEW\.datatype <> (\d+) THEN/, `enforce_derived_metric()'s datatype (${trigger.file})`);
  const rangeSql = trigger && need(trigger.body, /v_in\.datatype NOT BETWEEN (\d+) AND (\d+) THEN/, `enforce_derived_metric()'s numbers (${trigger.file})`);
  const statesSql = trigger && need(trigger.body, /v_in\.datatype NOT IN \(([\d, ]+)\) THEN/, `enforce_derived_metric()'s states (${trigger.file})`);
  if (suffixJs && bareJs && typeJs && rangeJs && statesJs && suffixSql && bareSql && typeSql && rangeSql && statesSql) {
    compare('derivedUnit', `what follows a rate's unit (${trigger.file})`, suffixJs[1], suffixSql[1]);
    compare('derivedUnit', `the unit of a counter that has none (${trigger.file})`, bareJs[1], bareSql[1]);
    compare('derivedDatatypes', `a derived metric's datatype (${trigger.file})`, typeJs[1], typeSql[1]);
    compare('derivedDatatypes', `the numbers a rate and a sum read (${trigger.file})`, `${rangeJs[1]}-${rangeJs[2]}`, `${rangeSql[1]}-${rangeSql[2]}`);
    compare('derivedDatatypes', `what a time in state reads (${trigger.file})`,
      statesJs[1].replace(/\s/g, ''), statesSql[1].replace(/\s/g, ''));
  }
}

// -------------------------------------------------------------------------------------------------
// 10. The Directory's device address, TypeScript to Python. Both project a device's address from the
// same columns, and its `device_id` is the id it publishes under, chosen by `identity_source`. A
// column one side stops reading, or a source only one side handles, gives that side the issued id
// for a device publishing another: the same device at two addresses.
// -------------------------------------------------------------------------------------------------
{
  const ts = read('supabase/functions/fplus-directory/index.ts');
  const py = read('ingestion/directory_publish.py');
  const columns = (block) => [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
  const tsColumns = need(ts, /const DEVICE_COLUMNS =([^;]+);/, 'DEVICE_COLUMNS in fplus-directory/index.ts');
  const pyColumns = need(py, /^_DEVICE_COLUMNS = \(([^)]*\([^)]*\)[^)]*)\)/m, '_DEVICE_COLUMNS in directory_publish.py');
  if (tsColumns && pyColumns) {
    compare('directoryDeviceColumns', 'the device columns read', columns(pyColumns[1]), columns(tsColumns[1]));
  }
  const tsRule = need(ts, /function publishedDeviceId\([\s\S]*?\n\}/, 'publishedDeviceId() in fplus-directory/index.ts');
  const pyRule = need(py, /^def _published_device_id\([\s\S]*?\n(?=\S)/m, '_published_device_id() in directory_publish.py');
  if (tsRule && pyRule) {
    // Each side's (identity_source, column) pairs, in its order, and the fallback after them.
    const tsPairs = [...tsRule[0].matchAll(/source === "(\w+)"\s*\?\s*(null|row\.(\w+))/g)]
      .map((m) => `${m[1]}->${m[3] ?? 'issued'}`);
    const pyPairs = [...pyRule[0].matchAll(/source == "(\w+)":\s*published = (None|row\.get\("(\w+)"\))/g)]
      .map((m) => `${m[1]}->${m[3] ?? 'issued'}`);
    const tsElse = need(tsRule[0], /:\s*row\.(\w+);/, 'the fallback column of publishedDeviceId()');
    const pyElse = need(pyRule[0], /else:\s*published = row\.get\("(\w+)"\)/, 'the fallback column of _published_device_id()');
    if (tsPairs.length === 0 || pyPairs.length === 0) {
      problems.push('directoryPublishedId: found no identity_source branch -- the function\'s shape changed, so this check is no longer checking anything');
    } else if (tsElse && pyElse) {
      compare('directoryPublishedId', 'the id each identity_source publishes under',
        [...pyPairs, `else->${pyElse[1]}`].join(', '), [...tsPairs, `else->${tsElse[1]}`].join(', '));
    }
  }
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nSQL-to-JavaScript mirror drift:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThese pairs answer the same question in two languages because one runs in a browser');
  console.error('and one in PostgreSQL. A divergence is silent: both sides keep working, and disagree.');
  process.exit(1);
}
console.log(
  `\nAll ${ok.length} mirrored values agree between the frontend and the applied migration ` +
    `chain (${MIGRATION_FILES.length} files, last definition wins).`
);
