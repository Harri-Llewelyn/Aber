import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 96. What History reads of a derived metric, SQL and JavaScript (0282). derived_series() takes the
// arguments readDerivedSeries() sends and returns the columns it documents and chartSeries() reads;
// derived_current() takes what readDerivedCurrent() sends and returns what the Devices drawer reads. A
// column the page reads and the function does not return is a chart or a line of nothing; an argument
// one side names is a read that fails.
export default function check() {
  const series = lastDefinition('CREATE OR REPLACE FUNCTION public.derived_series(', '$fn$;', 'derived_series()');
  const current = lastDefinition('CREATE OR REPLACE FUNCTION public.derived_current(', '$fn$;', 'derived_current()');
  const api = read('frontend/src/api.js');
  const chart = need(read('frontend/src/utils/history.js'), /export function chartSeries\(([\s\S]*?)\n\}\n/, 'chartSeries() in frontend/src/utils/history.js');
  const drawer = read('frontend/src/components/common/DeviceDerivedValues.jsx');
  const seriesCall = need(api, /supabase\.rpc\('derived_series', \{([\s\S]*?)\n\s*\}\)/, "readDerivedSeries()'s rpc call in frontend/src/api.js");
  const currentCall = need(api, /supabase\.rpc\('derived_current', \{([\s\S]*?)\n\s*\}\)/, "readDerivedCurrent()'s rpc call in frontend/src/api.js");
  const seriesDoc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readDerivedSeries: async/, "readDerivedSeries()'s @returns in frontend/src/api.js");
  const currentDoc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readDerivedCurrent: async/, "readDerivedCurrent()'s @returns in frontend/src/api.js");
  const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort();
  if (series && current && seriesCall && currentCall && seriesDoc && currentDoc) {
    const sq = need(series.body, /derived_series\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${series.file}`);
    const cq = need(current.body, /derived_current\(([^)]*)\)\s*RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${current.file}`);
    if (sq && cq) {
      compare('derivedColumns', 'the arguments readDerivedSeries() sends and derived_series() takes',
        names(seriesCall[1], /^\s*(\w+):/gm).join(', '), names(sq[1], /^\s*(\w+) [a-z]/gm).join(', '));
      compare('derivedColumns', 'the arguments readDerivedCurrent() sends and derived_current() takes',
        names(currentCall[1], /^\s*(\w+):/gm).join(', '), names(cq[1], /(\w+) text\[\]/g).join(', '));
      const seriesColumns = names(sq[2], /^\s*(\w+) [a-z]/gm);
      const currentColumns = names(cq[2], /^\s*(\w+) [a-z]/gm);
      compare('derivedColumns', 'the columns readDerivedSeries() documents and derived_series() returns', names(seriesDoc[1], /(\w+): /g).join(', '), seriesColumns.join(', '));
      compare('derivedColumns', 'the columns readDerivedCurrent() documents and derived_current() returns', names(currentDoc[1], /(\w+): /g).join(', '), currentColumns.join(', '));
      // The columns the chart reads of any row it is given, and those a row of derived_series() lacks by design.
      const read = new Set([...chart[1].matchAll(/\br\.(\w+)/g)].map((m) => m[1]));
      const lacks = ['last_string', 'last_bool'];
      const missing = [...read].filter((c) => !seriesColumns.includes(c) && !lacks.includes(c));
      if (missing.length) problems.push(`derivedColumns: chartSeries() reads ${missing.join(', ')}, which derived_series() does not return`);
      else ok.push(`derivedColumns: chartSeries() reads ${[...read].sort().join(', ')}; derived_series() returns all but ${lacks.join(' and ')}, which a number has none of`);
      const drawn = new Set([...drawer.matchAll(/\brow\.(\w+)/g)].map((m) => m[1]));
      const absent = [...drawn].filter((c) => !currentColumns.includes(c));
      if (absent.length) problems.push(`derivedColumns: the Devices drawer reads ${absent.join(', ')}, which derived_current() does not return`);
      else ok.push(`derivedColumns: the Devices drawer reads ${[...drawn].sort().join(', ')}, which derived_current() returns`);
    }
  }
}
