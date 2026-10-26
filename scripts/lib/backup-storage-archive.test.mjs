/**
 * The storage archive Job the backup service makes per backup (scripts/lib/backup-storage-archive.mjs),
 * without a cluster: the Job built from the chart's suspended CronJob, the selector and user read
 * from it, how a Job's status and its pod's are read, the wait's timeout, the API paths, and one
 * whole run against a fake API whose Job writes into a temporary backup volume. The last tests hold
 * the chart's template, the service and the library to the same names, paths and tar.
 *
 *     node --test scripts/lib/backup-storage-archive.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveApi, archiveInJob, archiveJobManifest, archiveJobName, archiveJobSelector, archiveJobUser,
  jobOutcome, podDiagnosis, sweepArchiveJobs, waitForJob,
} from './backup-storage-archive.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = '20261026T023000Z';
const NODE = 'k3d-aber-server-0';

const LABELS = {
  'helm.sh/chart': 'aber-1.7.0',
  'app.kubernetes.io/name': 'aber',
  'app.kubernetes.io/instance': 'aber',
  'app.kubernetes.io/version': '1.7.0',
  'app.kubernetes.io/managed-by': 'Helm',
  'app.kubernetes.io/part-of': 'aber',
  'app.kubernetes.io/component': 'backup-storage-archive',
};

// The CronJob as the API returns what jobs/backup-storage-archive.yaml renders.
function cronJob() {
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: 'aber-backup-storage-archive', namespace: 'aber', uid: '0b6c1a52-1f6e-4c1e-9d0e-6f1f2a3b4c5d', labels: { ...LABELS } },
    spec: {
      suspend: true,
      schedule: '0 0 31 2 *',
      jobTemplate: {
        metadata: { labels: { ...LABELS } },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 3600,
          ttlSecondsAfterFinished: 3600,
          template: {
            metadata: { labels: { ...LABELS } },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              securityContext: {
                runAsNonRoot: true, runAsUser: 100, runAsGroup: 101, supplementalGroups: [1000],
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [{
                name: 'archive',
                image: 'ghcr.io/harri-llewelyn/aber/backup-service:1.7.0',
                command: ['/bin/sh', '-c', 'tar -czf "/backups/$ARCHIVE_FILE" -C /storage .'],
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { memory: '256Mi' } },
                volumeMounts: [{ name: 'backups', mountPath: '/backups' }, { name: 'storage-objects', mountPath: '/storage', readOnly: true }],
              }],
              volumes: [
                { name: 'backups', persistentVolumeClaim: { claimName: 'aber-backup' } },
                { name: 'storage-objects', persistentVolumeClaim: { claimName: 'aber-storage', readOnly: true } },
              ],
            },
          },
        },
      },
    },
  };
}

const ENV = { ARCHIVE_FILE: `.partial-${STAMP}/storage-objects-${STAMP}.tar.gz`, ARCHIVE_LOG: `.partial-${STAMP}/.storage-objects.log` };

test('a Job is named for its backup, in lower case, within the 63 characters a job-name label holds', () => {
  assert.equal(archiveJobName('aber-backup-storage-archive', STAMP), 'aber-backup-storage-archive-20261026t023000z');
  const long = archiveJobName(`${'a'.repeat(40)}-${'b'.repeat(20)}`, STAMP);
  assert.equal(long, `${'a'.repeat(40)}-bbbbb-20261026t023000z`);
  assert.equal(long.length, 63);
  // Cut where the name has a dash: one dash before the stamp, not two.
  assert.equal(archiveJobName(`${'a'.repeat(45)}-${'b'.repeat(10)}`, STAMP), `${'a'.repeat(45)}-20261026t023000z`);
});

test('the Job is the CronJob\'s template, with the backup\'s name, labels, owner, env and node', () => {
  const source = cronJob();
  const before = JSON.stringify(source);
  const job = archiveJobManifest(source, { stamp: STAMP, nodeName: NODE, env: ENV });
  assert.equal(JSON.stringify(source), before, 'the CronJob read from the API is left as it was');

  assert.equal(job.apiVersion, 'batch/v1');
  assert.equal(job.kind, 'Job');
  assert.equal(job.metadata.name, 'aber-backup-storage-archive-20261026t023000z');
  assert.equal(job.metadata.namespace, 'aber');
  assert.deepEqual(job.metadata.labels, LABELS);
  // Owned, so deleting the CronJob deletes it; not controlled, so the CronJob controller ignores it.
  assert.deepEqual(job.metadata.ownerReferences, [{
    apiVersion: 'batch/v1', kind: 'CronJob', name: 'aber-backup-storage-archive', uid: source.metadata.uid,
  }]);
  assert.equal(job.spec.selector, undefined, 'the API generates the selector');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 3600);
  assert.equal(job.spec.ttlSecondsAfterFinished, 3600);

  const pod = job.spec.template.spec;
  const template = source.spec.jobTemplate.spec.template.spec;
  assert.deepEqual(job.spec.template.metadata, source.spec.jobTemplate.spec.template.metadata);
  assert.deepEqual(pod.securityContext, template.securityContext);
  assert.deepEqual(pod.containers[0].securityContext, template.containers[0].securityContext);
  assert.deepEqual(pod.volumes, template.volumes);
  assert.deepEqual(pod.containers[0].volumeMounts, template.containers[0].volumeMounts);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.nodeName, undefined, 'the scheduler places it: nodeName would bypass it');
  assert.equal(pod.nodeSelector, undefined);
  assert.deepEqual(pod.affinity, {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [NODE] }] }],
      },
    },
  });
  assert.deepEqual(pod.containers[0].env, [
    { name: 'ARCHIVE_FILE', value: ENV.ARCHIVE_FILE },
    { name: 'ARCHIVE_LOG', value: ENV.ARCHIVE_LOG },
  ]);
});

test('a template\'s own node terms each gain the node, and its env of the same name is replaced', () => {
  const source = cronJob();
  const pod = source.spec.jobTemplate.spec.template.spec;
  pod.affinity = {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: 'disk', operator: 'In', values: ['ssd'] }] },
          { matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] },
        ],
      },
    },
  };
  pod.containers[0].env = [{ name: 'TZ', value: 'UTC' }, { name: 'ARCHIVE_FILE', value: 'stale' }];
  const job = archiveJobManifest(source, { stamp: STAMP, nodeName: NODE, env: ENV });
  const terms = job.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms;
  assert.equal(terms.length, 2);
  for (const t of terms) {
    assert.equal(t.matchExpressions.length, 1);
    assert.deepEqual(t.matchFields, [{ key: 'metadata.name', operator: 'In', values: [NODE] }]);
  }
  assert.deepEqual(job.spec.template.spec.containers[0].env, [
    { name: 'TZ', value: 'UTC' },
    { name: 'ARCHIVE_FILE', value: ENV.ARCHIVE_FILE },
    { name: 'ARCHIVE_LOG', value: ENV.ARCHIVE_LOG },
  ]);
});

test('a Job is refused without the stamp, the node or a template', () => {
  assert.throws(() => archiveJobManifest(cronJob(), { stamp: STAMP, nodeName: '', env: ENV }), /NODE_NAME/);
  assert.throws(() => archiveJobManifest(cronJob(), { stamp: '', nodeName: NODE, env: ENV }), /stamp/);
  assert.throws(() => archiveJobManifest({ metadata: { name: 'x' }, spec: {} }, { stamp: STAMP, nodeName: NODE }), /jobTemplate/);
});

test('the selector is the template\'s three labels that no release changes', () => {
  assert.equal(archiveJobSelector(cronJob()),
    'app.kubernetes.io/name=aber,app.kubernetes.io/instance=aber,app.kubernetes.io/component=backup-storage-archive');
  const bare = cronJob();
  delete bare.spec.jobTemplate.metadata.labels['app.kubernetes.io/component'];
  assert.throws(() => archiveJobSelector(bare), /labels to find them by/);
});

test('the Job\'s user is its container\'s, else its pod\'s, and must be stated', () => {
  assert.deepEqual(archiveJobUser(cronJob()), { uid: 100, gid: 101 });
  const own = cronJob();
  Object.assign(own.spec.jobTemplate.spec.template.spec.containers[0].securityContext, { runAsUser: 70, runAsGroup: 70 });
  assert.deepEqual(archiveJobUser(own), { uid: 70, gid: 70 });
  const none = cronJob();
  delete none.spec.jobTemplate.spec.template.spec.securityContext.runAsGroup;
  assert.throws(() => archiveJobUser(none), /runAsUser and runAsGroup/);
});

const withConditions = (...conditions) => ({ status: { conditions } });

test('a Job is running, complete, failed or gone', () => {
  assert.deepEqual(jobOutcome({ status: { active: 1 } }), { done: false });
  assert.deepEqual(jobOutcome(withConditions({ type: 'Complete', status: 'True' })), { done: true, ok: true });
  assert.deepEqual(jobOutcome(withConditions({ type: 'Complete', status: 'False' })), { done: false });
  assert.deepEqual(
    jobOutcome(withConditions({ type: 'Failed', status: 'True', reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline' })),
    { done: true, ok: false, reason: 'DeadlineExceeded: Job was active longer than specified deadline' },
  );
  // FailureTarget comes before Failed while the pod is still terminating.
  assert.deepEqual(
    jobOutcome(withConditions({ type: 'FailureTarget', status: 'True', reason: 'BackoffLimitExceeded' })),
    { done: true, ok: false, reason: 'BackoffLimitExceeded' },
  );
  assert.equal(jobOutcome(null).ok, false);
  assert.match(jobOutcome(null).reason, /deleted before it finished/);
});

test('a pod says why it has not run, or how it ended, in a bounded line', () => {
  assert.equal(podDiagnosis([]), 'no pod was created');
  assert.equal(podDiagnosis([{
    metadata: { name: 'p1' },
    status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/1 nodes are available: 1 node(s) had volume node affinity conflict.' }] },
  }]), 'p1: Pending; not scheduled: 0/1 nodes are available: 1 node(s) had volume node affinity conflict.');
  assert.equal(podDiagnosis([{
    metadata: { name: 'p2' },
    status: { phase: 'Pending', containerStatuses: [{ name: 'archive', state: { waiting: { reason: 'ErrImagePull', message: 'not found' } } }] },
  }]), 'p2: Pending; archive waiting: ErrImagePull: not found');
  assert.equal(podDiagnosis([{
    metadata: { name: 'p3' },
    status: { phase: 'Failed', containerStatuses: [{ name: 'archive', state: { terminated: { exitCode: 2, reason: 'Error' } } }] },
  }]), 'p3: Failed; archive exited 2 (Error)');
  const many = Array.from({ length: 40 }, (_, i) => ({ metadata: { name: `pod-${i}` }, status: { phase: 'Failed' } }));
  assert.ok(podDiagnosis(many).length <= 600);
  assert.ok(podDiagnosis(many).endsWith('...'));
});

// A clock that sleeping moves, and a read that answers from a script.
function harness(answers) {
  let t = 0;
  const reads = [];
  return {
    reads,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    read: async () => {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      reads.push(t);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('the wait returns once the Job completes, polling between reads', async () => {
  const h = harness([{ status: { active: 1 } }, { status: { active: 1 } }, withConditions({ type: 'Complete', status: 'True' })]);
  const outcome = await waitForJob({ read: h.read, now: h.now, sleep: h.sleep, timeoutMs: 60_000, pollMs: 2000 });
  assert.deepEqual(outcome, { done: true, ok: true });
  assert.deepEqual(h.reads, [0, 2000, 4000]);
});

test('the wait returns a failed Job\'s reason at once', async () => {
  const h = harness([withConditions({ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' })]);
  const outcome = await waitForJob({ read: h.read, now: h.now, sleep: h.sleep, timeoutMs: 60_000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'BackoffLimitExceeded: Job has reached the specified backoff limit');
  assert.equal(h.reads.length, 1);
});

test('the wait gives up after its timeout, and says so', async () => {
  const h = harness([{ status: { active: 1 } }]);
  const outcome = await waitForJob({ read: h.read, now: h.now, sleep: h.sleep, timeoutMs: 3_660_000, pollMs: 2000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.reason, 'it did not finish within 3660 s');
  assert.equal(h.reads.at(-1), 3_660_000, 'the last read is at the deadline, not before it');
});

test('a read that fails is retried, and the last failure is named if the wait times out', async () => {
  const recovered = harness([new Error('connect ECONNREFUSED'), withConditions({ type: 'Complete', status: 'True' })]);
  assert.deepEqual(await waitForJob({ read: recovered.read, now: recovered.now, sleep: recovered.sleep, timeoutMs: 60_000 }), { done: true, ok: true });

  const down = harness([new Error('GET job x -> 503')]);
  const outcome = await waitForJob({ read: down.read, now: down.now, sleep: down.sleep, timeoutMs: 10_000, pollMs: 2000 });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.reason, 'it did not finish within 10 s (the last read failed: GET job x -> 503)');
});

test('a Job deleted under the wait ends it as a failure', async () => {
  const h = harness([{ status: { active: 1 } }, null]);
  const outcome = await waitForJob({ read: h.read, now: h.now, sleep: h.sleep, timeoutMs: 60_000 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /deleted before it finished/);
});

// ------------------------------------------------------------------------------------------------
// The API calls, and one whole Job against a fake API.
// ------------------------------------------------------------------------------------------------
test('each call goes to the batch or core path in the namespace, and an unexpected answer throws', async () => {
  const calls = [];
  let answer = { status: 200, json: { items: [] }, text: '' };
  const api = archiveApi(async (method, path, body) => { calls.push([method, path, body]); return answer; }, 'aber');

  answer = { status: 200, json: cronJob(), text: '' };
  assert.equal((await api.readCronJob('aber-backup-storage-archive')).kind, 'CronJob');
  answer = { status: 201, json: {}, text: '' };
  const job = archiveJobManifest(cronJob(), { stamp: STAMP, nodeName: NODE, env: ENV });
  await api.createJob(job);
  answer = { status: 404, json: null, text: 'not found' };
  assert.equal(await api.readJob(job.metadata.name), null, 'a Job that is gone reads as null');
  await api.deleteJob(job.metadata.name);
  answer = { status: 200, json: { items: [{ metadata: { name: 'j' } }] }, text: '' };
  assert.deepEqual(await api.listJobs('app.kubernetes.io/component=backup-storage-archive'), [{ metadata: { name: 'j' } }]);
  assert.deepEqual(await api.listPods(job.metadata.name), [{ metadata: { name: 'j' } }]);

  assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), [
    'GET /apis/batch/v1/namespaces/aber/cronjobs/aber-backup-storage-archive',
    'POST /apis/batch/v1/namespaces/aber/jobs',
    'GET /apis/batch/v1/namespaces/aber/jobs/aber-backup-storage-archive-20261026t023000z',
    'DELETE /apis/batch/v1/namespaces/aber/jobs/aber-backup-storage-archive-20261026t023000z?propagationPolicy=Background',
    'GET /apis/batch/v1/namespaces/aber/jobs?labelSelector=app.kubernetes.io%2Fcomponent%3Dbackup-storage-archive',
    'GET /api/v1/namespaces/aber/pods?labelSelector=job-name%3Daber-backup-storage-archive-20261026t023000z',
  ]);
  assert.equal(calls[1][2], job, 'the Job is the body of the POST');

  answer = { status: 403, json: null, text: 'jobs.batch is forbidden: User "system:serviceaccount:aber:aber-backup-service" cannot create resource "jobs"' };
  await assert.rejects(api.createJob(job), /POST job aber-backup-storage-archive-20261026t023000z -> 403: jobs\.batch is forbidden/);
  await assert.rejects(api.readCronJob('aber-backup-storage-archive'), /GET cronjob aber\/aber-backup-storage-archive -> 403/);
  answer = { status: 500, json: null, text: 'etcd' };
  await assert.rejects(api.deleteJob('x'), /DELETE job x -> 500/);
  await assert.rejects(api.readJob('x'), /GET job x -> 500/);
});

test('the sweep at start deletes every Job made from the CronJob', async () => {
  const deleted = [];
  const said = [];
  const api = {
    readCronJob: async () => cronJob(),
    listJobs: async (selector) => {
      assert.equal(selector, archiveJobSelector(cronJob()));
      return [{ metadata: { name: 'aber-backup-storage-archive-20261025t023000z' } }, { metadata: { name: 'aber-backup-storage-archive-20261024t023000z' } }];
    },
    deleteJob: async (name) => { deleted.push(name); },
  };
  await sweepArchiveJobs({ api, cronJobName: 'aber-backup-storage-archive', log: (m) => said.push(m) });
  assert.deepEqual(deleted, ['aber-backup-storage-archive-20261025t023000z', 'aber-backup-storage-archive-20261024t023000z']);
  assert.equal(said.length, 2);
});

const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// A backup volume with this backup's partial directory, and an API whose Job "runs" when created:
// it writes what `run` returns into the two paths the Job was given, relative to the volume.
function stage({ run = () => ({ archive: 'tarball', log: '' }), states = [withConditions({ type: 'Complete', status: 'True' })], pods = [], create }) {
  const backupDir = mkdtempSync(join(tmpdir(), 'aber-archive-'));
  scratch.push(backupDir);
  const dir = join(backupDir, `.partial-${STAMP}`);
  mkdirSync(dir);
  const events = [];
  const env = {};
  const api = {
    readCronJob: async (name) => { events.push(`read ${name}`); return cronJob(); },
    createJob: async (job) => {
      if (create) await create(job);
      events.push(`create ${job.metadata.name}`);
      for (const e of job.spec.template.spec.containers[0].env) env[e.name] = e.value;
      const { archive, log } = run();
      if (log !== null) writeFileSync(join(backupDir, env.ARCHIVE_LOG), log);
      if (archive !== null) writeFileSync(join(backupDir, env.ARCHIVE_FILE), archive);
    },
    readJob: async () => (states.length > 1 ? states.shift() : states[0]),
    deleteJob: async (name) => { events.push(`delete ${name}`); },
    listPods: async () => pods,
  };
  let t = 0;
  const said = [];
  const jobs = [];
  const shared = [];
  const go = () => archiveInJob({
    api, cronJobName: 'aber-backup-storage-archive', nodeName: NODE, backupDir, dir, stamp: STAMP, timeoutSeconds: 3600,
    share: (d, user) => shared.push([d, user]), digest: async (p) => `sha256 of ${readFileSync(p, 'utf8')}`,
    log: (m) => said.push(m), onJob: (n) => jobs.push(n), sleep: async (ms) => { t += ms; }, now: () => t,
  });
  return { backupDir, dir, events, env, said, jobs, shared, go };
}

test('a Job that completes leaves the archive as tarDirectory() would record it, and is deleted', async () => {
  const s = stage({});
  const component = await s.go();
  assert.deepEqual(component, {
    name: 'storage-objects', file: `storage-objects-${STAMP}.tar.gz`, size_bytes: 'tarball'.length, sha256: 'sha256 of tarball',
  });
  assert.deepEqual(s.env, ENV, 'the two paths are relative to the backup volume, with forward slashes');
  assert.deepEqual(s.shared, [[s.dir, { uid: 100, gid: 101 }]], 'the directory is shared with the Job\'s user before the Job starts');
  assert.deepEqual(s.events, [
    'read aber-backup-storage-archive',
    'create aber-backup-storage-archive-20261026t023000z',
    'delete aber-backup-storage-archive-20261026t023000z',
  ]);
  assert.deepEqual(s.jobs, ['aber-backup-storage-archive-20261026t023000z', null]);
  assert.equal(existsSync(join(s.dir, '.storage-objects.log')), false, 'the log is not part of the backup');
  assert.ok(!s.said.some((m) => /warned/.test(m)));
});

test('tar\'s warning in the log is logged, and the backup keeps the archive', async () => {
  const s = stage({ run: () => ({ archive: 'tarball', log: 'tar: ./stub/stub/asset-3d-models/a.glb: file changed as we read it\n' }) });
  const component = await s.go();
  assert.equal(component.file, `storage-objects-${STAMP}.tar.gz`);
  assert.ok(s.said.includes('  storage-objects: tar warned (a file changed while it was read): tar: ./stub/stub/asset-3d-models/a.glb: file changed as we read it'), s.said);
});

test('a failed Job fails the backup with tar\'s words, the Job\'s reason and its pod\'s, and is deleted', async () => {
  const s = stage({
    run: () => ({ archive: 'part', log: 'tar: ./x: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors\n' }),
    states: [{ status: { active: 1 } }, withConditions({ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' })],
    pods: [{ metadata: { name: 'p' }, status: { phase: 'Failed', containerStatuses: [{ name: 'archive', state: { terminated: { exitCode: 2, reason: 'Error' } } }] } }],
  });
  await assert.rejects(s.go(), (err) => {
    assert.equal(err.message,
      'tar storage-objects failed in Job aber-backup-storage-archive-20261026t023000z: tar: ./x: Cannot open: Permission denied '
      + 'tar: Exiting with failure status due to previous errors; the Job: BackoffLimitExceeded: Job has reached the specified backoff limit; '
      + 'its pod: p: Failed; archive exited 2 (Error)');
    return true;
  });
  assert.equal(s.events.at(-1), 'delete aber-backup-storage-archive-20261026t023000z');
  assert.deepEqual(s.jobs.at(-1), null);
  assert.equal(existsSync(join(s.dir, '.storage-objects.log')), false);
});

test('a Job that never runs fails the backup a minute after its deadline, naming why its pod waits', async () => {
  const s = stage({
    run: () => ({ archive: null, log: null }),
    states: [{ status: { active: 1 } }],
    pods: [{ metadata: { name: 'p' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/1 nodes are available' }] } }],
  });
  await assert.rejects(s.go(), /failed in Job aber-backup-storage-archive-20261026t023000z; the Job: it did not finish within 3660 s; its pod: p: Pending; not scheduled: 0\/1 nodes are available$/);
  assert.equal(s.events.at(-1), 'delete aber-backup-storage-archive-20261026t023000z');
});

test('a Job that completes without an archive fails the backup', async () => {
  const s = stage({ run: () => ({ archive: null, log: 'sh: can\'t create /backups/x: Permission denied\n' }) });
  await assert.rejects(s.go(), /the storage archive Job aber-backup-storage-archive-20261026t023000z completed and wrote no storage-objects-20261026T023000Z\.tar\.gz: sh: can't create/);
});

test('a Job the API refuses fails the backup and has nothing to delete', async () => {
  const s = stage({ create: async () => { throw new Error('POST job x -> 403: forbidden'); } });
  await assert.rejects(s.go(), /403: forbidden/);
  assert.deepEqual(s.events, ['read aber-backup-storage-archive']);
  assert.deepEqual(s.jobs, []);
});

// ------------------------------------------------------------------------------------------------
// The chart, the service and the library name the same things.
// ------------------------------------------------------------------------------------------------
const CHART = read('deploy/helm/aber/templates/jobs/backup-storage-archive.yaml');
const SERVICE_CHART = read('deploy/helm/aber/templates/apps/backup-service.yaml');
const SERVICE = read('scripts/backup-service.mjs');
const LIB = read('scripts/lib/backup-storage-archive.mjs');

function read(path) {
  return readFileSync(join(REPO, path), 'utf8');
}

test('the chart\'s command reads the two paths the library passes, and runs tarDirectory()\'s tar', () => {
  assert.match(LIB, /env: \{ ARCHIVE_FILE: onVolume\(out\), ARCHIVE_LOG: onVolume\(tarLog\) \}/);
  for (const name of ['ARCHIVE_FILE', 'ARCHIVE_LOG']) assert.match(CHART, new RegExp(`"\\$\\{${name}:\\?\\}"`), `${name} is required by the Job`);
  // tarDirectory(): tar -czf <out> -C <dir> . -- the archive format restore-databases.sh reads.
  assert.match(SERVICE, /run\('tar', \[appended \? '-cf' : '-czf', tarred, \.\.\.extraArgs, '-C', sourceDir, '\.'\]\)/);
  assert.match(CHART, /^\s*tar -czf "\/backups\/\$ARCHIVE_FILE" -C \/storage \. 2>>"\/backups\/\$ARCHIVE_LOG"$/m);
  // The paths are relative to the backup volume: the service's BACKUP_DIR is that volume's mount.
  assert.match(SERVICE_CHART, /- name: BACKUP_DIR\n\s*value: \/backups\n/);
  assert.match(SERVICE_CHART, /- name: backups\n\s*mountPath: \/backups\n/);
  for (const chart of [SERVICE_CHART, CHART]) {
    assert.match(chart, /- name: backups\n\s*persistentVolumeClaim:\n\s*claimName: \{\{ printf "%s-backup" \$fullname \}\}/);
  }
  // Named as tarDirectory() names every archive, which the manifest and the restore read.
  assert.match(SERVICE, /async function tarDirectory\(name, [^)]*\) \{\n\s*const file = `\$\{name\}-\$\{stamp\}\.tar\.gz`;/);
  assert.match(LIB, /const name = 'storage-objects';\n\s*const file = `\$\{name\}-\$\{stamp\}\.tar\.gz`;/);
  assert.match(SERVICE, /storage=\$\{byName\['storage-objects'\]\.file\}/, 'the text manifest names the component as before');
});

test('the CronJob is suspended, labelled for the selector, and states the user the service shares with', () => {
  assert.match(CHART, /^ {2}suspend: true$/m);
  assert.match(CHART, /^\{\{- \$component := "backup-storage-archive" -\}\}$/m);
  assert.equal((CHART.match(/include "aber\.componentLabels" \(dict "ctx" \. "component" \$component\)/g) || []).length, 3,
    'the CronJob, its jobTemplate and its pod template carry the component labels');
  assert.match(CHART, /^ {12}runAsUser: 100$/m);
  assert.match(CHART, /^ {12}runAsGroup: 101$/m);
  assert.match(CHART, /^ {12}runAsNonRoot: true$/m);
  assert.match(CHART, /^ {10}automountServiceAccountToken: false$/m);
  assert.match(CHART, /^ {6}activeDeadlineSeconds: \{\{ int \$archive\.timeoutSeconds \}\}$/m);
});

test('the service is told the CronJob the chart renders, its node and namespace, and may read it by name', () => {
  assert.match(SERVICE_CHART, /\$archiveCronJob := printf "%s-backup-storage-archive" \$fullname/);
  assert.match(CHART, /name: \{\{ printf "%s-backup-storage-archive" \$fullname \}\}/);
  assert.match(SERVICE_CHART, /- name: STORAGE_ARCHIVE_CRONJOB\n\s*value: \{\{ ternary \$archiveCronJob "" \$archiveStorage \| quote \}\}/);
  assert.match(SERVICE_CHART, /- name: NODE_NAME\n\s*valueFrom:\n\s*fieldRef:\n\s*fieldPath: spec\.nodeName/);
  assert.match(SERVICE_CHART, /- name: POD_NAMESPACE\n\s*valueFrom:\n\s*fieldRef:\n\s*fieldPath: metadata\.namespace/);
  assert.match(SERVICE_CHART, /resources: \["cronjobs"\]\n\s*resourceNames:\n\s*- \{\{ \$archiveCronJob \| quote \}\}\n\s*verbs: \["get"\]/);
  assert.match(SERVICE_CHART, /resources: \["jobs"\]\n\s*verbs: \["create", "get", "list", "delete"\]/);
  assert.doesNotMatch(SERVICE_CHART, /pods\/exec|pods\/log/);
  assert.doesNotMatch(SERVICE_CHART, /claimName: \{\{ printf "%s-storage" \$fullname \}\}/, 'the service mounts no storage volume');
});
