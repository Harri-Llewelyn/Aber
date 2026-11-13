import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 47. History's read, one rule in two places. telemetry_carried() (0233) reads the rollup whose
// width divides the bucket, and api.js names the same rollups and widths (TELEMETRY_RESOLUTIONS),
// from which History's resolutions are built. A width only one side has is a resolution the page
// offers and the function reads from a coarser rollup, or the other way. Each of History's widths
// must be a bucket the function takes, and the page's row cap must fit under the function's bound.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_carried(', '$fn$;', 'telemetry_carried()');
  const api = read('frontend/src/api.js');
  const rollups = need(api, /const TELEMETRY_RESOLUTIONS = \{([\s\S]*?)\n\};/, 'TELEMETRY_RESOLUTIONS in frontend/src/api.js');
  const history = need(api, /export const HISTORY_RESOLUTIONS = Object\.freeze\(\[([\s\S]*?)\]\);/, 'HISTORY_RESOLUTIONS in frontend/src/api.js');
  const cap = need(api, /^const TELEMETRY_MAX_ROWS = (\d+);$/m, 'TELEMETRY_MAX_ROWS in frontend/src/api.js');
  if (def && rollups && history && cap) {
    const UNIT_MINUTES = { minute: 1, minutes: 1, hour: 60, hours: 60 };
    const sql = [...def.body.matchAll(/v_source := '(telemetry_\w+)'; v_width := interval '(\d+) (minutes?|hours?)'/g)]
      .map((m) => `${m[1]}=${Number(m[2]) * UNIT_MINUTES[m[3]]}`).sort().join(', ');
    const js = [...rollups[1].matchAll(/relation: '(telemetry_\w+)', bucketMinutes: (\d+)/g)]
      .map((m) => `${m[1]}=${m[2]}`).sort().join(', ');
    compare('historyRead', 'the rollups and their widths in minutes, in api.js and telemetry_carried()', js, sql);

    const bound = need(def.body, /c_max_rows CONSTANT bigint := (\d+);/, `the row bound in ${def.file}`);
    const least = need(def.body, /v_secs < (\d+) OR v_secs % (\d+) <> 0/, `the smallest bucket in ${def.file}`);
    if (bound && least) {
      if (Number(cap[1]) > Number(bound[1])) {
        problems.push(`historyRead: the page's row cap (${cap[1]}) is over telemetry_carried()'s bound (${bound[1]}), so a read the page makes is refused`);
      } else {
        ok.push(`historyRead: the page's row cap (${cap[1]}) fits under telemetry_carried()'s bound (${bound[1]})`);
      }
      // History's widths, each as minutes: a literal, or a rollup's bucketMinutes by its key.
      const byKey = Object.fromEntries([...rollups[1].matchAll(/'(\w+)': \{ relation: '\w+', bucketMinutes: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
      const widths = [...history[1].matchAll(/minutes: (?:TELEMETRY_RESOLUTIONS\['(\w+)'\]\.bucketMinutes|(\d+))/g)]
        .map((m) => (m[1] ? byKey[m[1]] : Number(m[2])));
      const refused = widths.filter((w) => !(Number.isInteger(w) && w * 60 >= Number(least[1]) && (w * 60) % Number(least[2]) === 0));
      if (!widths.length) {
        problems.push('historyRead: found no width in HISTORY_RESOLUTIONS -- its shape changed, so this check is no longer checking anything');
      } else if (refused.length) {
        problems.push(`historyRead: History offers ${refused.join(', ')}-minute buckets, which telemetry_carried() refuses`);
      } else {
        ok.push(`historyRead: telemetry_carried() takes each of History's ${widths.length} widths (${widths.join(', ')} minutes)`);
      }
    }
  }
}
