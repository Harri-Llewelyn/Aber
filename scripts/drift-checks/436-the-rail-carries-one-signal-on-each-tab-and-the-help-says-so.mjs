import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 436. The rail carries one signal on each tab of a page, and the documents say what each counts.
// navigation.jsx names the tab each part of a page's signal is about (signalTabs): Devices carries
// its firing alerts on Registered and its quarantine on Quarantine, and each is a tab the page
// lists. The help says what the red and the amber number count and that they are never added; the
// README says how a part reaches a tab, and who sees the alert count.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems436 = [];
  const nav = read('frontend/src/navigation.jsx');
  const hook = read('frontend/src/hooks/useNavSignals.js');
  const devicesHelp = read('help/pages/devices.md');
  const gatewaysHelp = read('help/pages/gateways.md');
  const siteMapHelp = read('help/pages/site-map.md');
  const readme = read('frontend/README.md');

  const devicesRow = nav.split('\n').find((l) => /\{ id: 'devices',/.test(l)) ?? '';
  const claim = devicesRow.match(/signalTabs: \{([^}]*)\}/)?.[1].replace(/\s+/g, ' ').trim();
  if (claim !== "alerts: 'registered', quarantine: 'quarantine'") {
    problems436.push(`navigation.jsx gives Devices signalTabs { ${claim} }, not { alerts: 'registered', quarantine: 'quarantine' }`);
  }
  const devicesTabs = nav.slice(nav.indexOf('export const DEVICES_TABS'), nav.indexOf('export const APPROVALS_TABS'));
  for (const id of ['registered', 'quarantine']) {
    if (!devicesTabs.includes(`{ id: '${id}',`)) problems436.push(`DEVICES_TABS has no "${id}" tab, which a Devices signal is carried on`);
  }
  if (/\bsignalTab:/.test(nav)) problems436.push('navigation.jsx still names a page\'s one signalTab: a page carries signalTabs, one for each of its signals');
  if (!/alerts: \{ tone: 'danger'/.test(hook)) problems436.push('useNavSignals.js does not make a firing alert a danger part');

  const phrases = [
    [devicesHelp, 'help/pages/devices.md', 'A red number counts the devices with a firing alert that nobody has acknowledged'],
    [devicesHelp, 'help/pages/devices.md', 'never adds the two numbers together'],
    [devicesHelp, 'help/pages/devices.md', 'the red number sits on **Registered** and the amber one on **Quarantine**'],
    [gatewaysHelp, 'help/pages/gateways.md', 'It turns red while a gateway has a firing alert that nobody has acknowledged.'],
    [siteMapHelp, 'help/pages/site-map.md', 'A firing alert that nobody has acknowledged turns the page red'],
    [siteMapHelp, 'help/pages/site-map.md', 'Registered and Quarantine under Devices'],
    [readme, 'frontend/README.md', '`signalTabs` names the tab each'],
    [readme, 'frontend/README.md', 'A firing alert is `danger`.'],
  ];
  for (const [text, file, phrase] of phrases) {
    if (!text.includes(phrase)) problems436.push(`${file} does not say "${phrase}"`);
  }
  if (problems436.length) {
    fail('the rail\'s signals on each tab and the documents disagree:\n' + problems436.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the rail carries Devices\' firing alerts on Registered and its quarantine on Quarantine, and the Devices, Gateways and Site Map help and the README say what each number counts');
  }
}
