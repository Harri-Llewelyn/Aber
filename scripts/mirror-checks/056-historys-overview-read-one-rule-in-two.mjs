import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 56. History's Overview read, one rule in two places. telemetry_coverage() (0245) caps a read's
// devices, lets only a small selection sum a block, reads a larger one at the device rollups' own
// widths, and bounds the buckets it reads; api.js states the same for the page, which reads in parts
// of that many devices and caps a large selection's window. A value only one side has is a read the
// page makes and the function refuses.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_coverage(', '$fn$;', 'telemetry_coverage()');
  const api = read('frontend/src/api.js');
  const history = read('frontend/src/utils/history.js');
  const devices = need(api, /^export const COVERAGE_MAX_DEVICES = (\d+);$/m, 'COVERAGE_MAX_DEVICES in frontend/src/api.js');
  const small = need(api, /^export const COVERAGE_SMALL_SELECTION = (\d+);$/m, 'COVERAGE_SMALL_SELECTION in frontend/src/api.js');
  const hours = need(api, /^export const COVERAGE_LARGE_MAX_HOURS = (\d+);$/m, 'COVERAGE_LARGE_MAX_HOURS in frontend/src/api.js');
  const widths = need(api, /^export const COVERAGE_ROLLUP_MINUTES = Object\.freeze\(\[(\d+), (\d+)\]\);$/m, 'COVERAGE_ROLLUP_MINUTES in frontend/src/api.js');
  const fiveHours = need(history, /^export const LARGE_FIVE_MINUTE_HOURS = (\d+)$/m, 'LARGE_FIVE_MINUTE_HOURS in frontend/src/utils/history.js');
  if (def && devices && small && hours && widths && fiveHours) {
    const sqlDevices = need(def.body, /c_max_devices\s+CONSTANT integer := (\d+);/, `the device cap in ${def.file}`);
    const sqlSmall = need(def.body, /c_small\s+CONSTANT integer := (\d+);/, `the small selection in ${def.file}`);
    const sqlBuckets = need(def.body, /c_max_buckets\s+CONSTANT bigint := (\d+);/, `the bucket bound in ${def.file}`);
    const sqlWidths = need(def.body, /v_secs NOT IN \((\d+), (\d+)\)/, `the widths a large selection reads in ${def.file}`);
    if (sqlDevices && sqlSmall && sqlBuckets && sqlWidths) {
      compare('coverageRead', 'the devices one read may carry, in api.js and telemetry_coverage()', devices[1], sqlDevices[1]);
      compare('coverageRead', 'the selection that may sum a block, in api.js and telemetry_coverage()', small[1], sqlSmall[1]);
      compare('coverageRead', "a large selection's block widths in seconds, in api.js and telemetry_coverage()",
        `${widths[1] * 60}, ${widths[2] * 60}`, `${sqlWidths[1]}, ${sqlWidths[2]}`);
      // The longest windows the page gives a full read: 5-minute buckets, then hourly ones, plus the
      // block holding the window's start.
      const widest = Math.max(Number(fiveHours[1]) * 12 + 1, Number(hours[1]) + 1) * Number(devices[1]);
      if (widest > Number(sqlBuckets[1])) {
        problems.push(`coverageRead: ${devices[1]} devices over the page's longest windows read ${widest} buckets, over telemetry_coverage()'s ${sqlBuckets[1]}`);
      } else {
        ok.push(`coverageRead: ${devices[1]} devices over the page's longest windows read ${widest} buckets, under telemetry_coverage()'s ${sqlBuckets[1]}`);
      }
    }
  }
}
