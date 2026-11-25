import { suitesInLane } from '../python-suites.mjs';
import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 576. A database suite that calls a function pg_cron calls every minute holds that run out of its
// transaction: the suite's database has the real job. evaluate_automations() does nothing while another
// session holds its lock, so a test that met the job judged nothing. A Prometheus collector locks its
// figures before its probe, the other way round from a test that plants an answer, so the two could
// deadlock. What a suite holds is what the function's latest body waits for, so a renamed key or probe
// cannot leave a suite holding what nothing waits for.
// -------------------------------------------------------------------------------------------------
const KEY = "hashtextextended('evaluate_automations', 0)";
const JOBS = [
  { fn: 'evaluate_automations', waitsFor: `pg_try_advisory_xact_lock(${KEY})`, holds: `SELECT pg_advisory_xact_lock(${KEY});` },
  ...[['refresh_directory_figures', 'directory_figures_probe'], ['refresh_directory_liveness', 'directory_liveness_probe'],
    ['refresh_gateway_arrivals', 'gateway_arrival_probe']].map(([fn, probe]) => ({
    fn, waitsFor: `SELECT request_id INTO v_prev FROM public.${probe} WHERE id;`, probe,
  })),
];

/** The body the last migration that declares the function gives it. */
function latestBody(fn) {
  const header = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  const file = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().filter((f) => read(f).includes(header)).pop();
  const sql = file ? read(file) : '';
  return sql.slice(sql.lastIndexOf(header)).split('$$;')[0];
}

/** Whether a suite locks the probe's table, alone or in one LOCK TABLE with others. */
const locks = (text, probe) => text.split('LOCK TABLE ').slice(1)
  .some((rest) => rest.split(' IN ACCESS EXCLUSIVE MODE')[0].split(', ').includes(`public.${probe}`));

export default function check() {
  const problems576 = [];
  const suites = suitesInLane('db').map((suite) => [suite, read(suite)]);
  let calls = 0;
  for (const { fn, waitsFor, holds, probe } of JOBS) {
    if (!latestBody(fn).includes(waitsFor)) problems576.push(`${fn}() does not wait for what this check says it does: ${waitsFor}`);
    for (const [suite, text] of suites.filter(([, t]) => t.includes(`SELECT public.${fn}(`))) {
      calls += 1;
      if (!(probe ? locks(text, probe) : text.includes(holds))) {
        problems576.push(`${suite} calls ${fn}() and does not hold ${probe ? `public.${probe}` : 'its lock'}`);
      }
    }
  }
  if (calls < JOBS.length) problems576.push(`only ${calls} suite(s) were read that call one of the ${JOBS.length} functions, so this check reads nothing`);
  if (problems576.length) {
    fail('a database suite could meet a scheduled run:\n' + problems576.map((p) => `        ${p}`).join('\n') +
      '\n      Take the lock first thing in setUp, under a lock_timeout, as the suites that call the function do.');
  } else {
    pass(`every database suite that calls evaluate_automations() or a Prometheus collector holds pg_cron's run of it out (${calls} suite and function pairs)`);
  }
}
