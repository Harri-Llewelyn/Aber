import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 28. The Backups page and the Backup Stale alert agree about when backups have stopped
//
// The page's current-state line and the rule count from the same clock; the page holds the
// threshold in hours, the rule in seconds. Between two different numbers one surface says backups
// are working while the other pages somebody.
export default function check() {
  const page = read('frontend/src/components/tabs/BackupsTab.jsx')
    .match(/BACKUP_STALE_HOURS\s*=\s*(\d+)/)?.[1];
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const at = rules.indexOf('uid: aber-backup-stale');
  // The evaluator inside the rule: the first `params: [n]` after its uid.
  const alert = at === -1 ? undefined : rules.slice(at).match(/type:\s*gt\s*\n\s*params:\s*\[(\d+)\]/)?.[1];

  if (!page || !alert) {
    fail(
      `the backup staleness threshold could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `alert: ${alert || 'MISSING'}). One of them has been renamed or removed, and the other is ` +
        'now the only definition of a threshold two surfaces are meant to share.'
    );
  } else if (Number(page) * 3600 !== Number(alert)) {
    fail(
      `the Backups page calls backups stopped after ${page} hours (${Number(page) * 3600}s) and the ` +
        `Backup Stale alert fires above ${alert}s. Between those numbers one surface says backups ` +
        'are working while the other pages somebody.'
    );
  } else {
    pass(`the backup staleness threshold is ${page} hours on the Backups page and in its alert rule`);
  }
}
