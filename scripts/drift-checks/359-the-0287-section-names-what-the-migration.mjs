import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 359. The 0287 section names what the migration declares, and 0257's section points to it. A
// function or a trigger added to the file and left out of the section is a reader tracing why a
// delete resolves once, or why a row trigger that does nothing is still there, with no map.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const MIGRATION = 'supabase/migrations/0287_deleting_an_automation_resolves_its_alerts_in_one_pass.sql';
  const HEADING = 'Deleting an automation resolves its alerts in one pass (0287)';
  const readme = supabaseReadme();
  const sql = read(MIGRATION);
  const problems359 = [];
  const section = readme.match(new RegExp(`\\n### ${HEADING.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n### )`))?.[1];
  const functions = [...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/gm)].map((m) => m[1]);
  const triggers = [...sql.matchAll(/^SELECT public\.replay_trigger\('public\.[a-z_]+', '([a-z_]+)'/gm)].map((m) => m[1]);
  if (!section) problems359.push(`supabase/README.md has no section "${HEADING}"`);
  if (functions.length < 4 || triggers.length < 1) problems359.push(`${MIGRATION}: could not read its functions (${functions.length}) and its trigger (${triggers.length})`);
  if (section) {
    for (const name of [...functions, ...triggers]) {
      if (!section.includes(`\`${name}(`) && !section.includes(`\`${name}\``)) {
        problems359.push(`the 0287 section does not name \`${name}\`, which ${MIGRATION} declares`);
      }
    }
    if (!/An `AFTER DELETE` statement trigger/.test(section)) problems359.push('the 0287 section does not say the delete resolves in an AFTER DELETE statement trigger');
    if (!/`0257`'s row trigger stays/.test(section)) problems359.push("the 0287 section does not say 0257's row trigger stays");
  }
  const at257 = readme.match(/\n### An automation follows the devices it names \(0257\)\n([\s\S]*?)(?=\n### )/)?.[1];
  if (!at257) problems359.push('supabase/README.md has no 0257 section');
  else if (!at257.includes(`*${HEADING}*`)) problems359.push(`the 0257 section does not point to *${HEADING}*`);
  if (problems359.length) {
    fail(`supabase/README.md does not describe 0287 as the migration declares it:\n${problems359.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the 0287 section names its ${functions.length} functions and its statement trigger, and 0257's section points to it`);
  }
}
