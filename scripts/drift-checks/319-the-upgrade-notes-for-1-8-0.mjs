import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 319. The upgrade notes for 1.8.0 say what the evaluator does to a running site, by the job's name,
// its interval and the platform alert it can raise, as 0271 declares them.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'help/site/upgrading.md';
  const upgrading = upgradingGuide();
  const sql = read('supabase/migrations/0271_a_threshold_automation_raises_its_alert_from_the_database.sql');
  const problems319 = [];
  const section = upgrading.match(/\n### From 1\.8\.0, the database evaluates automations\n([\s\S]*?)(?=\n### |\n---\n)/)?.[1];
  const job = sql.match(/ensure_cron_job\(\s*'(\w+)',\s*'([^']+)'/);
  const name = sql.match(/SELECT c_not_evaluated, 'platform', '([^']+)'/)?.[1];
  if (!section) problems319.push(`${DOC} has no "From 1.8.0, the database evaluates automations" section`);
  if (!job || job[2] !== '* * * * *' || !name) problems319.push('0271: could not read the job, its schedule or the alert it raises');
  if (section && job && name) {
    if (!section.includes(`\`${job[1]}\``)) problems319.push(`${DOC} does not name the job \`${job[1]}\``);
    if (!section.includes('every minute')) problems319.push(`${DOC} does not say the job runs every minute, as 0271 schedules it`);
    if (!section.includes(`**${name}**`)) problems319.push(`${DOC} does not name the alert **${name}**`);
  }
  if (problems319.length) {
    fail(`the 1.8.0 upgrade notes do not say what the evaluator does as 0271 declares it:\n${problems319.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('the 1.8.0 upgrade notes name the evaluator\'s job, its minute, and the alert for an unreadable historian');
  }
}
