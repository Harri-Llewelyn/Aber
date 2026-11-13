import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 240. History's Alerts tab is described as the code holds it. Its help names the most alerts it
// lists (ALERT_HISTORY_LIMIT) and how long alerts are kept (0002's seed), and the upgrade guide's
// 1.8.0 subsection names the same days, which the tab falls back to (ALERT_RETENTION_DAYS).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/history.md';
  const GUIDE = 'help/site/upgrading.md';
  const limit = read('frontend/src/api.js').match(/^export const ALERT_HISTORY_LIMIT = (\d+);$/m)?.[1];
  const days = read('supabase/migrations/0002_seed_data.sql').match(/seed_setting\(\s*'alerts\.retention_days',\s*to_jsonb\((\d+)\)/)?.[1];
  const help = read(HELP);
  const alerts = help.slice(help.indexOf('\n## Alerts\n'), help.indexOf('\n## ', help.indexOf('\n## Alerts\n') + 1));
  const guide = upgradingGuide();
  const problems240 = [];
  if (!limit || !days) problems240.push('could not read ALERT_HISTORY_LIMIT in frontend/src/api.js or the seeded alerts.retention_days');
  if (!help.includes('\n## Alerts\n')) problems240.push(`${HELP}: no "Alerts" section`);
  if (limit && !alerts.includes(`at most ${Number(limit).toLocaleString('en-GB')} alerts`)) problems240.push(`${HELP}: the Alerts section does not say it lists at most ${Number(limit).toLocaleString('en-GB')} alerts`);
  if (days && !alerts.includes(`**Alerts are kept for ${days} days.**`)) problems240.push(`${HELP}: the Alerts section does not say alerts are kept for ${days} days`);
  if (days && !guide.includes(`\n### From 1.8.0, alert history is kept for ${days} days\n`)) problems240.push(`${GUIDE}: no "From 1.8.0, alert history is kept for ${days} days" subsection`);
  if (problems240.length) {
    fail("History's Alerts tab and its help disagree:\n" + problems240.map((p) => `      - ${p}`).join('\n'));
  } else {
    pass(`History's help says the Alerts tab lists at most ${Number(limit).toLocaleString('en-GB')} alerts, kept for ${days} days, as the upgrade guide does`);
  }
}
