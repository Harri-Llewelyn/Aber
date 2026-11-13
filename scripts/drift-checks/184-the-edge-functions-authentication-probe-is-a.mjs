import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 184. The edge functions' authentication probe is a function `authenticated` alone may call.
//
// _shared/callerCheck.ts calls AUTH_PROBE as the caller for aas-api and fplus-directory. Revoked
// from `authenticated`, dropped or given an argument, it refuses every token; callable by `anon`, it
// accepts the publishable key; by `service_role`, the secret key, in functions that hold no
// service-role key. It must be plpgsql and not IMMUTABLE, as i3X's probe must (check 32).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const probe = read('supabase/functions/_shared/callerCheck.ts').match(/^export const AUTH_PROBE = "([a-z0-9_]+)";$/m);
  if (!probe) {
    fail('supabase/functions/_shared/callerCheck.ts: AUTH_PROBE is not a string literal, so check 184 cannot read it');
  } else {
    const fn = probe[1];
    const sig = `public\\.${fn}\\(\\)`;
    const dir = 'supabase/migrations';
    const sql = readdirSync(join(REPO, dir))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort()
      .map((n) => read(`${dir}/${n}`))
      .join('\n');
    const faults = [];
    if (!new RegExp(`CREATE OR REPLACE FUNCTION ${sig}`).test(sql)) {
      faults.push(`no migration declares public.${fn}() with no arguments`);
    }
    const headers = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${sig}[^$]*?AS\\s*\\$`, 'g'))];
    const header = headers.length ? headers[headers.length - 1][0] : '';
    if (header && !/\bLANGUAGE\s+plpgsql\b/i.test(header)) {
      faults.push(`public.${fn}() is not plpgsql, so the planner may inline it and skip its EXECUTE check`);
    }
    if (/\bIMMUTABLE\b/i.test(header)) {
      faults.push(`public.${fn}() is IMMUTABLE, so the planner folds the call and skips its EXECUTE check`);
    }
    if (!new RegExp(`GRANT (ALL|EXECUTE) ON FUNCTION ${sig} TO [^;]*\\bauthenticated\\b`).test(sql)) {
      faults.push(`public.${fn}() is not granted to authenticated`);
    }
    if (!new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, service_role`).test(sql)) {
      faults.push(`public.${fn}() keeps PUBLIC's, anon's or service_role's default EXECUTE`);
    }
    if (new RegExp(`GRANT [^;]* ON FUNCTION ${sig} TO [^;]*\\b(anon|PUBLIC|service_role)\\b`, 'i').test(sql)) {
      faults.push(`public.${fn}() is granted to anon, PUBLIC or service_role`);
    }
    if (new RegExp(`(REVOKE [^;]* ON FUNCTION ${sig} FROM [^;]*\\bauthenticated\\b|DROP FUNCTION[^;]*\\b${fn}\\b)`, 'i').test(sql)) {
      faults.push(`a migration revokes public.${fn}() from authenticated, or drops it`);
    }
    if (!supabaseReadme().includes(`\`${fn}()\``)) {
      faults.push(`supabase/README.md does not name the probe, \`${fn}()\``);
    }
    if (faults.length) {
      fail(`The edge functions' authentication probe ${fn}() would refuse every token or admit a key:\n` +
        faults.map((f) => `        ${f}`).join('\n'));
    } else {
      pass(`aas-api and fplus-directory authenticate through ${fn}(), which authenticated alone may call`);
    }
  }
}
