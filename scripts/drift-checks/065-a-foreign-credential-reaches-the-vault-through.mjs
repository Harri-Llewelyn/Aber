import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 65. A foreign credential reaches the vault through set_foreign_credential() alone. A function
// whose last declaration in the chain calls vault.create_secret() or vault.update_secret() is that
// helper or a writer named below with its reason; the seeds in 0002 are DO blocks, not functions.
// A third copy of the writer is the shape supabase/README.md's secrets rule replaced (0178): each
// copy is one more place the Administrator gate or the in-place rotation can be got wrong.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const ALLOWED = {
    'public.set_foreign_credential': 'the one writer every foreign credential shares',
    'public.keep_gateway_credential': 'keeps a copy of a broker password the platform issued, which is not a foreign credential',
    'public.issue_notification_signing_key': 'generates the webhook\'s signing key, which Aber issues and shows once, so it is not a foreign credential (0248)',
  };
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const last = new Map();
  for (const name of files) {
    const text = read(`${dir}/${name}`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\([\s\S]*?\bAS\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi)) {
      last.set(m[1].toLowerCase(), { file: name, body: m[3] });
    }
  }
  const writers = [...last].filter(([, d]) => /\bvault\.(create|update)_secret\s*\(/i.test(d.body));
  const stray = writers.filter(([fn]) => !(fn in ALLOWED));
  const stale = Object.keys(ALLOWED).filter((fn) => !writers.some(([w]) => w === fn));
  for (const [fn, d] of stray) {
    fail(`${fn}() writes the vault itself (${d.file}): a foreign credential's writer calls public.set_foreign_credential(), as set_archive_credential() does (0178)`);
  }
  for (const fn of stale) fail(`check 65 allows ${fn}() to write the vault, and its last declaration does not: remove it from the list`);
  if (!stray.length && !stale.length) {
    pass(`the vault is written by ${writers.length} function(s) in the chain, each named with its reason: ${writers.map(([fn]) => fn).join(', ')}`);
  }
}
