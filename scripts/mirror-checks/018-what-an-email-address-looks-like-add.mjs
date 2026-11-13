import { compare, lastDefinition, need, read } from './lib.mjs';

// 18. What an email address looks like. Add Person and Change Email refuse an address in the
// dashboard (utils/people.js) and in manage-people before anything is asked, and
// ensure_first_administrator() and check_person_email_change() refuse one in the database. A shape
// one side accepts and another refuses is a form that sends what the server refuses, or a server
// that takes what the first administrator's setup would not.
export default function check() {
  const asJs = (sqlPattern) => sqlPattern.replace(/\[:space:\]/g, '\\s');
  const sides = [
    ['frontend/src/utils/people.js', need(read('frontend/src/utils/people.js'), /^export const EMAIL = \/(.+)\/$/m, 'EMAIL in frontend/src/utils/people.js')?.[1]],
    ['supabase/functions/manage-people/people.ts', need(read('supabase/functions/manage-people/people.ts'), /^const EMAIL = \/(.+)\/;$/m, 'EMAIL in manage-people/people.ts')?.[1]],
  ];
  for (const [fn, what] of [['ensure_first_administrator', 'v_email'], ['check_person_email_change', 'v_email']]) {
    const def = lastDefinition(`CREATE OR REPLACE FUNCTION public.${fn}(`, '$$;', `${fn}() in the applied chain`);
    const sql = def && need(def.body, new RegExp(`${what} !~ '([^']+)'`), `the address test in ${fn}() (${def.file})`);
    sides.push([`${fn}() in ${def?.file}`, sql ? asJs(sql[1]) : undefined]);
  }
  const [[firstFile, first], ...rest] = sides;
  for (const [file, pattern] of rest) {
    if (first !== undefined && pattern !== undefined) compare('email', `address shape ${firstFile} and ${file} accept`, first, pattern);
  }
}
