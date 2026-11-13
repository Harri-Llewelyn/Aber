import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 215. The reasons for acknowledging an alert are named alike in the help and the API reference.
// ALERT_ACKNOWLEDGEMENT_REASONS (utils/alertAcknowledgement.js) is the dialog's list, which mirror
// check 45 holds to the database. The Site Map help's steps name each label in bold, and
// docs/openapi.yaml gives acknowledge_alert's p_reason and DeviceAlert's acknowledgement_reason
// the values. The note's limit is stated alike in the util, the CHECK and the reference.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const UTIL = 'frontend/src/utils/alertAcknowledgement.js';
  const HELP = 'help/pages/site-map.md';
  const SPEC = 'docs/openapi.yaml';
  const util = read(UTIL);
  const spec = read(SPEC);
  const problems215 = [];
  const reasons = [...(util.match(/export const ALERT_ACKNOWLEDGEMENT_REASONS = \[([\s\S]*?)\n\]/)?.[1] ?? '')
    .matchAll(/value: '([a-z_]+)', label: '([^']+)'/g)].map((m) => ({ value: m[1], label: m[2] }));
  if (!reasons.length) problems215.push(`${UTIL}: could not read ALERT_ACKNOWLEDGEMENT_REASONS`);
  const help = read(HELP);
  const step = help.split('\n').find((l) => /^\d+\. Choose a reason: /.test(l)) ?? '';
  if (!step) problems215.push(`${HELP}: no "Choose a reason" step`);
  for (const r of reasons) {
    if (step && !step.includes(`**${r.label}**`)) problems215.push(`${HELP}: the reasons step does not name **${r.label}**`);
  }
  const values = reasons.map((r) => r.value).join(', ');
  const entry = spec.slice(spec.indexOf('\n  /rest/v1/rpc/acknowledge_alert:'), spec.indexOf('\n  /rest/v1/rpc/withdraw_alert_acknowledgement:'));
  if (!entry.includes(`p_reason: { type: string, enum: [${values}] }`)) {
    problems215.push(`${SPEC}: acknowledge_alert's p_reason does not list ${values}`);
  }
  const schema = spec.match(/^ {4}DeviceAlert:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  if (!schema.includes(`enum: [${values}]`)) problems215.push(`${SPEC}: DeviceAlert's acknowledgement_reason does not list ${values}`);
  const max = util.match(/export const ALERT_ACKNOWLEDGEMENT_NOTE_MAX = (\d+)/)?.[1];
  const sql = read('supabase/migrations/0231_a_person_acknowledges_an_alert.sql');
  if (!max || !sql.includes(`(char_length(acknowledgement_note) <= ${max})`) || !entry.includes(`maxLength: ${max}`)) {
    problems215.push(`the note's limit (${max ?? 'unread'} in ${UTIL}) is not the CHECK's and the API reference's`);
  }
  if (problems215.length) {
    fail('the reasons for acknowledging an alert are named otherwise than the dialog lists them:\n' +
      problems215.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help and the API reference name the ${reasons.length} reasons for acknowledging an alert, and the note's limit of ${max}, as the dialog does`);
  }
}
