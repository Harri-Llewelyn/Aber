import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastDefinition, ok, problems, ROOT } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 104. The database says a unit as the dashboard does. unit_symbol() holds the pairs of UNIT_SYMBOLS
// (utils/units.js), and with_unit() sets a % or a ° against the number as withUnit() does, so an
// automation's alert reads "82.4 °C" where History does. A code only one side has, a symbol the two
// spell differently, or a symbol only one side sets against the number, is an alert that says what
// the dashboard does not.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const units = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/units.js')).href);
  const symbol = lastDefinition('CREATE OR REPLACE FUNCTION public.unit_symbol(', '$$;', 'public.unit_symbol()');
  const words = lastDefinition('CREATE OR REPLACE FUNCTION public.with_unit(', '$$;', 'public.with_unit()');
  if (!symbol || !words) return;
  const sql = new Map([...symbol.body.matchAll(/WHEN '((?:[^']|'')+)'\s+THEN '((?:[^']|'')+)'/g)]
    .map((m) => [m[1].replaceAll("''", "'"), m[2].replaceAll("''", "'")]));
  if (sql.size === 0) {
    problems.push(`unitWords: found no WHEN ... THEN pair in unit_symbol() (${symbol.file}) -- its shape changed, so this check is no longer checking anything`);
    return;
  }
  const js = new Map(Object.entries(units.UNIT_SYMBOLS));
  const onlyJs = [...js.keys()].filter((code) => !sql.has(code));
  const onlySql = [...sql.keys()].filter((code) => !js.has(code));
  const differ = [...js.keys()].filter((code) => sql.has(code) && sql.get(code) !== js.get(code))
    .map((code) => `${code} is ${JSON.stringify(js.get(code))} in units.js and ${JSON.stringify(sql.get(code))} in unit_symbol()`);
  if (onlyJs.length) problems.push(`unitWords: units.js gives ${onlyJs.join(', ')} a symbol and unit_symbol() (${symbol.file}) gives it none`);
  if (onlySql.length) problems.push(`unitWords: unit_symbol() (${symbol.file}) gives ${onlySql.join(', ')} a symbol and units.js gives it none`);
  if (differ.length) problems.push(`unitWords: the symbols differ: ${differ.join('; ')}`);

  // The symbols withUnit() sets against the number, from the map, and the ones with_unit() does.
  const jsSticks = new Set([...js].filter(([code]) => units.unitSticks(code)).map(([, s]) => s));
  const sqlSticks = new Set([...(words.body.match(/IN \(((?:'[^']*',? ?)+)\) THEN/)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]));
  if (sqlSticks.size === 0) problems.push(`unitWords: found no symbol that with_unit() (${words.file}) sets against the number -- its shape changed, so this check is no longer checking anything`);
  const sticks = (set) => [...set].sort().join(' ');
  if (sticks(jsSticks) !== sticks(sqlSticks)) {
    problems.push(`unitWords: withUnit() sets ${JSON.stringify(sticks(jsSticks))} against the number, with_unit() sets ${JSON.stringify(sticks(sqlSticks))}`);
  }
  if (!onlyJs.length && !onlySql.length && !differ.length && sticks(jsSticks) === sticks(sqlSticks)) {
    ok.push(`unitWords: unit_symbol() holds the ${js.size} pairs of UNIT_SYMBOLS, and with_unit() sets ${sticks(sqlSticks)} against the number as withUnit() does`);
  }
}
