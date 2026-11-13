import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 69. History's change read, one rule in two places. telemetry_changes() (0254) falls back past
// its default max_changes and past the raw readings one series may bring across, and reads at most
// so many series; api.js states the same for the page, which passes that cap, names both in its
// words and reads in parts of that many series. A value only one side has is a chart labelled with
// a cap the function does not hold, or a read the function refuses.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_changes(', '$fn$;', 'telemetry_changes()');
  const api = read('frontend/src/api.js');
  const changes = need(api, /^export const HISTORY_MAX_CHANGES = (\d+);$/m, 'HISTORY_MAX_CHANGES in frontend/src/api.js');
  const readings = need(api, /^export const HISTORY_CHANGE_READINGS = (\d+);$/m, 'HISTORY_CHANGE_READINGS in frontend/src/api.js');
  const series = need(api, /^export const HISTORY_CHANGE_SERIES = (\d+);$/m, 'HISTORY_CHANGE_SERIES in frontend/src/api.js');
  if (def && changes && readings && series) {
    const sqlDefault = need(def.body, /max_changes integer DEFAULT (\d+)/, `max_changes' default in ${def.file}`);
    const sqlMost = need(def.body, /c_max_changes\s+CONSTANT integer := (\d+);/, `the most max_changes may be in ${def.file}`);
    const sqlReadings = need(def.body, /c_max_readings CONSTANT bigint := (\d+);/, `the readings bound in ${def.file}`);
    const sqlSeries = need(def.body, /c_max_series\s+CONSTANT integer := (\d+);/, `the series bound in ${def.file}`);
    if (sqlDefault && sqlMost && sqlReadings && sqlSeries) {
      compare('changeRead', 'the changes past which a chart shows its buckets, in api.js and telemetry_changes()', changes[1], sqlDefault[1]);
      compare('changeRead', 'the readings one series may bring across, in api.js and telemetry_changes()', readings[1], sqlReadings[1]);
      compare('changeRead', 'the series one read may carry, in api.js and telemetry_changes()', series[1], sqlSeries[1]);
      if (Number(changes[1]) > Number(sqlMost[1])) {
        problems.push(`changeRead: the page's cap (${changes[1]}) is over the ${sqlMost[1]} telemetry_changes() takes, so every read is refused`);
      } else {
        ok.push(`changeRead: the page's cap (${changes[1]}) is one telemetry_changes() takes (1 to ${sqlMost[1]})`);
      }
    }
  }
}
