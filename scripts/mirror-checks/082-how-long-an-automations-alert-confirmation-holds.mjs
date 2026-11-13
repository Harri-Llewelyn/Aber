import { lastDefinition, need, ok, problems, SCHEMA } from './lib.mjs';

// 82. How long an automation's alert confirmation holds (0247, 0271). evaluate_automations() stamps
// last_confirmed_at on every run, and pg_cron runs it on the schedule 0271 gives. The window
// platform_alert_confirmation_window() allows a condition: fingerprint must be longer than that
// interval: a window no longer than the run interval stops the reminders of every automation alert
// still firing, and a far longer one keeps reminding about an alert nothing has confirmed for hours.
export default function check() {
  const job = need(SCHEMA, /ensure_cron_job\(\s*'evaluate_automations',\s*'([^']+)'/, 'the evaluate_automations job in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const arm = fn && need(fn.body, /WHEN starts_with\(p_fingerprint, 'condition:'\) THEN interval '(\d+) minutes'/,
    `platform_alert_confirmation_window()'s condition: arm (${fn.file})`);
  if (job && arm) {
    // `* * * * *` is every minute and `*/N * * * *` every N; anything else is not read.
    const every = /^\* \* \* \* \*$/.test(job[1]) ? 1 : Number(job[1].match(/^\*\/(\d+) \* \* \* \*$/)?.[1]);
    if (!Number.isInteger(every) || every < 1) {
      problems.push(`alertConfirmationWindow: the evaluate_automations schedule "${job[1]}" is neither every minute nor every N minutes, so the window cannot be held to it`);
    } else if (Number(arm[1]) <= every) {
      problems.push(`alertConfirmationWindow: the evaluator runs every ${every} minute(s) and its confirmation holds ${arm[1]}, which stops the reminders of every automation alert still firing (${fn.file})`);
    } else {
      ok.push(`alertConfirmationWindow: an automation alert's confirmation (${arm[1]} minutes) outlasts the evaluator's interval (${every} minute${every === 1 ? '' : 's'})`);
    }
  }
}
