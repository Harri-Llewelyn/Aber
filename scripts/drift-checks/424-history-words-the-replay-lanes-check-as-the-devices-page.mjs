import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 424. History words its Show replay lanes check as the Devices page does, from one module. The
// label, the tip and the address key are held by utils/replayLanes.js; the Devices page draws the
// check from them and keeps its address key as the module names it, and History's Overview, its
// Device tab's picker and its device switcher draw ReplayLanesCheck, which draws the same. No page
// writes the label or the tip again, so the three places cannot drift from the Devices page's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems424 = [];
  const mod = read('frontend/src/utils/replayLanes.js');
  const label = mod.match(/export const REPLAY_LANES_LABEL = '([^']+)'/)?.[1];
  const key = mod.match(/export const REPLAY_LANES_PARAM = '([^']+)'/)?.[1];
  const tip = mod.match(/export const REPLAY_LANES_TIP =\s*'([^']+)'/)?.[1];
  if (!label) problems424.push('frontend/src/utils/replayLanes.js does not export REPLAY_LANES_LABEL');
  if (!key) problems424.push('frontend/src/utils/replayLanes.js does not export REPLAY_LANES_PARAM');
  if (!tip) problems424.push('frontend/src/utils/replayLanes.js does not export REPLAY_LANES_TIP');

  const devices = read('frontend/src/components/tabs/DevicesTab.jsx');
  if (!devices.includes('label={REPLAY_LANES_LABEL}') || !devices.includes('tip={REPLAY_LANES_TIP}')) {
    problems424.push('DevicesTab.jsx does not draw its Show replay lanes check from REPLAY_LANES_LABEL and REPLAY_LANES_TIP');
  }
  if (key && !devices.includes(`useUrlState('${key}', false)`)) {
    problems424.push(`DevicesTab.jsx does not keep its replay-lanes check under the key '${key}' that REPLAY_LANES_PARAM names`);
  }

  const component = read('frontend/src/components/common/ReplayLanesCheck.jsx');
  if (!component.includes('label={REPLAY_LANES_LABEL}') || !component.includes('tip={REPLAY_LANES_TIP}')) {
    problems424.push('ReplayLanesCheck.jsx does not draw its check from REPLAY_LANES_LABEL and REPLAY_LANES_TIP');
  }

  const history = {
    overview: read('frontend/src/components/tabs/HistoryOverview.jsx'),
    tab: read('frontend/src/components/tabs/HistoryTab.jsx'),
    device: read('frontend/src/components/tabs/HistoryDevice.jsx'),
  };
  for (const [name, src] of Object.entries(history)) {
    const file = `History${name === 'tab' ? 'Tab' : name === 'overview' ? 'Overview' : 'Device'}.jsx`;
    if (!src.includes('<ReplayLanesCheck')) problems424.push(`${file} does not offer the Show replay lanes check through ReplayLanesCheck`);
    if (label && src.includes(`label="${label}"`)) problems424.push(`${file} writes the label '${label}' itself, instead of drawing ReplayLanesCheck`);
    if (tip && src.includes(`tip="${tip}"`)) problems424.push(`${file} writes the replay lanes tip itself, instead of drawing ReplayLanesCheck`);
  }
  for (const name of ['overview', 'tab']) {
    if (!history[name].includes('useUrlState(REPLAY_LANES_PARAM, false)')) {
      problems424.push(`History${name === 'tab' ? 'Tab' : 'Overview'}.jsx does not keep the check in the address under REPLAY_LANES_PARAM`);
    }
  }

  const help = read('help/pages/history.md');
  if (label && !help.includes(`**${label}**`)) problems424.push(`help/pages/history.md does not name **${label}**`);
  if (key && !read('frontend/README.md').includes(`\`?${key}=1\``)) problems424.push(`frontend/README.md does not name the address key ?${key}=1`);

  if (problems424.length) {
    fail("History's replay lanes check is worded apart from the Devices page's:\n" + problems424.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("History's Overview, its Device tab's picker and its switcher draw the Devices page's Show replay lanes check from one module, under the same address key, and the help and the README name it");
  }
}
