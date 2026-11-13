import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 89. History's Area read, the columns. telemetry_carried_by_group() returns the columns
// readCarriedByGroup() documents, and the page reads no column it does not return: groupSeries() takes
// bucket_ts, mean_double, total_double and measured, and the Area tab files a row by group_key. A column
// the page reads and the function does not return is a chart of nothing, and a column documented and not
// returned sends a reader looking for it.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried_by_group(', '$fn$;', 'telemetry_carried_by_group()');
  const api = read('frontend/src/api.js');
  const doc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readCarriedByGroup: async/, "readCarriedByGroup()'s @returns in frontend/src/api.js");
  const series = need(read('frontend/src/utils/history.js'), /export function groupSeries\(([\s\S]*?)\n\}\n/, 'groupSeries() in frontend/src/utils/history.js');
  const area = read('frontend/src/components/tabs/HistoryArea.jsx');
  if (def && doc && series) {
    const args = need(def.body, /telemetry_carried_by_group\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (args) {
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort();
      const columns = names(args[2], /^\s*(\w+) [a-z]/gm);
      compare('groupColumns', 'the columns readCarriedByGroup() documents and telemetry_carried_by_group() returns',
        names(doc[1], /(\w+): /g).join(', '), columns.join(', '));
      const read = new Set([...series[1].matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
      for (const m of area.matchAll(/\brow\.(group_key)\b/g)) read.add(m[1]);
      const missing = [...read].filter((c) => !columns.includes(c));
      if (missing.length) problems.push(`groupColumns: the Area tab reads ${missing.join(', ')}, which telemetry_carried_by_group() does not return`);
      else ok.push(`groupColumns: the columns the Area tab reads, ${[...read].sort().join(', ')}, are ones telemetry_carried_by_group() returns`);
    }
  }
}
