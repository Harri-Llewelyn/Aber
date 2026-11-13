import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 363. The two links display_names_for() names are the two read policies' rows (0290). The arm for
// an alert's acknowledger states platform_alerts_select_authenticated's predicate as 0204 last
// declares it, and the arm for a window's author states that every signed-in role reads every
// window, as 0001 declares. A policy that gained a condition and an arm that did not is a name read
// by a caller who may not read the alert, which the suite for 0290 holds only for the policy it
// finds; this holds the two sources together before a database does.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const policy = (name, table) => {
    let last = null;
    const start = `CREATE POLICY ${name} ON public.${table} `;
    for (const file of files) {
      const statement = read(`${dir}/${file}`).split('\n').find((line) => line.startsWith(start));
      if (statement) last = { file, statement };
    }
    return last;
  };
  const alerts = policy('platform_alerts_select_authenticated', 'platform_alerts');
  const windows = policy('alert_suppression_windows_select_authenticated', 'alert_suppression_windows');
  const sql = read(`${dir}/0290_an_acknowledger_is_shown_by_name.sql`);
  const arm = sql.match(/FUNCTION public\.display_names_for\([\s\S]*?\n\$\$;/)?.[0] ?? '';
  const problems363 = [];
  if (!alerts || !windows) problems363.push('could not find the last declaration of the alert or the window read policy');
  if (!arm) problems363.push('could not read display_names_for() out of 0290');
  if (!problems363.length) {
    // The alert policy: every alert but a machine identity's, which an Administrator reads.
    if (!/entity_type <> 'service_identity'::text\) OR \( SELECT public\.has_role\(ARRAY\['Administrator'::text\]\)/.test(alerts.statement)) {
      problems363.push(`${alerts.file} declares platform_alerts_select_authenticated as something other than "not a machine identity's, or an Administrator": ${alerts.statement}`);
    }
    if (!/a\.entity_type <> 'service_identity'[\s\S]*?has_role\(ARRAY\['Administrator'\]\)/.test(arm)) {
      problems363.push("0290's arm for an acknowledger does not state that policy: every alert but a machine identity's, or an Administrator");
    }
    if (!/FOR SELECT TO authenticated USING \(true\)/.test(windows.statement)) {
      problems363.push(`${windows.file} declares alert_suppression_windows_select_authenticated as something other than USING (true): ${windows.statement}`);
    }
    if (!/FROM public\.alert_suppression_windows w\s+WHERE w\.created_by = p\.user_id OR w\.ended_by = p\.user_id/.test(arm)) {
      problems363.push("0290's arm for a window's author is not every window: created_by or ended_by, with no condition on the caller");
    }
    const readme = supabaseReadme().match(/\n### An acknowledger is shown by name \(0290\)\n([\s\S]*?)(?=\n### )/)?.[1] ?? '';
    for (const name of ['platform_alerts_select_authenticated', 'alert_suppression_windows_select_authenticated']) {
      if (!readme.includes(name)) problems363.push(`the 0290 section of supabase/README.md does not name ${name}`);
    }
  }
  if (problems363.length) {
    fail(`display_names_for() and the read policies it follows disagree:\n${problems363.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass("display_names_for()'s arms for an alert's acknowledger and a window's author state the read policies of platform_alerts (0204) and alert_suppression_windows (0001)");
  }
}
