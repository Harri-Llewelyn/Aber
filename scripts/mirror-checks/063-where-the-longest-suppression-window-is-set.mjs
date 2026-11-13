import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 63. Where the longest suppression window is set, named in two places as 0002 files it: the
// writers' refusal and the hint under the dialog's end field. A key moved to another category
// leaves both pointing at a tab that no longer holds it.
export default function check() {
  const seeded = need(SCHEMA, /seed_setting\(\s*'alerts\.suppression_max_days',\s*to_jsonb\(\d+\),\s*'number',\s*'([^']+)'/,
    "alerts.suppression_max_days' category in 0002");
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(', '$$;',
    'check_alert_suppression_window_length()');
  const refused = fn && need(fn.body, /set on Settings › ([^.']+)\./, `the tab check_alert_suppression_window_length()'s sentence names (${fn.file})`);
  const js = need(read('frontend/src/utils/alertSuppression.js'), /export const SUPPRESSION_MAX_DAYS_PLACE = 'Settings › ([^']+)'/,
    'SUPPRESSION_MAX_DAYS_PLACE in utils/alertSuppression.js');
  if (seeded && js) compare('suppressionMaxDaysPlace', "the Settings tab the dialog names and 0002's category", js[1], seeded[1]);
  if (seeded && refused) compare('suppressionMaxDaysPlace', `the Settings tab the writers' refusal names (${fn.file}) and 0002's category`, refused[1], seeded[1]);
}
