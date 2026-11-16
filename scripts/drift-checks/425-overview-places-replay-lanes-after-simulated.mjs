import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 425. Overview's Replay lanes group sits after Simulated and before Unassigned, and the page leaves it
// out until the check is on. overviewGroups() lists the groups that are lanes of their own in that
// order, the replay lanes among them from the devices the Playback gateway serves (a group, never a
// real area or cell). HistoryOverview filters the group out by REPLAY_LANES_GROUP unless the check is
// on, and the History help and the README name the groups in the same order.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems425 = [];
  const history = read('frontend/src/utils/history.js');
  const list = history.match(/const OVERVIEW_LANES = \[([\s\S]*?)\n\]/)?.[1] ?? '';
  const labels = [...list.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const order = ['Site-Wide', 'Simulated', 'Replay lanes', 'Unassigned'];
  if (!list) problems425.push('frontend/src/utils/history.js has no OVERVIEW_LANES list');
  else if (labels.join(', ') !== order.join(', ')) {
    problems425.push(`OVERVIEW_LANES lists ${labels.join(', ')}; Overview's groups after the areas and cells are ${order.join(', ')}`);
  }
  if (!history.includes('export const REPLAY_LANES_GROUP = SOURCE_SHADOW')) {
    problems425.push("history.js does not key the Replay lanes group by the 'shadow' location source");
  }

  const overview = read('frontend/src/components/tabs/HistoryOverview.jsx');
  if (!overview.includes('g.key !== REPLAY_LANES_GROUP')) problems425.push('HistoryOverview.jsx does not leave the Replay lanes group out while the check is off');
  if (!overview.includes('showLanes ? everyGroup :')) problems425.push('HistoryOverview.jsx does not show the Replay lanes group when the check is on');

  const help = read('help/pages/history.md');
  if (!help.includes('**Site-Wide**, **Simulated**, **Replay lanes** and **Unassigned**')) {
    problems425.push('help/pages/history.md does not name the groups as Site-Wide, Simulated, Replay lanes and Unassigned');
  }
  if (!read('frontend/README.md').includes('Simulated, Replay lanes and Unassigned')) {
    problems425.push('frontend/README.md does not name the groups as Simulated, Replay lanes and Unassigned');
  }

  if (problems425.length) {
    fail("Overview's Replay lanes group is not where, or as hidden as, its help says:\n" + problems425.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('Overview places Replay lanes after Simulated and before Unassigned, from the shadow location source, leaves the group out until the check is on, and the help and the README name the same order');
  }
}
