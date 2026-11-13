import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 364. An acknowledger and a window's author are drawn through one helper, with the names read once for
// the list. The counter's list, the drawer's banner, History's Alerts tab and the drawer's Suppression
// windows draw them with PersonName's emailOnHover, and none reads an email straight from the row
// again; the names arrive through useDisplayNames, once for the list (usePlatformAlerts for the
// counter and the banner). A place that went back to printing the email is an Operator reading
// j.smith@site.local where everywhere else the dashboard says Jane Smith.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const drawn = {
    'frontend/src/components/common/AlertPill.jsx': ['<PersonName', 'emailOnHover', 'acknowledged_by_name'],
    'frontend/src/components/common/ContextPanel.jsx': ['<PersonName', 'emailOnHover', 'acknowledged_by_name'],
    'frontend/src/components/tabs/HistoryAlerts.jsx': ['<PersonName', 'emailOnHover', 'useDisplayNames(', 'withAcknowledgerNames('],
    'frontend/src/components/common/SuppressionWindows.jsx': ['<PersonName', 'emailOnHover', 'useDisplayNames('],
    'frontend/src/hooks/usePlatformAlerts.js': ['useDisplayNames(', 'withAcknowledgerNames('],
    'frontend/src/components/tabs/DevicesTab.jsx': ['acknowledgerName(alert)'],
  };
  const straight = /(?:acknowledged_by_email|created_by_email|ended_by_email) \|\| '/;
  const problems364 = [];
  for (const [file, parts] of Object.entries(drawn)) {
    const text = read(file);
    for (const part of parts) {
      if (!text.includes(part)) problems364.push(`${file} does not use ${part}`);
    }
    if (straight.test(text)) problems364.push(`${file} prints an email straight from the row, where PersonName names the person by display name`);
  }
  const readme = read('frontend/README.md');
  if (!readme.includes('The acknowledger is named by display name, with their email as its tooltip')) {
    problems364.push('frontend/README.md does not say the acknowledger is named by display name with their email as its tooltip');
  }
  if (problems364.length) {
    fail(`an acknowledger or a window's author is not drawn through the one helper:\n${problems364.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass("the counter, the banner, History's Alerts tab, the Devices table and the Suppression windows draw who acknowledged an alert or scheduled a window by display name with the email as a tooltip, one read for each list");
  }
}
