import { CHART_VALUES, fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 301. The upgrade note for email says what a site must do, as the chart has it: the Settings tab
// that sets it up, the values it reads and the NetworkPolicy the functions pod needs for the relay.
// A note that names a value the chart does not have sends an administrator looking for it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const upgrading = upgradingGuide();
  const note = upgrading.match(/### From 1\.8\.0, alerts can be emailed\n([\s\S]*?)\n## /)?.[1] ?? '';
  const problems301 = [];
  if (!note) problems301.push("help/site/upgrading.md has no '### From 1.8.0, alerts can be emailed' section");
  for (const said of ['Settings › Notifications', 'Set up email', 'Email a test', '`supabaseAuth.smtp`', '`secrets.smtpPassword`',
    '`supabaseFunctions.smtpCaCert`', '`networkPolicy.extraEgress`', 'supabase-functions', 'Email starts off']) {
    if (note && !note.includes(said)) problems301.push(`the email note does not say ${said}`);
  }
  for (const value of ['smtpCaCert', 'smtpPassword']) {
    if (!CHART_VALUES.includes(`${value}:`)) problems301.push(`values.yaml has no ${value}, which the email note names`);
  }
  const labels = read('frontend/src/components/tabs/NotificationsPanel.jsx');
  for (const button of ['Set up email', 'Email a test']) {
    if (!labels.includes(button)) problems301.push(`the Notifications panel has no "${button}" button, which the email note names`);
  }
  if (problems301.length) {
    fail("the email upgrade note and the chart or the page disagree:\n" + problems301.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("the upgrade note for email names the tab, both buttons, the values it reads and the functions pod's NetworkPolicy, all of which exist");
  }
}
