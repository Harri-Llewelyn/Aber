import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 28b. The Backups page and backup_prunable() agree about how many backups the prune keeps
//
// The page says "Kept: one of the newest three" from its own constant; the floor is the LIMIT in
// the last migration that declares backup_prunable(). Read from the latest declaration, because the
// chain replays in order and that one wins.
export default function check() {
  const page = read('frontend/src/components/tabs/BackupsTab.jsx')
    .match(/BACKUP_RETENTION_FLOOR\s*=\s*(\d+)/)?.[1];
  const declaring = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.backup_prunable\s*\(/.test(read(`supabase/migrations/${f}`)));
  const last = declaring[declaring.length - 1];
  const body = last ? read(`supabase/migrations/${last}`).split(/CREATE OR REPLACE FUNCTION public\.backup_prunable\s*\(/)[1] : '';
  const sql = body?.split(/\$\$;/)[0].match(/ORDER BY n\.taken_at DESC[^\n]*LIMIT (\d+)/)?.[1];

  if (!page || !sql) {
    fail(
      `the retention floor could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `${last || 'no migration'}: ${sql || 'MISSING'}). One of them has been renamed or removed.`
    );
  } else if (page !== sql) {
    fail(
      `the Backups page says the newest ${page} backups are kept and backup_prunable() in ${last} ` +
        `keeps ${sql}. The page would explain a backup the next prune deletes, or miss one it keeps.`
    );
  } else {
    pass(`the retention floor is ${page} backups on the Backups page and in backup_prunable() (${last})`);
  }
}
