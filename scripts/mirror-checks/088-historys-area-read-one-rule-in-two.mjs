import { compare, lastDefinition, need, read } from './lib.mjs';

// 88. History's Area read, one rule in two places. telemetry_carried_by_group() (0276) reads every
// device through telemetry_carried(), which refuses more than c_max_rows buckets times devices, and
// api.js states the same bound for the Area tab, which keeps the finest resolution it asks for inside
// it (pickGroupResolution()). It takes the arguments readCarriedByGroup() sends. A bound the page
// holds and the function does not is a chart the page offers and the function refuses; an argument one
// side names is an Area tab that draws nothing.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried_by_group(', '$fn$;', 'telemetry_carried_by_group()');
  const carried = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const bound = need(api, /^export const HISTORY_GROUP_READ_ROWS = (\d+);$/m, 'HISTORY_GROUP_READ_ROWS in frontend/src/api.js');
  // Up to the call's closing line, not the first brace: bucket is a template literal.
  const call = need(api, /supabase\.rpc\('telemetry_carried_by_group', \{([\s\S]*?)\n\s*\}\)/, "readCarriedByGroup()'s rpc call in frontend/src/api.js");
  if (def && carried && bound && call) {
    const carriedBound = need(carried.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${carried.file}`);
    const args = need(def.body, /telemetry_carried_by_group\(([\s\S]*?)\) RETURNS TABLE \(([\s\S]*?)\)\s+LANGUAGE/, `the signature in ${def.file}`);
    if (carriedBound && args) {
      compare('groupRead', 'the rows one read may take, in api.js and telemetry_carried(), which telemetry_carried_by_group() reads', bound[1], carriedBound[1]);
      const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
      compare('groupRead', 'the arguments readCarriedByGroup() sends and telemetry_carried_by_group() takes',
        names(call[1], /^\s*(\w+):/gm), names(args[1], /^\s*(\w+) [a-z]/gm));
    }
  }
}
