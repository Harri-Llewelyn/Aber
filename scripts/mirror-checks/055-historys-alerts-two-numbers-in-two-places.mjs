import { compare, lastDefinition, need, ok, problems, read, SCHEMA } from './lib.mjs';

// 55. History's alerts, two numbers in two places. The Alerts tab asks alert_occurrences() (0243)
// for ALERT_HISTORY_LIMIT and one more, which must fit under the function's bound, or every read is
// refused. Where alerts.retention_days cannot be read, the tab says alerts are kept for
// ALERT_RETENTION_DAYS, which must be the value 0002 seeds.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.alert_occurrences(', '$fn$;', 'alert_occurrences()');
  const limit = need(read('frontend/src/api.js'), /^export const ALERT_HISTORY_LIMIT = (\d+);$/m, 'ALERT_HISTORY_LIMIT in frontend/src/api.js');
  const days = need(read('frontend/src/utils/alertHistory.js'), /^export const ALERT_RETENTION_DAYS = (\d+)$/m,
    'ALERT_RETENTION_DAYS in frontend/src/utils/alertHistory.js');
  const seeded = need(SCHEMA, /seed_setting\(\s*'alerts\.retention_days',\s*to_jsonb\((\d+)\)/, "alerts.retention_days' seed in 0002");
  const bound = def && need(def.body, /c_max_rows CONSTANT integer := (\d+);/, `the row bound in ${def.file}`);
  if (limit && bound) {
    if (Number(limit[1]) + 1 > Number(bound[1])) {
      problems.push(`alertHistory: the Alerts tab asks for ${Number(limit[1]) + 1} rows, over alert_occurrences()'s bound (${bound[1]}), so every read is refused`);
    } else {
      ok.push(`alertHistory: the Alerts tab's ${Number(limit[1]) + 1} rows fit under alert_occurrences()'s bound (${bound[1]})`);
    }
  }
  if (days && seeded) compare('alertHistory', 'the days alerts are kept, as the tab falls back to and 0002 seeds', days[1], seeded[1]);
}
