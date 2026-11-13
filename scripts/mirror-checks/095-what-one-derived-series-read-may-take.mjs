import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 95. What one derived_series() read may take, SQL and JavaScript (0282). The function refuses more
// than c_max_rows devices times metrics times buckets, more than c_max_minutes minutes of input, and a
// bucket over c_max_bucket minutes; the page checks the same arithmetic before it asks
// (DERIVED_MAX_ROWS, DERIVED_MAX_MINUTES, derivedReadProblem()), and the rows are the page's own row
// cap, TELEMETRY_MAX_ROWS. A bound the page holds and the function does not is a read the function
// refuses; a bucket History offers that the function refuses is a chart of nothing.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.derived_series(', '$fn$;', 'derived_series()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const api = read('frontend/src/api.js');
  const rowsJs = need(js, /export const DERIVED_MAX_ROWS = (\d+)/, 'DERIVED_MAX_ROWS in utils/derivedMetric.js');
  const minutesJs = need(js, /export const DERIVED_MAX_MINUTES = (\d+)/, 'DERIVED_MAX_MINUTES in utils/derivedMetric.js');
  const bucketJs = need(js, /export const DERIVED_MAX_BUCKET_MINUTES = (\d+)/, 'DERIVED_MAX_BUCKET_MINUTES in utils/derivedMetric.js');
  const cap = need(api, /^const TELEMETRY_MAX_ROWS = (\d+);$/m, 'TELEMETRY_MAX_ROWS in frontend/src/api.js');
  const widths = need(api, /export const HISTORY_RESOLUTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/, 'HISTORY_RESOLUTIONS in frontend/src/api.js');
  if (def && rowsJs && minutesJs && bucketJs && cap && widths) {
    const rowsSql = need(def.body, /c_max_rows\s+CONSTANT bigint := (\d+);/, `derived_series()'s row bound (${def.file})`);
    const minutesSql = need(def.body, /c_max_minutes CONSTANT bigint := (\d+);/, `derived_series()'s minutes bound (${def.file})`);
    const bucketSql = need(def.body, /c_max_bucket\s+CONSTANT integer := (\d+);/, `derived_series()'s widest bucket (${def.file})`);
    if (rowsSql && minutesSql && bucketSql) {
      compare('derivedRead', 'the rows one derived_series() call may return, in the dashboard and in the function', rowsJs[1], rowsSql[1]);
      compare('derivedRead', "the rows one derived_series() call may return and the page's row cap, TELEMETRY_MAX_ROWS", rowsJs[1], cap[1]);
      compare('derivedRead', 'the minutes of input one derived_series() call may read, in the dashboard and in the function', minutesJs[1], minutesSql[1]);
      compare('derivedRead', 'the widest bucket derived_series() takes, in minutes, in the dashboard and in the function', bucketJs[1], bucketSql[1]);
      const wide = [...widths[1].matchAll(/minutes: (?:TELEMETRY_RESOLUTIONS\['\w+'\]\.bucketMinutes|(\d+))/g)].map((m) => m[1]).filter(Boolean).map(Number);
      const refused = wide.filter((minutes) => minutes > Number(bucketSql[1]));
      if (refused.length) problems.push(`derivedRead: History offers ${refused.join(', ')}-minute buckets, which derived_series() refuses`);
      else ok.push(`derivedRead: derived_series() takes each of History's literal bucket widths (${wide.join(', ')} minutes) and the rollups'`);
    }
  }
}
