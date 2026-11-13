import { compare, lastDefinition, need, read } from './lib.mjs';

// 41. The playback worker's staleness. The playback dialog reads a heartbeat older than
// WORKER_STALE_MS as a worker that is not running, and platform_health_rows() raises
// playback_worker_stale past the same age, and leaves a playback out of job_stuck before it. Two
// thresholds would let the dialog call the worker running while the alert says it is not.
export default function check() {
  const js = read('frontend/src/components/modals/StartPlaybackModal.jsx');
  const jsMs = need(js, /WORKER_STALE_MS\s*=\s*([\d_ *]+)\n/, 'WORKER_STALE_MS in StartPlaybackModal.jsx');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_health_rows()', '$$;',
    'public.platform_health_rows()');
  if (jsMs && fn) {
    const ms = jsMs[1].split('*').map((n) => Number(n.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
    const stale = need(fn.body.slice(fn.body.indexOf("'playback_worker_stale'::text")),
      /reported_at < now\(\) - interval '(\d+) minutes'/, `the playback_worker_stale arm's age (${fn.file})`);
    const fresh = need(fn.body.slice(fn.body.indexOf("'job_stuck'::text")),
      /reported_at >= now\(\) - interval '(\d+) minutes'/, `the job_stuck arm's heartbeat test (${fn.file})`);
    if (stale) compare('playbackWorkerStale', `the stale-worker alert's age (ms), from ${fn.file}`, ms, Number(stale[1]) * 60000);
    if (fresh) compare('playbackWorkerStale', `the age job_stuck leaves to it (ms), from ${fn.file}`, ms, Number(fresh[1]) * 60000);
  }
}
