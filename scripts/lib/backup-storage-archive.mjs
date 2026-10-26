// The storage objects' Job: what the backup service builds from the chart's suspended CronJob, how
// it runs one and reads its answer. The API call, the clock and the file system's owner change are
// passed in, so node --test runs all of it without a cluster; scripts/backup-service.mjs passes the
// real ones. The backup-service image copies this file to /opt/aber/lib/ beside the service.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The Job's pod template comes from the chart and is kept as it is; only these are added.
const STABLE_LABELS = ['app.kubernetes.io/name', 'app.kubernetes.io/instance', 'app.kubernetes.io/component'];
const MAX_NAME = 63;
const DIAGNOSIS_CHARS = 600;

const clone = (value) => JSON.parse(JSON.stringify(value));

// <cronjob>-<stamp>, lower case, within the 63 characters the job-name label allows.
export function archiveJobName(cronName, stamp) {
  const suffix = `-${String(stamp).toLowerCase()}`;
  const base = String(cronName).slice(0, MAX_NAME - suffix.length).replace(/-+$/, '');
  return `${base}${suffix}`;
}

// The label selector that finds every Job built from this CronJob, from the labels its template
// gives a Job that no release changes.
export function archiveJobSelector(cronJob) {
  const labels = cronJob?.spec?.jobTemplate?.metadata?.labels || {};
  const pairs = STABLE_LABELS.filter((k) => labels[k]).map((k) => `${k}=${labels[k]}`);
  if (pairs.length !== STABLE_LABELS.length) {
    throw new Error(`the CronJob ${cronJob?.metadata?.name} gives its Jobs no ${STABLE_LABELS.join(', ')} labels to find them by`);
  }
  return pairs.join(',');
}

// The uid and gid the Job's one container writes as: its own securityContext, else its pod's.
export function archiveJobUser(cronJob) {
  const pod = cronJob?.spec?.jobTemplate?.spec?.template?.spec || {};
  const container = (pod.containers || [])[0] || {};
  const pick = (key) => container.securityContext?.[key] ?? pod.securityContext?.[key];
  const uid = pick('runAsUser');
  const gid = pick('runAsGroup');
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`the CronJob ${cronJob?.metadata?.name} states no runAsUser and runAsGroup for its Job`);
  }
  return { uid, gid };
}

// One Job from the CronJob's jobTemplate: a name carrying the stamp, the template's labels, the
// env given, and a required node affinity on `nodeName`, the node that holds the backup volume.
// Owned by the CronJob without being its controller, so deleting the CronJob deletes it and the
// CronJob controller never counts it.
export function archiveJobManifest(cronJob, { stamp, nodeName, env = {} }) {
  if (!cronJob?.spec?.jobTemplate?.spec?.template?.spec) throw new Error('the CronJob has no jobTemplate to build a Job from');
  if (!stamp) throw new Error('a storage archive Job needs the backup stamp');
  if (!nodeName) throw new Error("a storage archive Job needs the backup service's node name (NODE_NAME)");
  const template = clone(cronJob.spec.jobTemplate);
  const spec = template.spec;
  const pod = spec.template.spec;

  // Terms are ORed and each term's requirements ANDed, so the node goes into every term.
  const term = { key: 'metadata.name', operator: 'In', values: [nodeName] };
  const affinity = pod.affinity || (pod.affinity = {});
  const nodeAffinity = affinity.nodeAffinity || (affinity.nodeAffinity = {});
  const required = nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
    || (nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = { nodeSelectorTerms: [] });
  if (!required.nodeSelectorTerms?.length) required.nodeSelectorTerms = [{}];
  for (const t of required.nodeSelectorTerms) t.matchFields = [...(t.matchFields || []), term];

  for (const container of pod.containers || []) {
    const kept = (container.env || []).filter((e) => !(e.name in env));
    container.env = [...kept, ...Object.entries(env).map(([name, value]) => ({ name, value: String(value) }))];
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: archiveJobName(cronJob.metadata.name, stamp),
      namespace: cronJob.metadata.namespace,
      labels: { ...(template.metadata?.labels || {}) },
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: cronJob.metadata.name, uid: cronJob.metadata.uid }],
    },
    spec,
  };
}

