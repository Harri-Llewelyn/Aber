import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 166. A shutdown stores the capture in flight in what the pod's termination grace period leaves.
// The daemon's TERMINATION_GRACE_SECONDS is the grace the ingestion pod is given: Kubernetes' 30 s
// while the template sets no terminationGracePeriodSeconds, and the same value passed to the
// daemon when it does. ingestion/README.md's shutdown arithmetic is the code's bounds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems166 = [];
  const daemon = read('ingestion/ingestion.py');
  const worker = read('ingestion/capture_worker.py');
  const host = read('ingestion/primary_host.py');
  const constant = (text, name) => {
    const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`^${id} = (?:float\\(os\\.getenv\\("${id}", "([\\d.]+)"\\)\\)|([\\d.]+))$`, 'm'));
    if (!m) problems166.push(`${name} has no default this check can read`);
    return Number(m ? m[1] ?? m[2] : NaN);
  };
  const grace = constant(daemon, 'TERMINATION_GRACE_SECONDS');
  const exit = constant(daemon, 'SHUTDOWN_EXIT_MARGIN_SECONDS');
  const receive = constant(daemon, 'TELEMETRY_SHUTDOWN_RECEIVE_SECONDS');
  const drain = constant(daemon, 'TELEMETRY_SHUTDOWN_DRAIN_SECONDS');
  const ack = constant(host, 'OFFLINE_ACK_SECONDS');
  const write = constant(worker, 'SHUTDOWN_WRITE_SECONDS');
  const minimum = constant(worker, 'SHUTDOWN_MIN_UPLOAD_SECONDS');

  const template = read('deploy/helm/aber/templates/apps/ingestion.yaml');
  const podGrace = template.match(/^\s*terminationGracePeriodSeconds:\s*(.+?)\s*$/m)?.[1];
  const passed = template.match(/- name: TERMINATION_GRACE_SECONDS\s*\n\s*value:\s*(.+?)\s*$/m)?.[1];
  // The same literal, or the same values key, read where the template sets each.
  const source = (v) => v.match(/\.Values\.[\w.]+/)?.[0] ?? String(Number(v.replace(/"/g, '')));
  if (podGrace === undefined) {
    if (passed !== undefined) problems166.push('the ingestion template passes TERMINATION_GRACE_SECONDS but sets no terminationGracePeriodSeconds');
    else if (grace !== 30) problems166.push(`ingestion.py defaults TERMINATION_GRACE_SECONDS to ${grace}, but the ingestion pod has Kubernetes' 30 s`);
  } else if (passed === undefined ? Number(podGrace) !== grace : source(passed) !== source(podGrace)) {
    problems166.push(`the ingestion pod's terminationGracePeriodSeconds (${podGrace}) is not what the daemon is told (${passed ?? `its default, ${grace}`})`);
  }

  const left = grace - exit - ack - receive - drain;
  const upload = left - 2 * write;
  if (!(upload >= minimum)) problems166.push(`at their bounds the shutdown's steps leave a capture ${upload} s for its upload, under SHUTDOWN_MIN_UPLOAD_SECONDS (${minimum})`);
  const readme = read('ingestion/README.md');
  const step = readme.match(/^4\. \*\*Store a capture in flight\*\*[\s\S]*?(?=\n\n)/m)?.[0].replace(/\s+/g, ' ') ?? '';
  if (!step) problems166.push('ingestion/README.md has no shutdown step "Store a capture in flight"');
  for (const piece of [`\`TERMINATION_GRACE_SECONDS\` (${grace})`, `at least ${left} s`, `the ${grace} s less ${exit} s kept for the exit`,
    `the ${ack} s acknowledgement`, `${receive} s of receiving`, `${drain} s of draining`, `has ${upload} s of it`, `two writes ${write} s each`]) {
    if (step && !step.includes(piece)) problems166.push(`ingestion/README.md's shutdown step does not say "${piece}"`);
  }
  if (!readme.includes(`| \`TERMINATION_GRACE_SECONDS\` | \`${grace}\` |`)) problems166.push(`ingestion/README.md's configuration table does not give TERMINATION_GRACE_SECONDS as ${grace}`);

  // The startup sweep spares a job that went quiet more recently than the grace period, so a
  // replaced daemon can still store it, and the worker sweeps again once that is past.
  const sweeps = readdirSync(join(REPO, 'supabase/migrations')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()
    .map((n) => read(`supabase/migrations/${n}`))
    .filter((t) => t.includes('CREATE OR REPLACE FUNCTION public.ingest_reconcile_capture_jobs()'));
  const sweepBody = sweeps.pop()?.split('CREATE OR REPLACE FUNCTION public.ingest_reconcile_capture_jobs()')[1]?.split('\n$$;')[0] ?? '';
  const spare = Number(sweepBody.match(/c_spare_seconds CONSTANT integer := (\d+);/)?.[1]);
  const resweep = constant(worker, 'RESWEEP_AFTER_SECONDS');
  if (!(spare > grace)) problems166.push(`ingest_reconcile_capture_jobs() spares a job quiet for ${spare || 'no'} s, not longer than the ${grace} s grace period`);
  if (!(resweep > spare)) problems166.push(`RESWEEP_AFTER_SECONDS (${resweep}) does not outlast the sweep's ${spare} s spare`);
  if (spare && !readme.includes(`has not reported for ${spare} seconds`)) problems166.push(`ingestion/README.md does not say the sweep spares a recording for ${spare} seconds`);

  if (problems166.length) {
    for (const p of problems166) fail(`shutdown budget: ${p}`);
  } else {
    pass(`a shutdown stores a capture in what the ${grace} s grace period leaves, at least ${left} s with ${upload} s for the upload, and the ingestion pod is given the grace the daemon assumes; the startup sweep spares a job quiet for under ${spare} s and the worker sweeps again after ${resweep} s`);
  }
}
