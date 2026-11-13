import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 62. The longest suppression window, one default and one range in three places: 0002's seed and
// bounds, the writers' check, which falls back to the default outside the range, and the dialog,
// which does the same where the setting cannot be read. A dialog with another default offers an
// end the writers refuse, or refuses one they would keep.
export default function check() {
  const seed = need(SCHEMA, /seed_setting\(\s*'alerts\.suppression_max_days',\s*to_jsonb\((\d+)\)/,
    "alerts.suppression_max_days' seed in 0002");
  const bounds = need(SCHEMA, /SET min_value = (\d+), max_value = (\d+)\s+WHERE key = 'alerts\.suppression_max_days'/,
    "alerts.suppression_max_days' bounds in 0002");
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(', '$$;',
    'check_alert_suppression_window_length()');
  const fallback = fn && need(fn.body, /IF v_days IS NULL OR v_days < (\d+) OR v_days > (\d+) THEN\s+v_days := (\d+);/,
    `check_alert_suppression_window_length()'s fallback (${fn.file})`);
  const js = read('frontend/src/utils/alertSuppression.js');
  const jsDays = need(js, /export const SUPPRESSION_MAX_DAYS = (\d+)$/m, 'SUPPRESSION_MAX_DAYS in utils/alertSuppression.js');
  const jsMin = need(js, /export const SUPPRESSION_MAX_DAYS_MIN = (\d+)$/m, 'SUPPRESSION_MAX_DAYS_MIN in utils/alertSuppression.js');
  const jsMax = need(js, /export const SUPPRESSION_MAX_DAYS_MAX = (\d+)$/m, 'SUPPRESSION_MAX_DAYS_MAX in utils/alertSuppression.js');
  if (seed && jsDays) compare('suppressionMaxDays', 'the longest window the dialog falls back to and 0002 seeds', jsDays[1], seed[1]);
  if (fallback && jsDays) compare('suppressionMaxDays', `the longest window the dialog and the writers' check (${fn.file}) fall back to`, jsDays[1], fallback[3]);
  if (bounds && jsMin && jsMax) compare('suppressionMaxDays', "the setting's range in the dialog and 0002's bounds", `${jsMin[1]} to ${jsMax[1]}`, `${bounds[1]} to ${bounds[2]}`);
  if (fallback && jsMin && jsMax) compare('suppressionMaxDays', `the setting's range in the dialog and the writers' check (${fn.file})`, `${jsMin[1]} to ${jsMax[1]}`, `${fallback[1]} to ${fallback[2]}`);
}