// done: false while it runs; ok: true once Complete; ok: false with the reason once Failed (or
// FailureTarget, which precedes Failed), or when the Job is gone.
export function jobOutcome(job) {
  if (!job) return { done: true, ok: false, reason: 'the Job was deleted before it finished' };
  const conditions = job.status?.conditions || [];
  const on = (type) => conditions.find((c) => c.type === type && c.status === 'True');
  if (on('Complete')) return { done: true, ok: true };
  const failed = on('Failed') || on('FailureTarget');
  if (failed) return { done: true, ok: false, reason: [failed.reason, failed.message].filter(Boolean).join(': ') || 'the Job failed' };
  return { done: false };
}

// One line per pod saying why it is where it is: not scheduled, a container waiting, or the code a
// container exited with. For a failure message, so bounded.
export function podDiagnosis(pods) {
  if (!pods?.length) return 'no pod was created';
  const lines = pods.map((p) => {
    const parts = [p.status?.phase || 'Unknown'];
    const unscheduled = (p.status?.conditions || []).find((c) => c.type === 'PodScheduled' && c.status === 'False');
    if (unscheduled) parts.push(`not scheduled: ${unscheduled.message || unscheduled.reason}`);
    for (const c of [...(p.status?.initContainerStatuses || []), ...(p.status?.containerStatuses || [])]) {
      const waiting = c.state?.waiting;
      const done = c.state?.terminated;
      if (waiting) parts.push(`${c.name} waiting: ${[waiting.reason, waiting.message].filter(Boolean).join(': ')}`);
      if (done) parts.push(`${c.name} exited ${done.exitCode}${done.reason ? ` (${done.reason})` : ''}`);
    }
    return `${p.metadata?.name || 'a pod'}: ${parts.join('; ')}`;
  });
  const text = lines.join(' | ');
  return text.length > DIAGNOSIS_CHARS ? `${text.slice(0, DIAGNOSIS_CHARS - 3)}...` : text;
}

// Polls read() (the Job, or null once it is gone) until jobOutcome() says done or timeoutMs
// passes. A read that throws is retried: an API server restarting is not a failed backup.
export async function waitForJob({ read, timeoutMs, pollMs = 2000, now = Date.now, sleep }) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const outcome = jobOutcome(await read());
      if (outcome.done) return outcome;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (now() >= deadline) {
      const seconds = Math.round(timeoutMs / 1000);
      return {
        done: true, ok: false, timedOut: true,
        reason: `it did not finish within ${seconds} s${lastError ? ` (the last read failed: ${lastError.message})` : ''}`,
      };
    }
    await sleep(pollMs);
  }
}

