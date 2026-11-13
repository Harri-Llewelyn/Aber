import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 149. i3X records a token's use through a function `authenticated` may call and `anon` may not.
//
// i3x_service.py calls TOKEN_USE_PATH as the caller after accepting a token. Given an argument, a
// caller could name another token; marked STABLE or IMMUTABLE, it could not write; not SECURITY
// DEFINER, it could not write a table nobody else may; revoked from `authenticated`, nothing is
// recorded; callable by `anon` or `service_role`, it would answer callers that hold no token.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const path = read('i3x/i3x_service.py').match(/^TOKEN_USE_PATH = "rpc\/([a-z0-9_]+)"$/m);
  if (!path) {
    fail('i3x/i3x_service.py: TOKEN_USE_PATH is not an "rpc/<function>" literal, so check 149 cannot read it');
  } else {
    const fn = path[1];
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
    if (new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\((?!\\))`).test(sql)) {
      faults.push(`a migration declares public.${fn}() with an argument, so a caller could name another token`);
    }
    const headers = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${sig}[^$]*?AS\\s*\\$`, 'g'))];
    const header = headers.length ? headers[headers.length - 1][0] : '';
    if (header && /\b(STABLE|IMMUTABLE)\b/i.test(header)) {
      faults.push(`public.${fn}() is STABLE or IMMUTABLE, so it cannot record anything`);
    }
    if (header && !/\bSECURITY DEFINER\b/i.test(header)) {
      faults.push(`public.${fn}() is not SECURITY DEFINER, so the caller cannot write its table`);
    }
    if (header && !/\bSET search_path\b/i.test(header)) {
      faults.push(`public.${fn}() is SECURITY DEFINER without a pinned search_path`);
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
    if (!read('i3x/README.md').includes(`rpc/${fn}`)) {
      faults.push(`i3x/README.md -> "Security" does not name rpc/${fn}`);
    }
    if (faults.length) {
      fail(`i3X's token-use call rpc/${fn} would record nothing, or record for a caller it should not:\n` +
        faults.map((f) => `        ${f}`).join('\n'));
    } else {
      pass(`i3X records a token's use through rpc/${fn}, which authenticated may call and anon may not`);
    }
  }
}
