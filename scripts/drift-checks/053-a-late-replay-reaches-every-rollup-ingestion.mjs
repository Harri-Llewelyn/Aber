import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 53. A late replay reaches every rollup. Ingestion records an hour once a reading is older than
// ROLLUP_POLICY_REACH_SECONDS, and refresh_requested_rollups() refreshes it in each rollup it names.
// The reach plus the widest bucket must stay inside the policies' late_data, with room for their
// schedules, or a reading in between reaches neither; the job must name every rollup aggregates.sql creates, parents first;
// and the window must be whole buckets in each.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const AGG = 'timescaledb/aggregates.sql';
  const agg = read(AGG);
  const daemon = read('ingestion/ingestion.py');
  const UNIT = { minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400 };
  const seconds = (text) => {
    const m = /^(\d+) (\w+)$/.exec(text || '');
    return m && UNIT[m[2]] ? Number(m[1]) * UNIT[m[2]] : NaN;
  };
  const product = (text) => (text ? text.split('*').reduce((p, f) => p * Number(f.trim()), 1) : NaN);
  const rollups = [...agg.matchAll(
    /CREATE MATERIALIZED VIEW IF NOT EXISTS (\w+)\s+WITH \(timescaledb\.continuous\) AS\s+SELECT time_bucket\(INTERVAL '([^']+)', \w+\)[\s\S]*?\n\s*FROM (\w+)/g,
  )].map(([, name, width, source]) => ({ name, width: seconds(width), source }));
  const lateData = seconds((agg.match(/late_data CONSTANT interval := INTERVAL '([^']+)';/) || [])[1]);
  const named = ((agg.match(/v_rollups CONSTANT text\[\] := ARRAY\[([^\]]*)\];/) || [])[1] || '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '').replace(/^public\./, '')).filter(Boolean);
  const reach = product((daemon.match(/\nROLLUP_POLICY_REACH_SECONDS = ([\d *]+)\n/) || [])[1]);
  const windowSeconds = product((daemon.match(/\nROLLUP_WINDOW_SECONDS = ([\d *]+)\n/) || [])[1]);
  const widest = Math.max(...rollups.map((r) => r.width));
  if (!rollups.length || rollups.some((r) => !Number.isFinite(r.width)) || !Number.isFinite(lateData)
      || !named.length || !Number.isFinite(reach) || !Number.isFinite(windowSeconds)) {
    fail(`check 53 could not read the rollups, late_data or refresh_requested_rollups()'s list in ${AGG}, `
      + "or ROLLUP_POLICY_REACH_SECONDS / ROLLUP_WINDOW_SECONDS in ingestion/ingestion.py");
  } else {
    const problems = [];
    const created = rollups.map((r) => r.name);
    if (named.join(',') !== created.join(',')) {
      problems.push(`refresh_requested_rollups() refreshes ${named.join(', ')}; ${AGG} creates ${created.join(', ')}, `
        + 'in that order');
    }
    rollups.forEach((r, i) => {
      if (r.source !== 'telemetry' && !created.slice(0, i).includes(r.source)) {
        problems.push(`${r.name} is built from ${r.source}, which is not created before it`);
      }
      if (windowSeconds % r.width !== 0) {
        problems.push(`ingestion's ${windowSeconds} s window is not whole ${r.name} buckets (${r.width} s)`);
      }
    });
    if (reach + widest >= lateData) {
      problems.push(`ingestion records windows past ${reach} s and the widest bucket is ${widest} s, which `
        + `leaves the policies no time inside the ${lateData} s they reach back`);
    }
    if (problems.length) {
      fail('a late replay would miss a rollup:\n' + problems.map((p) => `        ${p}`).join('\n'));
    } else {
      pass(`a reading older than ${reach / 3600} h has its window refreshed in ${created.join(', ')}, `
        + `inside the policies' ${lateData / 3600} h`);
    }
  }
}
