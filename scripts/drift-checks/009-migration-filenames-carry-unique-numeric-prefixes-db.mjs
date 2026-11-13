import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 9. Migration filenames carry unique numeric prefixes. db-init applies `/migrations/*.sql` in glob
// order with no ledger, so the filename is the execution order; two files sharing a prefix run in
// an order decided by whatever follows the number.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  const byPrefix = new Map();
  for (const name of files) {
    const match = name.match(/^(\d+)_/);
    if (!match) {
      fail(`${dir}/${name} has no numeric prefix; db-init applies these in glob order`);
      continue;
    }
    const prefix = match[1];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }

  let clash = false;
  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) {
      clash = true;
      fail(
        `${dir} has ${names.length} migrations numbered ${prefix}: ${names.join(', ')}. ` +
          `Execution order is then decided by the text after the number, not by anyone's intent.`
      );
    }
  }

  if (!clash) pass(`${files.length} migrations carry unique numeric prefixes`);
}
