import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11d. The Access Control page describes every database principal a migration seeds.
//
// `describePrincipal()` falls back to "Undocumented principal" rather than hiding the row, so an
// unlisted principal is quiet. Only literal, pinned ids are required: a principal minted at
// runtime has no id to write down ahead of time, and the fallback text is right for one of those.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const ui = read('frontend/src/utils/serviceIdentities.js');

  // The seeding shape the migrations share: a bare `(id)` insert with a literal uuid. Requiring
  // the single-column form keeps seed.sql's human accounts out.
  const seeded = new Map();
  const migrationDir = 'supabase/migrations';
  const migrations = readdirSync(join(REPO, migrationDir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  for (const file of migrations) {
    const sql = read(`${migrationDir}/${file}`);
    for (const [, id] of sql.matchAll(
      /INSERT\s+INTO\s+auth\.users\s*\(\s*id\s*\)\s*VALUES\s*\(\s*'([0-9a-f-]{36})'\s*\)/gi
    )) {
      if (!seeded.has(id)) seeded.set(id, file);
    }
  }

  const described = new Set(
    [...ui.matchAll(/'([0-9a-f-]{36})':\s*\{/g)].map((m) => m[1])
  );

  if (seeded.size === 0) {
    fail(
      'could not find any pinned service principal in supabase/migrations. 0034, 0046 and 0056 each ' +
        "seed one with `INSERT INTO auth.users (id) VALUES ('<uuid>')` -- if that shape changed, " +
        'this check needs to change with it rather than silently passing.'
    );
  } else {
    const missing = [...seeded].filter(([id]) => !described.has(id));
    if (missing.length) {
      fail(
        'frontend/src/utils/serviceIdentities.js has no KNOWN_PRINCIPALS entry for: ' +
          missing.map(([id, file]) => `${id} (seeded by ${file})`).join(', ') +
          '.\n      The Access Control page renders these as "Undocumented principal", which tells an\n' +
          '      operator that an identity able to reach the stack is one the dashboard cannot name.'
      );
    } else {
      pass(
        `the Access Control page names all ${seeded.size} service principals pinned by a migration`
      );
    }
  }
}
