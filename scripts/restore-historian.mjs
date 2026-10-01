#!/usr/bin/env node
/**
 * Restore the historian from its pgBackRest repository (timescaledb.physicalBackup).
 *
 *   node scripts/restore-historian.mjs --info                       # what the repository holds
 *   node scripts/restore-historian.mjs                              # the latest: every archived WAL
 *   node scripts/restore-historian.mjs --target "2026-09-23 14:05:00+00"   # a moment
 *   node scripts/restore-historian.mjs --set 20260920-010002F       # one backup, no WAL after it
 *
 * Stops the historian, restores its data directory in a pod built from the StatefulSet's own
 * backup sidecar (same image, configuration and credentials, with the data volume), starts it
 * again, and waits for recovery to replay the WAL and promote. Readings written after the target
 * are gone; ingestion reconnects on its own and carries on from now. The platform database is not
 * touched: after a whole-stack loss, restore the historian first, then run
 * scripts/restore-databases.sh, whose manifest reads timescaledb=physical.
 *
 * --yes skips the confirmation. ABER_NAMESPACE selects the namespace (default aber). Prints how
 * long the restore and the recovery each took. Runbook: deploy/k8s/README.md, "Backing up the
 * historian".
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const NAMESPACE = process.env.ABER_NAMESPACE || 'aber';
const STS = 'timescaledb';
const POD = `${STS}-0`;
const RESTORE_POD = `${STS}-restore`;

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
};
const flag = (name) => argv.includes(`--${name}`);
const die = (message) => { console.error(`\n${message}`); process.exit(1); };
const step = (message) => console.log(`\n=== ${message}`);

function kubectl (args, { input, allowFail = false, inherit = false } = {}) {
  const r = spawnSync('kubectl', ['-n', NAMESPACE, ...args], {
    input, encoding: 'utf8', maxBuffer: 1 << 26, stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0 && !allowFail) die(`kubectl ${args.join(' ')} failed:\n${r.stderr || ''}`);
  return r;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (from) => Math.round((Date.now() - from) / 1000);

const target = option('target');
const set = option('set');
if (target && set) die('--target and --set are alternatives: a backup set, or a moment reached through WAL.');

const sts = JSON.parse(kubectl(['get', 'statefulset', STS, '-o', 'json']).stdout);
const template = sts.spec.template.spec;
const sidecar = template.containers.find((c) => c.name === 'pgbackrest');
if (!sidecar) die(`${STS} has no pgbackrest container: timescaledb.physicalBackup is not enabled on this release.`);
if (!sts.spec.volumeClaimTemplates?.some((v) => v.metadata.name === 'data')) {
  die(`${STS} keeps its data on no persistent volume (timescaledb.persistence.enabled is false); there is nothing to restore into.`);
}

if (flag('info')) {
  kubectl(['exec', POD, '-c', 'pgbackrest', '--', 'pgbackrest', '--stanza=historian', 'info'], { inherit: true });
  process.exit(0);
}

const mode = target ? `to ${target}` : set ? `backup ${set}, no WAL after it` : 'to the latest archived WAL';
console.log(`Restoring the historian in namespace ${NAMESPACE} ${mode}.`);
console.log('The historian stops for the duration, and readings written after the target are lost.');
if (!flag('yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const reply = await rl.question('Type RESTORE to continue: ');
  rl.close();
  if (reply.trim() !== 'RESTORE') die('Aborted; nothing was changed.');
}

step(`stopping ${STS}`);
kubectl(['scale', 'statefulset', STS, '--replicas=0']);
kubectl(['wait', '--for=delete', `pod/${POD}`, '--timeout=300s'], { allowFail: true });

// The restore command. pgBackRest refuses a data directory that does not exist, which is the state
// after the volume itself was lost; --delta reuses whatever files still match the backup.
const restoreArgs = ['--stanza=historian', '--delta', '--process-max=' + (process.env.RESTORE_PROCESS_MAX || '4')];
if (target) restoreArgs.push('--type=time', `--target=${target}`, '--target-action=promote');
if (set) restoreArgs.push(`--set=${set}`, '--type=immediate', '--target-action=promote');
const pgdata = '/var/lib/postgresql/data/pgdata';
const script = `mkdir -p ${pgdata} && chmod 700 ${pgdata} && exec pgbackrest ${restoreArgs.map((a) => `'${a}'`).join(' ')} restore`;

const volumes = template.volumes
  .filter((v) => v.name !== 'init')
  .concat([{ name: 'data', persistentVolumeClaim: { claimName: `data-${POD}` } }]);
const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: RESTORE_POD, labels: { 'app.kubernetes.io/part-of': 'aber', 'app.kubernetes.io/component': 'timescaledb-restore' } },
  spec: {
    restartPolicy: 'Never',
    securityContext: template.securityContext,
    imagePullSecrets: template.imagePullSecrets,
    nodeSelector: template.nodeSelector,
    tolerations: template.tolerations,
    affinity: template.affinity,
    containers: [{
      name: 'restore',
      image: sidecar.image,
      imagePullPolicy: sidecar.imagePullPolicy,
      securityContext: sidecar.securityContext,
      env: sidecar.env,
      command: ['/bin/sh', '-c', script],
      volumeMounts: sidecar.volumeMounts.filter((m) => m.name !== 'pgbackrest-script'),
    }],
    volumes,
  },
};

step(`restoring the data directory (${restoreArgs.slice(1).join(' ')})`);
kubectl(['delete', 'pod', RESTORE_POD, '--ignore-not-found', '--wait=true']);
const restoreStarted = Date.now();
kubectl(['apply', '-f', '-'], { input: JSON.stringify(pod) });
let phase = '';
for (let missing = 0; !['Succeeded', 'Failed'].includes(phase);) {
  await sleep(3000);
  const r = kubectl(['get', 'pod', RESTORE_POD, '-o', 'jsonpath={.status.phase}'], { allowFail: true });
  phase = r.stdout.trim();
  missing = r.status === 0 ? 0 : missing + 1;
  if (missing >= 10) die(`The restore pod ${RESTORE_POD} disappeared; ${STS} is left at 0 replicas. Run this again.`);
}
const restoreSeconds = seconds(restoreStarted);
process.stdout.write(kubectl(['logs', RESTORE_POD], { allowFail: true }).stdout);
kubectl(['delete', 'pod', RESTORE_POD, '--wait=false']);
if (phase !== 'Succeeded') {
  die(`The restore failed after ${restoreSeconds}s; ${STS} is left at 0 replicas so nothing starts on a half-restored directory.\n`
    + `Fix the cause (the log above), then run this again: --delta resumes from the files already in place.`);
}

step(`starting ${STS}; recovery replays the archived WAL and promotes`);
const recoveryStarted = Date.now();
// One, not the count found at start: that is 0 after a failed attempt, and the historian is never
// more than one replica.
kubectl(['scale', 'statefulset', STS, '--replicas=1']);
for (;;) {
  await sleep(5000);
  const ready = kubectl(['get', 'pod', POD, '-o', 'jsonpath={.status.containerStatuses[?(@.name=="timescaledb")].ready}'], { allowFail: true }).stdout.trim();
  if (ready !== 'true') continue;
  const r = kubectl(['exec', POD, '-c', 'timescaledb', '--', 'psql', '-XtAc', 'SELECT pg_is_in_recovery()', '-U', 'postgres'], { allowFail: true });
  if (r.status === 0 && r.stdout.trim() === 'f') break;
}
const recoverySeconds = seconds(recoveryStarted);

const summary = kubectl(['exec', POD, '-c', 'timescaledb', '--', 'psql', '-XtAc',
  "SELECT pg_size_pretty(pg_database_size(current_database())) || ', timeline ' || timeline_id FROM pg_control_checkpoint()",
  '-U', 'postgres'], { allowFail: true }).stdout.trim();
console.log(`\nRestored ${mode}: ${summary}.`);
console.log(`  restore  ${restoreSeconds}s  (pgBackRest writing the data directory)`);
console.log(`  recovery ${recoverySeconds}s  (start, WAL replay and promotion)`);
console.log('The backup sidecar takes its next backup on schedule; a new timeline starts a new WAL history, which is expected.');
