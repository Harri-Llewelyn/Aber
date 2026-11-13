import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 40. A read of a service's logs, one rule in three places. service-logs (logs.ts) refuses a level,
// a range, a filter or a fixed window outside its rule, 0225's record_service_logs_read() refuses
// the same, and System › Logs (utils/serviceLogs.js) offers them. A value the page offers and the
// function refuses is a picker that fails; one the function reads and 0225 refuses is a read never
// shown, since no line is released unrecorded. The tab's spans must fit the widest window, and the
// arguments the function names in its call must be the ones 0225 declares, or every read is a 503.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.record_service_logs_read(', '$$;',
    'record_service_logs_read()');
  const ts = read('supabase/functions/service-logs/logs.ts');
  const js = read('frontend/src/utils/serviceLogs.js');
  const quoted = (text) => [...(text || '').matchAll(/'([^']*)'/g)].map((m) => m[1]).join(', ');
  const tsLevels = need(ts, /export const LEVELS = \[([^\]]*)\]/, 'LEVELS in service-logs/logs.ts');
  const tsRanges = need(ts, /export const RANGES[^=]*= \{([^}]*)\}/, 'RANGES in service-logs/logs.ts');
  const tsFilter = need(ts, /export const FILTER_MAX = (\d+)/, 'FILTER_MAX in service-logs/logs.ts');
  const tsService = need(ts, /export const SERVICE_MAX = (\d+)/, 'SERVICE_MAX in service-logs/logs.ts');
  const tsLines = need(ts, /export const MAX_LINES = (\d+)/, 'MAX_LINES in service-logs/logs.ts');
  const tsWindow = need(ts, /export const LONGEST_WINDOW_HOURS = (\d+)/, 'LONGEST_WINDOW_HOURS in service-logs/logs.ts');
  const tsCall = need(ts, /caller\.rpc\("record_service_logs_read", \{([\s\S]*?)\n {4}\}\);/,
    "service-logs/logs.ts's call to record_service_logs_read()");
  const jsLevels = need(js, /export const LOG_LEVELS = \[([\s\S]*?)\n\]/, 'LOG_LEVELS in frontend/src/utils/serviceLogs.js');
  const jsRanges = need(js, /export const LOG_RANGES = \[([\s\S]*?)\n\]/, 'LOG_RANGES in frontend/src/utils/serviceLogs.js');
  const jsFilter = need(js, /export const LOG_FILTER_MAX = (\d+)/, 'LOG_FILTER_MAX in frontend/src/utils/serviceLogs.js');
  const jsLines = need(js, /export const LOG_LINES_MAX = (\d+)/, 'LOG_LINES_MAX in frontend/src/utils/serviceLogs.js');
  const jsSpans = need(js, /export const LOG_SPANS = \[([^\]]*)\]/, 'LOG_SPANS in frontend/src/utils/serviceLogs.js');
  if (def && tsWindow && tsCall && jsSpans) {
    const sqlWindow = need(def.body, /p_to - p_from > interval '(\d+) hours'/, `the widest window in ${def.file}`);
    const sqlArgs = need(def.body, /record_service_logs_read\(([\s\S]*?)\)\s+RETURNS/, `the arguments ${def.file} declares`);
    if (sqlWindow) compare('serviceLogsRead', 'the widest fixed window, in hours, in the function and 0225', tsWindow[1], sqlWindow[1]);
    if (sqlArgs) {
      const declared = [...sqlArgs[1].matchAll(/\b(p_[a-z]+) /g)].map((m) => m[1]).join(', ');
      const sent = [...new Set([...tsCall[1].matchAll(/\b(p_[a-z]+):/g)].map((m) => m[1]))].join(', ');
      compare('serviceLogsRead', 'the arguments the function sends and 0225 declares', sent, declared);
    }
    // A span's longest length in hours: a day and a week an hour longer when the clocks go back.
    const LONGEST_SPAN_HOURS = { day: 25, week: 7 * 24 + 1, month: 31 * 24 + 1, year: 366 * 24 + 1 };
    const spans = [...jsSpans[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const over = spans.filter((sp) => !(LONGEST_SPAN_HOURS[sp] <= Number(tsWindow[1])));
    if (spans.length === 0) {
      problems.push('serviceLogsRead: found no span in LOG_SPANS -- its shape changed, so this check is no longer checking anything');
    } else if (over.length) {
      problems.push(`serviceLogsRead: System › Logs offers ${over.join(', ')}, which can be longer than the ${tsWindow[1]} hours service-logs reads`);
    } else {
      ok.push(`serviceLogsRead: the spans System › Logs offers (${spans.join(', ')}) fit ${tsWindow[1]} hours`);
    }
  }
  if (def && tsLevels && tsRanges && tsFilter && tsService && tsLines && jsLevels && jsRanges && jsFilter && jsLines) {
    const sqlLevels = need(def.body, /p_level = ANY \(ARRAY\[([^\]]*)\]\)/, `the levels record_service_logs_read() takes (${def.file})`);
    const sqlRanges = need(def.body, /p_range = ANY \(ARRAY\[([^\]]*)\]\)/, `the ranges record_service_logs_read() takes (${def.file})`);
    const sqlFilter = need(def.body, /char_length\(coalesce\(p_filter, ''\)\) > (\d+)/, `the filter's limit in ${def.file}`);
    const sqlService = need(def.body, /char_length\(p_service\) NOT BETWEEN 1 AND (\d+)/, `the service's limit in ${def.file}`);
    const values = (text) => [...text.matchAll(/value: '([^']*)'/g)].map((m) => m[1]).join(', ');
    const tsRangeKeys = [...tsRanges[1].matchAll(/"([^"]+)":/g)].map((m) => m[1]).join(', ');
    const tsLevelList = [...tsLevels[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(', ');
    if (sqlLevels && sqlRanges && sqlFilter && sqlService) {
      compare('serviceLogsRead', 'the levels the function takes and 0225 records', tsLevelList, quoted(sqlLevels[1]));
      compare('serviceLogsRead', 'the levels System › Logs offers and 0225 records', values(jsLevels[1]), quoted(sqlLevels[1]));
      compare('serviceLogsRead', 'the ranges the function takes and 0225 records', tsRangeKeys, quoted(sqlRanges[1]));
      compare('serviceLogsRead', 'the ranges System › Logs offers and 0225 records', values(jsRanges[1]), quoted(sqlRanges[1]));
      compare('serviceLogsRead', "the filter's limit in the function and 0225", tsFilter[1], sqlFilter[1]);
      compare('serviceLogsRead', "the filter's limit in System › Logs and 0225", jsFilter[1], sqlFilter[1]);
      compare('serviceLogsRead', "a service name's limit in the function and 0225", tsService[1], sqlService[1]);
    }
    compare('serviceLogsRead', 'the most lines a read returns, which System › Logs asks for', jsLines[1], tsLines[1]);
  }
}
