import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 191. A failed or stuck capture or playback, and a silent playback worker, reach someone. The last
// declaration of platform_health_rows() has the three arms 0226 added, and each has a Platform
// Conditions rule that reads it from platform_health as a platform alert. The stale-worker arm is
// gated on a queued or running playback: its row is seeded at the epoch, and a site that runs no
// worker would alert for ever on the age alone. Comments are stripped, so only the SQL counts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const declaration = /CREATE OR REPLACE FUNCTION\s+public\.platform_health_rows\s*\(\)[\s\S]*?\bAS\s+(\$[a-z_]*\$)([\s\S]*?)\1/gi;
  let last = null;
  for (const name of files) {
    for (const m of read(`${dir}/${name}`).matchAll(declaration)) last = { name, body: m[2] };
  }
  const sql = last ? last.body.replace(/--[^\n]*/g, '') : '';
  const rules = Object.fromEntries(read('grafana/provisioning/alerting/alert-rules.yaml')
    .split(/^ {6}- uid: /m).slice(1).map((block) => [block.split('\n')[0].trim(), block]));
  const ARMS = { job_failed: 'aber-job-failed', job_stuck: 'aber-job-stuck', playback_worker_stale: 'aber-playback-worker-stale' };

  const wrong = [];
  for (const [condition, uid] of Object.entries(ARMS)) {
    if (!sql.includes(`'${condition}'::text`)) {
      wrong.push(`platform_health_rows() has no ${condition} arm${last ? ` (last declared in ${last.name})` : ''}`);
    }
    const rule = rules[uid];
    if (!rule) {
      wrong.push(`no rule ${uid} reads ${condition}`);
    } else if (!/FROM public\.platform_health\b/.test(rule) || !rule.includes(`WHERE condition = '${condition}'`)) {
      wrong.push(`${uid} does not read platform_health's ${condition} rows`);
    } else if (!/^ {10}entity_type: platform$/m.test(rule)) {
      wrong.push(`${uid} is not entity_type: platform, so the webhook would look for an asset it names`);
    }
  }
  const staleArm = sql.slice(sql.indexOf("'playback_worker_stale'::text"));
  if (sql.includes("'playback_worker_stale'::text")
      && !/EXISTS\s*\(\s*SELECT 1 FROM public\.playback_jobs p WHERE p\.status IN \('PENDING', 'RUNNING'\)\s*\)/.test(staleArm)) {
    wrong.push(`${last.name}'s playback_worker_stale arm is not gated on a queued or running playback. Its heartbeat row is `
      + 'seeded at the epoch, so a site with playback.enabled: false would raise Playback Worker Not Reporting for ever');
  }

  if (wrong.length) {
    fail(`a failed or stuck job, or a silent playback worker, would reach no one:\n      ${wrong.join('\n      ')}`);
  } else {
    pass(`platform_health_rows()'s last declaration (${last.name}) reports failed and stuck jobs and a silent playback `
      + 'worker, only while a playback waits, and a Platform Conditions rule reads each');
  }
}
