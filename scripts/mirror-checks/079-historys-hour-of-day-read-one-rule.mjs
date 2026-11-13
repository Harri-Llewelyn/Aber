import { compare, lastDefinition, need, read } from './lib.mjs';

// 79. History's hour-of-day read, one rule in two places. telemetry_hour_of_day() (0265) refuses
// more hours times devices than telemetry_carried() takes, which it reads at one hour, and api.js
// states the same bound for the Cell tab, which checks it before it asks and says the longest window
// it allows. It returns the columns the page's hourGrid() reads, and takes the arguments
// readHourOfDay() sends. A bound the page holds and the function does not is a heatmap the page
// offers and the function refuses; a column or an argument one side names is a heatmap that draws
// nothing.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_hour_of_day(', '$fn$;', 'telemetry_hour_of_day()');
  const carried = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const bound = need(api, /^export const HOUR_OF_DAY_MAX_ROWS = (\d+);$/m, 'HOUR_OF_DAY_MAX_ROWS in frontend/src/api.js');
  const call = need(api, /supabase\.rpc\('telemetry_hour_of_day', \{([^}]*)\}\)/, "readHourOfDay()'s rpc call in frontend/src/api.js");
  const doc = need(api, /@returns \{Promise<Array<\{([^}]*)\}>>\}\s*\*\/\s*readHourOfDay: async/, "readHourOfDay()'s @returns in frontend/src/api.js");
  if (def && carried && bound && call && doc) {
    const sqlBound = need(def.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${def.file}`);
    const carriedBound = need(carried.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${carried.file}`);
    const args = need(def.body, /telemetry_hour_of_day\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (sqlBound && carriedBound && args) {
      compare('hourOfDayRead', 'the rows one read may take, in api.js and telemetry_hour_of_day()', bound[1], sqlBound[1]);
      compare('hourOfDayRead', 'the rows telemetry_hour_of_day() takes and telemetry_carried(), which it reads, takes', sqlBound[1], carriedBound[1]);
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
      compare('hourOfDayRead', 'the arguments readHourOfDay() sends and telemetry_hour_of_day() takes',
        names(call[1], /^\s*(\w+):/gm), names(args[1], /^\s*(\w+) [a-z]/gm));
      compare('hourOfDayRead', 'the columns readHourOfDay() documents and telemetry_hour_of_day() returns',
        names(doc[1], /(\w+): /g), names(args[2], /^\s*(\w+) [a-z]/gm));
    }
  }
}
