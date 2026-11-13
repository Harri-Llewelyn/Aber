import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 54. A suppression window's reason, one limit in three places (0240): the CHECK, the writers'
// refusal and the dialog's field. A dialog that takes more is refused on save; one that takes less
// cuts a reason the database would keep.
export default function check() {
  const check = need(SCHEMA, /ADD CONSTRAINT alert_suppression_windows_reason_valid CHECK \(\(\(char_length\(reason\) >= 1\) AND \(char_length\(reason\) <= (\d+)\)/,
    'alert_suppression_windows_reason_valid in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.schedule_alert_suppression_window(', '$$;',
    'schedule_alert_suppression_window()');
  const refused = fn && need(fn.body, /char_length\(v_reason\) > (\d+) THEN/, `schedule_alert_suppression_window()'s limit (${fn.file})`);
  const js = need(read('frontend/src/utils/alertSuppression.js'), /export const SUPPRESSION_REASON_MAX = (\d+)/,
    'SUPPRESSION_REASON_MAX in utils/alertSuppression.js');
  if (check && js) compare('suppressionReasonMax', "the reason's limit in the CHECK and the dialog", js[1], check[1]);
  if (refused && js) compare('suppressionReasonMax', `the reason's limit schedule_alert_suppression_window() refuses past (${fn.file}) and the dialog`, js[1], refused[1]);
}
