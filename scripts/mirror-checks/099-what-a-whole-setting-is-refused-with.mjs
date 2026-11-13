import { compare, lastDefinition, need, ok, problems, read, SCHEMA } from './lib.mjs';

// 99. What a whole setting is refused with, and what it can hold. The page's sentence ("Must be a
// whole number.") is the database guard's ("<key> must be a whole number"); the guard names hours,
// days or seconds by the key's last word, and each key 0285 flags ends in one of the three or is the
// proposal cap, which has none. The seed and the bounds of each such setting are whole numbers, and so
// are the dashboard's fallbacks for the ones it keeps, or a setting would fall back to a value its
// own guard refuses.
export default function check() {
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.system_settings_whole_number_guard(', '$$;',
    'system_settings_whole_number_guard()');
  const refusal = guard && need(guard.body, /RAISE EXCEPTION '% (must be a whole number)%'/, `the guard's sentence (${guard.file})`);
  const page = need(read('frontend/src/components/tabs/SettingsTab.jsx'), /throw new Error\('(Must be a whole number)\.'\)/,
    "coerceValue()'s sentence in SettingsTab.jsx");
  if (refusal && page) compare('wholeNumber', "the sentence the page refuses a part number with and the guard's", page[1].toLowerCase(), refusal[1]);

  const keys = [...(need(SCHEMA, /v_whole text\[\] := ARRAY\[([^\]]*)\]/, "the settings 0285 flags whole")?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const units = guard ? [...guard.body.matchAll(/WHEN NEW\.key ~ '_(\w+)\$' THEN ' of (\w+)'/g)].map((m) => [m[1], m[2]]) : [];
  if (guard) {
    for (const [suffix, word] of units) if (suffix !== word) problems.push(`wholeNumber: the guard says "of ${word}" for keys ending _${suffix}`);
    ok.push(`wholeNumber: the guard names ${units.map(([s]) => s).sort().join(', ')} by a key's last word`);
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = 'proposals.max_open_per_person';
  for (const key of keys) {
    const last = key.split('.')[1].split('_').pop();
    if (key !== cap && !units.some(([suffix]) => suffix === last)) {
      problems.push(`wholeNumber: ${key} is flagged whole and its last word "${last}" is none the guard names, so its refusal names no unit`);
    }
    const seed = SCHEMA.match(new RegExp(`seed_setting\\(\\s*'${escape(key)}',\\s*to_jsonb\\(([0-9.]+)\\)`));
    const bounds = SCHEMA.match(new RegExp(`SET min_value = ([0-9.]+), max_value = ([0-9.]+)\\s+WHERE key = '${escape(key)}'`));
    if (!seed) problems.push(`wholeNumber: could not find ${key}' seed in the applied chain -- the file's shape changed, so this check is no longer checking it`);
    else if (!Number.isInteger(Number(seed[1]))) problems.push(`wholeNumber: ${key} is flagged whole and is seeded ${seed[1]}`);
    if (bounds && !(Number.isInteger(Number(bounds[1])) && Number.isInteger(Number(bounds[2])))) {
      problems.push(`wholeNumber: ${key} is flagged whole and its bounds are ${bounds[1]} to ${bounds[2]}`);
    }
  }
  const fallbacks = [
    ['frontend/src/utils/alertSuppression.js', ['SUPPRESSION_MAX_DAYS', 'SUPPRESSION_MAX_DAYS_MIN', 'SUPPRESSION_MAX_DAYS_MAX']],
    ['frontend/src/utils/telemetryExport.js', ['EXPORT_MAX_DAYS', 'EXPORT_MAX_DAYS_MIN', 'EXPORT_MAX_DAYS_MAX']],
    ['frontend/src/utils/alertHistory.js', ['ALERT_RETENTION_DAYS']],
    ['frontend/src/components/tabs/AuditTrailTab.jsx', ['DEFAULT_POLL_SECONDS']],
  ];
  let held = 0;
  for (const [file, names] of fallbacks) {
    const src = read(file);
    for (const name of names) {
      const value = need(src, new RegExp(`const ${escape(name)} = ([0-9.]+)$`, 'm'), `${name} in ${file}`);
      if (!value) continue;
      held += 1;
      if (!Number.isInteger(Number(value[1]))) problems.push(`wholeNumber: ${name} in ${file} is ${value[1]}, a fallback for a setting the database holds to whole numbers`);
    }
  }
  if (keys.length) ok.push(`wholeNumber: ${keys.length} settings flagged whole are seeded and bounded by whole numbers, and ${held} dashboard fallbacks for them are whole`);
}
