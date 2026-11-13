import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 298. How many addresses an app may be registered with (0260). register_app() takes 1 to c_max_uris
// of them; the help page, the author's guide and the dialog's hint say how many, in words.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migrations = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const owner = migrations.filter((f) => read(`supabase/migrations/${f}`).includes('FUNCTION public.register_app(')).pop();
  const max = owner ? Number(read(`supabase/migrations/${owner}`).match(/c_max_uris\s+CONSTANT integer := (\d+);/)?.[1]) : NaN;
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const problems298 = [];
  if (!max) problems298.push('no migration declares register_app() with c_max_uris, so this check reads nothing');
  for (const [file, needle] of [
    ['help/pages/access-control.md', `are one to ${WORDS[max]}, one to a line`],
    ['docs/sign-in-with-aber.md', `One to ${WORDS[max]}, one to a line`],
  ]) {
    if (max && !read(file).includes(needle)) problems298.push(`${file} does not say "${needle}", the ${max} addresses register_app() takes`);
  }
  if (problems298.length) {
    for (const p of problems298) fail(`app registration limits: ${p}`);
  } else {
    pass(`the help page and the author's guide say an app takes one to ${WORDS[max]} redirect addresses, as register_app() (${owner}) does`);
  }
}
