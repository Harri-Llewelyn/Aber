import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 32. i3X's authentication probe is a function `authenticated` may call and `anon` may not.
//
// i3x_service.py authenticates every request but GET /info by calling AUTH_PROBE_PATH as the
// caller. Revoked from `authenticated`, dropped or given an argument, it refuses every token;
// callable by `anon`, it accepts the publishable key and any string that is not a token. It must
// be plpgsql and not IMMUTABLE: a call the planner inlines or folds is no longer in PostgREST's
// reused plan, so its EXECUTE check is skipped for the next role that runs that plan.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const probe = read('i3x/i3x_service.py').match(/^AUTH_PROBE_PATH = "rpc\/([a-z0-9_]+)"$/m);
  if (!probe) {
    fail('i3x/i3x_service.py: AUTH_PROBE_PATH is not an "rpc/<function>" literal, so check 32 cannot read it');
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
    // The last declaration's header, up to its body, is the definition the database ends with.
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
    if (!new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(sql)) {
      faults.push(`public.${fn}() keeps PUBLIC's default EXECUTE, which anon inherits`);
    }
    if (new RegExp(`GRANT [^;]* ON FUNCTION ${sig} TO [^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) {
      faults.push(`public.${fn}() is granted to anon or PUBLIC`);
    }
    if (new RegExp(`(REVOKE [^;]* ON FUNCTION ${sig} FROM [^;]*\\bauthenticated\\b|DROP FUNCTION[^;]*\\b${fn}\\b)`, 'i').test(sql)) {
      faults.push(`a migration revokes public.${fn}() from authenticated, or drops it`);
    }
    if (!read('i3x/README.md').includes(`rpc/${fn}`)) {
      faults.push(`i3x/README.md -> "Security" does not name the probe, rpc/${fn}`);
    }
    if (faults.length) {
      fail(`i3X's authentication probe rpc/${fn} would refuse every token or admit anon:\n` +
        faults.map((f) => `        ${f}`).join('\n'));
    } else {
      pass(`i3X authenticates through rpc/${fn}, which authenticated may call and anon may not`);
    }
  }
}
