import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 316. docs/automations.md says how an automation is evaluated as 0271 and 0247 declare it: that the
// job runs every minute, how long a run's confirmation holds, the platform alert a run that cannot
// read the historian raises by its name and its fingerprint, and the labels and values an alert holds
// as the evaluator writes them. A number that moved in the migration and not here is a reader
// planning around a minute that is now two.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/automations.md';
  const EVALUATOR = 'supabase/migrations/0271_a_threshold_automation_raises_its_alert_from_the_database.sql';
  const doc = read(DOC);
  const sql = read(EVALUATOR);
  const window = read('supabase/migrations/0247_an_alert_is_queued_for_each_channel_that_carries_it.sql');
  const problems316 = [];
  // The quoted keys of a jsonb_build_object( call that starts with `start`: its even arguments.
  const keysOf = (text, start) => {
    const at = text.indexOf(start);
    if (at < 0) return [];
    const args = [];
    let depth = 0;
    let from = at + 'jsonb_build_object('.length;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) { args.push(text.slice(from, i)); break; }
        depth -= 1;
      } else if (c === ',' && depth === 0) { args.push(text.slice(from, i)); from = i + 1; }
    }
    return args.filter((_, n) => n % 2 === 0).map((a) => a.trim().replace(/^'|'$/g, ''));
  };
  const words = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
  const section = doc.match(/\n## How an automation is evaluated\n([\s\S]*?)(?=\n## )/)?.[1];
  if (!section) {
    problems316.push(`${DOC} has no "How an automation is evaluated" section`);
  } else {
    const schedule = sql.match(/'evaluate_automations',\s*'([^']+)'/)?.[1];
    if (schedule !== '* * * * *') problems316.push(`${EVALUATOR} schedules evaluate_automations as "${schedule}", and this check reads only every minute`);
    if (!section.includes('once a minute')) problems316.push(`${DOC} does not say the database evaluates once a minute, as ${EVALUATOR} schedules it`);
    const minutes = window.match(/WHEN starts_with\(p_fingerprint, 'condition:'\) THEN interval '(\d+) minutes'/)?.[1];
    if (!minutes) problems316.push('0247 gives no condition: window in minutes');
    else if (!section.includes(`within the past ${words[minutes] ?? minutes} minutes`)) {
      problems316.push(`${DOC} does not say a reminder needs the last run's confirmation within the past ${words[minutes] ?? minutes} minutes, as 0247 allows`);
    }
    const fingerprint = sql.match(/c_not_evaluated CONSTANT text := '([^']+)'/)?.[1];
    const name = sql.match(/SELECT c_not_evaluated, 'platform', '([^']+)'/)?.[1];
    if (!fingerprint || !name) problems316.push(`${EVALUATOR}: could not read the alert a run that cannot read the historian raises`);
    else {
      if (!section.includes(`**${name}**`)) problems316.push(`${DOC} does not name the alert **${name}**, which ${EVALUATOR} raises`);
      if (!section.includes(`\`${fingerprint}\``)) problems316.push(`${DOC} does not give that alert's fingerprint \`${fingerprint}\``);
    }
    const holds = doc.match(/\n### What an alert holds\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
    const labels = keysOf(sql, "jsonb_build_object('severity', act.severity");
    const values = keysOf(sql, "jsonb_build_object('value', d.last_value");
    if (labels.length < 5 || values.length < 2) problems316.push(`${EVALUATOR}: could not read the labels and values of an alert (${labels.length} and ${values.length} keys)`);
    for (const key of [...labels, ...values]) {
      if (!holds.includes(`\`${key}\``)) problems316.push(`${DOC}: "What an alert holds" does not name \`${key}\`, which ${EVALUATOR} writes`);
    }
  }
  if (problems316.length) {
    fail(`docs/automations.md does not say how an automation is evaluated as the migrations declare it:\n${problems316.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('docs/automations.md says the evaluator runs once a minute, a confirmation holds five minutes, and names the alert for an unreadable historian and the labels and values of an alert');
  }
}
