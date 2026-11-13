import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 91. The longest export, one default and one range in four places: 0278's seed and bounds,
// telemetry_export_max_days(), which falls back to the default outside the range, and the dashboard,
// which does the same where the setting cannot be read. Its place, the History category of Settings,
// is named by 0278's seed, the function's refusal, the dashboard and the Settings page's tabs; a
// dashboard that offers an end the function refuses, or names another tab, sends people wrong.
export default function check() {
  const seed = need(SCHEMA, /seed_setting\(\s*'history\.export_max_days',\s*to_jsonb\((\d+)\),\s*'number',\s*'([^']+)'/,
    "history.export_max_days' seed in 0278");
  const bounds = need(SCHEMA, /SET min_value = (\d+), max_value = (\d+)\s+WHERE key = 'history\.export_max_days'/,
    "history.export_max_days' bounds in 0278");
  const reader = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_export_max_days(', '$$;', 'telemetry_export_max_days()');
  const fallback = reader && need(reader.body, /IF v_days IS NULL OR v_days < (\d+) OR v_days > (\d+) THEN\s+v_days := (\d+);/,
    `telemetry_export_max_days()'s fallback (${reader.file})`);
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.export_telemetry(', '$fn$;', 'export_telemetry()');
  const refused = fn && need(fn.body, /set on Settings › ([^.']+)\./, `the tab export_telemetry()'s refusal names (${fn.file})`);
  const js = read('frontend/src/utils/telemetryExport.js');
  const jsDays = need(js, /export const EXPORT_MAX_DAYS = (\d+)$/m, 'EXPORT_MAX_DAYS in utils/telemetryExport.js');
  const jsMin = need(js, /export const EXPORT_MAX_DAYS_MIN = (\d+)$/m, 'EXPORT_MAX_DAYS_MIN in utils/telemetryExport.js');
  const jsMax = need(js, /export const EXPORT_MAX_DAYS_MAX = (\d+)$/m, 'EXPORT_MAX_DAYS_MAX in utils/telemetryExport.js');
  const jsKey = need(js, /export const EXPORT_MAX_DAYS_KEY = '([^']+)'/, 'EXPORT_MAX_DAYS_KEY in utils/telemetryExport.js');
  const jsPlace = need(js, /export const EXPORT_MAX_DAYS_PLACE = 'Settings › ([^']+)'/, 'EXPORT_MAX_DAYS_PLACE in utils/telemetryExport.js');
  const tab = need(read('frontend/src/navigation.jsx'), /\{ id: 'history', label: '([^']+)', description: /, "the History entry of SETTINGS_TABS in navigation.jsx");
  if (jsKey) compare('exportMaxDays', "the setting the dashboard reads and 0278 declares", jsKey[1], 'history.export_max_days');
  if (seed && jsDays) compare('exportMaxDays', 'the longest export the dashboard falls back to and 0278 seeds', jsDays[1], seed[1]);
  if (fallback && jsDays) compare('exportMaxDays', `the longest export the dashboard and telemetry_export_max_days() (${reader.file}) fall back to`, jsDays[1], fallback[3]);
  if (bounds && jsMin && jsMax) compare('exportMaxDays', "the setting's range in the dashboard and 0278's bounds", `${jsMin[1]} to ${jsMax[1]}`, `${bounds[1]} to ${bounds[2]}`);
  if (fallback && jsMin && jsMax) compare('exportMaxDays', `the setting's range in the dashboard and the reader's fallback (${reader.file})`, `${jsMin[1]} to ${jsMax[1]}`, `${fallback[1]} to ${fallback[2]}`);
  if (seed && jsPlace) compare('exportMaxDaysPlace', "the Settings tab the dashboard names and 0278's category", jsPlace[1], seed[2]);
  if (seed && refused) compare('exportMaxDaysPlace', `the Settings tab export_telemetry()'s refusal names (${fn.file}) and 0278's category`, refused[1], seed[2]);
  if (seed && tab) compare('exportMaxDaysPlace', "the Settings tab navigation.jsx lists and 0278's category", tab[1], seed[2]);
}
