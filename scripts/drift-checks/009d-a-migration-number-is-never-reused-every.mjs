import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 9d. A migration number is never reused. Every applied migration but the baseline is numbered above
// the highest in the archive, so a citation of an archived number can never come to name a live
// file. The squash before this rule restarted at 0003, and every bare citation of the archived
// 0003-0032 silently re-pointed as the live chain grew past them.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const num = (name) => Number(name.slice(0, 4));
  const archived = readdirSync(join(REPO, dir, 'archive')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map(num);
  const highest = Math.max(...archived);
  const next = String(highest + 1).padStart(4, '0');
  // 0001 and 0002 are the baseline, which each squash regenerates in place.
  const reused = readdirSync(join(REPO, dir))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !/^000[12]_/.test(f) && num(f) <= highest);

  if (!archived.length) {
    fail(`${dir}/archive/ holds no four-digit migration, so check 9d compares nothing`);
  } else if (reused.length) {
    fail(
      `${reused.join(', ')} reuse(s) a number the archive already holds (its highest is ${highest}).\n` +
        `      Number it ${next} or above: every existing citation of that archived number would\n` +
        '      otherwise name the new file. supabase/migrations/archive/README.md has the rule.'
    );
  } else {
    pass(`no applied migration reuses an archived number; the next is ${next}`);
  }
}
