import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 42. Nothing gives a self-registered account a role: no applied migration puts a trigger on
// auth.users.
//
// help/site/install.md (*Accounts*) and the sign-up entry in docs/openapi.yaml say an account made by
// open sign-up (`supabaseAuth.disableSignup` false) has no role until an Administrator gives it one.
// A trigger on auth.users runs for every such account, and one that writes user_roles hands a role
// to anyone who can reach the endpoint.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const files = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const TRIGGER = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("?[\w$]+"?)[^;]*?\bON\s+"?auth"?\s*\.\s*"?users"?(?![\w"])/gi;
  const offences = [];
  for (const f of files) {
    const sql = read(`supabase/migrations/${f}`);
    for (const m of sql.matchAll(TRIGGER)) {
      offences.push(`supabase/migrations/${f}:${sql.slice(0, m.index).split('\n').length} creates ${m[1]}`);
    }
  }
  if (!files.length) {
    fail('check 42 found no applied migrations in supabase/migrations, so it checks nothing');
  } else if (offences.length) {
    fail('a migration puts a trigger on auth.users, which runs for every self-registered account:\n'
      + offences.map((o) => `        ${o}`).join('\n')
      + '\n      Remove it. If it must run at sign-up, first say what it gives a new account in '
      + 'help/site/install.md (Accounts) and the /auth/v1/signup entry in docs/openapi.yaml, then teach check 42 the exception.');
  } else {
    pass(`none of the ${files.length} applied migrations puts a trigger on auth.users, so sign-up gives no role`);
  }
}