// The calls the archive makes, through kube(method, path, body) -> { status, json, text }, in one
// namespace. Each throws on an answer it does not expect; readJob answers null once the Job is gone.
export function archiveApi(kube, namespace) {
  const ns = encodeURIComponent(namespace);
  const batch = (resource, name = '') => `/apis/batch/v1/namespaces/${ns}/${resource}${name ? `/${encodeURIComponent(name)}` : ''}`;
  const refuse = (what, r) => new Error(`${what} -> ${r.status}: ${(r.text || '').slice(0, 200)}`);
  return {
    async readCronJob(name) {
      const r = await kube('GET', batch('cronjobs', name));
      if (r.status === 200 && r.json) return r.json;
      throw refuse(`GET cronjob ${namespace}/${name}`, r);
    },
    async createJob(job) {
      const r = await kube('POST', batch('jobs'), job);
      if (r.status !== 201) throw refuse(`POST job ${job.metadata.name}`, r);
    },
    async readJob(name) {
      const r = await kube('GET', batch('jobs', name));
      if (r.status === 404) return null;
      if (r.status === 200 && r.json) return r.json;
      throw refuse(`GET job ${name}`, r);
    },
    // Background propagation: the Job goes at once and its pod after it, releasing the volume.
    async deleteJob(name) {
      const r = await kube('DELETE', `${batch('jobs', name)}?propagationPolicy=Background`);
      if (![200, 202, 404].includes(r.status)) throw refuse(`DELETE job ${name}`, r);
    },
    async listJobs(selector) {
      const r = await kube('GET', `${batch('jobs')}?labelSelector=${encodeURIComponent(selector)}`);
      if (r.status === 200 && r.json) return r.json.items || [];
      throw refuse(`GET jobs ${selector}`, r);
    },
    async listPods(jobName) {
      const r = await kube('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`);
      if (r.status === 200 && r.json) return r.json.items || [];
      throw refuse(`GET pods of job ${jobName}`, r);
    },
  };
}

// At start: every Job an earlier process made from the CronJob and never deleted.
export async function sweepArchiveJobs({ api, cronJobName, log }) {
  const selector = archiveJobSelector(await api.readCronJob(cronJobName));
  for (const job of await api.listJobs(selector)) {
    await api.deleteJob(job.metadata.name);
    log(`removed the storage archive Job ${job.metadata.name}, which an earlier process left`);
  }
}

// One Job for the backup being written in `dir` (under `backupDir`, which the Job mounts at
// /backups): its tar writes <name>-<stamp>.tar.gz, as tarDirectory() names an archive, and tar's
// stderr beside it. Exit 1, "file changed as we read it", is the Job's success and a logged warning
// here. The Job is deleted however it ends. share(dir, { uid, gid }) lets the Job's user write
// `dir`; digest(path) is the file's SHA-256; onJob(name) is told the Job in flight, then null.
export async function archiveInJob({
  api, cronJobName, nodeName, backupDir, dir, stamp, timeoutSeconds, share, digest, log,
  onJob = () => {}, sleep, now = Date.now, pollMs = 2000,
}) {
  const name = 'storage-objects';
  const file = `${name}-${stamp}.tar.gz`;
  const out = join(dir, file);
  const tarLog = join(dir, `.${name}.log`);
  const onVolume = (path) => relative(backupDir, path).split(sep).join('/');
  const cronJob = await api.readCronJob(cronJobName);
  share(dir, archiveJobUser(cronJob));
  const job = archiveJobManifest(cronJob, {
    stamp, nodeName, env: { ARCHIVE_FILE: onVolume(out), ARCHIVE_LOG: onVolume(tarLog) },
  });
  const jobName = job.metadata.name;
  await api.createJob(job);
  onJob(jobName);
  log(`  ${name}: Job ${jobName} on node ${nodeName}`);
  let outcome;
  let pods = [];
  try {
    // The Job's activeDeadlineSeconds is timeoutSeconds, so its own deadline normally answers first.
    outcome = await waitForJob({ read: () => api.readJob(jobName), timeoutMs: (timeoutSeconds + 60) * 1000, pollMs, now, sleep });
    if (!outcome.ok) pods = await api.listPods(jobName).catch(() => []);
  } finally {
    onJob(null);
    await api.deleteJob(jobName).catch((err) => log(`  ${name}: could not delete Job ${jobName}: ${err.message}`));
  }
  const stderr = existsSync(tarLog) ? readFileSync(tarLog, 'utf8').trim() : '';
  rmSync(tarLog, { force: true });
  if (!outcome.ok) {
    const tail = stderr ? `: ${stderr.split('\n').slice(-2).join(' ')}` : '';
    throw new Error(`tar ${name} failed in Job ${jobName}${tail}; the Job: ${outcome.reason}; its pod: ${podDiagnosis(pods)}`);
  }
  if (!existsSync(out)) {
    throw new Error(`the storage archive Job ${jobName} completed and wrote no ${file}${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
  }
  if (stderr) log(`  ${name}: tar warned (a file changed while it was read): ${stderr.split('\n').pop()}`);
  return { name, file, size_bytes: statSync(out).size, sha256: await digest(out) };
}
