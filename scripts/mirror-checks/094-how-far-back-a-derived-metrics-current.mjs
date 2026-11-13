import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, problems, ROOT } from './lib.mjs';

// 94. How far back a derived metric's current value looks, SQL and JavaScript (0282).
// derived_window_minutes() is the one place the rule is written: an hour for a counter rate and a
// time in state, none for a sum, which is its value at the last whole minute. The Devices drawer words
// it (currentWords()) from derivedWindowMinutes(). A window the drawer says and the evaluator does not
// read is a value on the page that is not the one in the alert. Compared kind by kind.
export default async function check() {
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.derived_window_minutes(', '$$;', 'derived_window_minutes()');
  const { derivedWindowMinutes } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/derivedMetric.js')).href);
  if (fn) {
    const sql = [...fn.body.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map((m) => [m[1], Number(m[2])]);
    if (sql.length === 0) problems.push('derivedWindow: could not find the kinds in derived_window_minutes() -- the file\'s shape changed');
    for (const [kind, minutes] of sql) {
      compare('derivedWindow', `the window of a ${kind} in the dashboard and in derived_window_minutes() (${fn.file})`, derivedWindowMinutes({ kind }), minutes);
    }
    compare('derivedWindow', 'the kinds that have a window, in the dashboard and in derived_window_minutes()',
      ['counter_rate', 'time_in_state', 'sum'].filter((k) => derivedWindowMinutes({ kind: k }) !== null).sort().join(', '),
      sql.map(([k]) => k).sort().join(', '));
  }
}
