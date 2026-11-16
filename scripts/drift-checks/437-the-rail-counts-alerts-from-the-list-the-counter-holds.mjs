import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 437. The rail's alert counts read the list the header's counter already holds. App.jsx hands
// useNavSignals the firing alerts usePlatformAlerts returned; the hook makes no read of an alerts
// table and opens no channel of its own. The count is of devices or gateways, with the counter's
// rule (unacknowledged and not suppressed), for a viewer the counter's Acknowledge button is offered
// to. The rail has a danger style beside its warning one, in both themes, and a test holds it to AA.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems437 = [];
  const app = read('frontend/src/App.jsx');
  const hook = read('frontend/src/hooks/useNavSignals.js');
  const util = read('frontend/src/utils/navSignal.js');
  const css = read('frontend/src/App.css');

  if (!/useNavSignals\(\{[^}]*alerts: firingAlerts[^}]*\}\)/.test(app)) problems437.push('App.jsx does not hand useNavSignals the firing alerts usePlatformAlerts keeps');
  if (!/const firingAlerts = usePlatformAlerts\(/.test(app)) problems437.push('App.jsx no longer reads the firing alerts with usePlatformAlerts, which the rail\'s counts are handed');
  for (const forbidden of [/platform_alerts/, /^import[^\n]*supabase/m, /usePlatformAlerts\(/, /\.channel\(/, /api\.get\('\/api\/v1\/alerts/]) {
    if (forbidden.test(hook)) problems437.push(`useNavSignals.js touches ${forbidden}: the alert counts are handed in, not read again`);
  }
  if (!/mayAcknowledge\(userRole\)/.test(hook)) problems437.push('useNavSignals.js does not show the alert counts by mayAcknowledge(), the check the counter\'s Acknowledge button uses');
  if (/Shopfloor_Manager|Administrator/.test(hook)) problems437.push('useNavSignals.js names a role: who sees the alert counts is mayAcknowledge()\'s answer');
  if (!/countedAlerts\(alerts\)/.test(util)) problems437.push('utils/navSignal.js does not count the alerts the counter counts (countedAlerts)');

  const blocks = css.split('[data-theme="light"] {');
  const dark = blocks[0];
  const light = blocks[1]?.slice(0, blocks[1].indexOf('\n}')) ?? '';
  for (const [name, text] of [['dark', dark], ['light', light]]) {
    if (!/--danger-contrast:/.test(text)) problems437.push(`App.css has no --danger-contrast in the ${name} theme, the ink of a rail count filled with --danger`);
  }
  for (const selector of ['.sidebar-item.sidebar-item-danger:not(.active)', '.sidebar-tab.sidebar-tab-danger:not(.active)', '.sidebar-item-count-danger', '.sidebar-tab-count-danger']) {
    if (!css.includes(`${selector} {`)) problems437.push(`App.css has no rule for ${selector}, the rail's danger tone`);
  }
  if (!read('frontend/src/__tests__/railDangerContrast.test.js').includes('--danger-contrast')) problems437.push('railDangerContrast.test.js no longer holds the rail\'s danger count to AA');

  if (problems437.length) {
    fail('the rail\'s alert counts and the header\'s counter disagree:\n' + problems437.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the rail\'s alert counts read the list the counter holds, by mayAcknowledge(), counting devices and gateways, in a danger tone that a test holds to AA');
  }
}
