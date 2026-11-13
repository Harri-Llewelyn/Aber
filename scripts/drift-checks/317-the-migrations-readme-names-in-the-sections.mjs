import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 317. The migrations' README names, in the sections for 0270 and 0271, each function and table those
// files create, the job, and the alert a run that cannot read raises. The sections are the only place
// the reasoning is written, and one that forgets an object leaves it with none.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const README = 'supabase/README.md';
  const readme = supabaseReadme();
  const problems317 = [];
  const at = readme.indexOf('\n### A threshold automation is read against the historian (0270)\n');
  const end = readme.indexOf('\n### ', readme.indexOf('\n### A threshold automation raises its alert from the database (0271)\n') + 5);
  const text = at < 0 || end < 0 ? '' : readme.slice(at, end);
  if (!text) problems317.push(`${README} has no sections for 0270 and 0271, in that order`);
  const created = [];
  for (const file of ['0270_a_threshold_automation_is_read_against_the_historian.sql', '0271_a_threshold_automation_raises_its_alert_from_the_database.sql']) {
    const sql = read(`supabase/migrations/${file}`);
    for (const m of sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)) created.push(m[1]);
    for (const m of sql.matchAll(/^CREATE TABLE IF NOT EXISTS public\.(\w+) \(/gm)) created.push(m[1]);
    for (const m of sql.matchAll(/ensure_cron_job\(\s*'(\w+)'/g)) created.push(m[1]);
    for (const m of sql.matchAll(/c_not_evaluated CONSTANT text := '([^']+)'/g)) created.push(m[1]);
  }
  if (created.length < 6) problems317.push(`found ${created.length} objects in 0270 and 0271, so the files were not parsed`);
  for (const name of created) {
    if (text && !text.includes(`\`${name}`)) problems317.push(`${README}: the 0270 and 0271 sections do not name ${name}`);
  }
  if (problems317.length) {
    fail(`the migrations' README does not name what 0270 and 0271 create:\n${problems317.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the migrations' README names the ${created.length} functions, table, job and alert that 0270 and 0271 create`);
  }
}
