import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 80. Every Job and CronJob in the chart starts with an init container that waits for what it
// connects to. Under a NetworkPolicy a new pod's first connections are refused for about a second,
// until the policy controller admits the pod, so a run that connects at once fails, or reads no
// settings and carries on without them. The wait is aber.waitFor or aber.waitForPostgres. An
// exception is listed with the text in its template that does the waiting instead, which must still
// be there. The helm-test pods are not Jobs, and each retries in its own script.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = 'deploy/helm/aber/templates/';
  const HELPER = /include "aber\.waitFor(?:Postgres)?"/;
  const EXCEPTIONS = {
    'jobs/claim-templates-hook.yaml': [/for attempt in range\(\d+\):[\s\S]*?except OSError/,
      'it reaches only the API server, and retries each call itself'],
    'jobs/e2e-aas-export-job.yaml': [/initContainers:\s*- name: wait-for-validate\b/,
      'its first init container polls the API server until the validate Job has passed'],
    'jobs/timescaledb-maintenance.yaml': [/initContainers:\s*- name: wait-for-telemetry-table\b/,
      'its first init container retries psql until the historian holds the telemetry hypertable'],
  };
  const indent = (l) => l.match(/^ */)[0].length;
  const skip = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*\{\{.*\}\}\s*$/.test(l);
  const files = allFiles.filter((f) => f.startsWith(TEMPLATES) && /\.ya?ml$/.test(f));
  const bad = [];
  const jobs = new Set();
  const waited = [];
  const excepted = new Set();
  for (const f of files) {
    const rel = f.slice(TEMPLATES.length);
    // Template comments are blanked with their line breaks kept, so the line numbers stay true.
    const text = read(f).replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (c) => c.replace(/[^\n]/g, ''));
    const lines = text.split('\n');
    let start = 0;
    lines.forEach((line, i) => {
      if (/^---\s*$/.test(line)) start = i + 1;
      const kind = line.match(/^kind:\s*(Job|CronJob)\s*$/);
      if (!kind) return;
      jobs.add(rel);
      let end = i;
      while (end + 1 < lines.length && !/^---\s*$/.test(lines[end + 1])) end += 1;
      const doc = lines.slice(start, end + 1);
      const at = doc.findIndex((l) => /^ *initContainers:\s*$/.test(l));
      // The init block: every line under `initContainers:`, template actions included, up to the
      // next key at its indent or shallower.
      let block = '';
      for (let j = at + 1; at >= 0 && j < doc.length && (skip(doc[j]) || indent(doc[j]) > indent(doc[at])); j++) block += `${doc[j]}\n`;
      const where = `${f}:${i + 1}`;
      const exception = EXCEPTIONS[rel];
      if (HELPER.test(block)) {
        waited.push(rel);
        if (exception) bad.push(`${where}: the ${kind[1]} now waits through aber.waitFor or aber.waitForPostgres, so its exception here is stale`);
      } else if (!exception) {
        bad.push(`${where}: the ${kind[1]} has no init container from aber.waitFor or aber.waitForPostgres`);
      } else if (!exception[0].test(doc.join('\n'))) {
        bad.push(`${where}: the ${kind[1]} is an exception because ${exception[1]}, and its template no longer matches ${exception[0]}`);
      } else {
        excepted.add(rel);
      }
    });
  }
  for (const rel of Object.keys(EXCEPTIONS)) {
    if (!jobs.has(rel)) bad.push(`check 80 names ${TEMPLATES}${rel} as an exception, and it defines no Job or CronJob`);
  }
  if (waited.length < 5) {
    fail(`check 80 found ${waited.length} Job or CronJob template(s) with a helper wait under ${TEMPLATES}, so it reads nothing`);
  } else if (bad.length) {
    fail(`a Job or CronJob connects at start without a wait for what it reaches:\n${bad.map((x) => `        ${x}`).join('\n')}`);
  } else {
    pass(`the chart's ${waited.length} Jobs and CronJobs with a helper wait, and ${excepted.size} named exceptions, each wait before they connect`);
  }
}
