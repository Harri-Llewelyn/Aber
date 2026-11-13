import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11b. No seeded credential is compiled into the browser bundle. Everything under frontend/src is
// served to anyone who can reach the page. The password is read out of seed.sql rather than
// repeated here, so rotating the seed rotates what this refuses. Scoped to frontend/src, tests
// included: the demo credential is published deliberately everywhere else.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const seed = read('supabase/seed.sql');
  const seeded = /extensions\.crypt\('([^']+)'/.exec(seed);
  if (!seeded) {
    fail(
      'could not read the seeded password out of supabase/seed.sql. This check derives the value\n' +
        '      it refuses from that file; if the seed no longer uses extensions.crypt(), update the\n' +
        '      pattern here rather than hardcoding a password into this script.'
    );
  } else {
    const password = seeded[1];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(jsx?|tsx?|css|html)$/.test(entry.name)) {
          if (readFileSync(join(REPO, rel), 'utf8').includes(password)) offenders.push(rel);
        }
      }
    };
    walk('frontend/src');
    if (offenders.length) {
      fail(
        `the seeded account password appears in ${offenders.length} frontend source file(s): ` +
          `${offenders.join(', ')}.\n` +
          '      Everything under frontend/src is compiled into the browser bundle, which is served\n' +
          '      unauthenticated. The sign-in form shipped this way once; see the comment on\n' +
          '      AuthScreen in frontend/src/App.jsx.'
      );
    } else {
      pass('no seeded account password appears in any frontend source file');
    }
  }
}
