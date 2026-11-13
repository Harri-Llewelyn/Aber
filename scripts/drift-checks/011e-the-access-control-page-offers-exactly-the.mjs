import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11e. The Access Control page offers exactly the permissions create_machine_principal() allows.
//
// The function refuses anything outside its allow-list, so a permission the page offered and the
// function refused would fail at the click, and one the function allowed and the page did not offer
// would be grantable only by hand. Both lists are read statically: the LAST migration that declares
// the function is the one that runs last, and the page's menu is the keys of PERMISSION_REACH.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migrationDir = 'supabase/migrations';
  const migrations = readdirSync(join(REPO, migrationDir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();

  let allowed = null;
  let declaredIn = null;
  for (const file of migrations) {
    const sql = read(`${migrationDir}/${file}`);
    const fn = /CREATE OR REPLACE FUNCTION\s+public\.create_machine_principal\s*\([\s\S]*?\n\$\$;/i.exec(sql);
    if (!fn) continue;
    const list = /c_allowed\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(fn[0]);
    if (list) {
      allowed = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      declaredIn = file;
    }
  }

  const ui = read('frontend/src/utils/serviceIdentities.js');
  const reach = /const PERMISSION_REACH\s*=\s*\{([\s\S]*?)\n\}/.exec(ui);
  const offered = reach
    ? [...reach[1].matchAll(/^\s*'([a-z_]+:[a-z_]+)':/gm)].map((m) => m[1]).sort()
    : null;

  if (!allowed) {
    fail(
      'could not find c_allowed in any migration declaring create_machine_principal(). 0001 ' +
        'spells it `c_allowed CONSTANT text[] := ARRAY[...]` -- if that shape changed, ' +
        'this check needs to change with it rather than silently passing.'
    );
  } else if (!offered) {
    fail('could not find PERMISSION_REACH in frontend/src/utils/serviceIdentities.js');
  } else if (allowed.join(',') !== offered.join(',')) {
    fail(
      `the Access Control page offers [${offered.join(', ')}] when creating a principal, but ` +
        `create_machine_principal() (${declaredIn}) allows [${allowed.join(', ')}].\n` +
        '      The menu is the keys of PERMISSION_REACH in serviceIdentities.js; the allow-list is\n' +
        '      c_allowed in the function. Change both, or neither.'
    );
  } else {
    pass(`the Access Control page offers exactly the ${allowed.length} permissions create_machine_principal() allows`);
  }
}
