import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 368. The Gateways drawer shows only the rows a gateway's kind can fill, and the documents say
// which. utils/gatewayType.js holds the rule once, as NEVER_FILLED_ROWS keyed on the kind: a Remote
// gateway hides nothing, a Host or Simulated one hides the seven appliance rows and the three forge
// rows, Playback and Third-party hide the health rows too. Every label in it is a row the drawer
// draws, GatewaysTab filters its fields through it, and no condition on the Third-party kind sits
// beside a row any more. The help names the two rows a Host gateway keeps, and the README names the
// table.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { NEVER_FILLED_ROWS, GATEWAY_TYPES } = await import((await import('node:url')).pathToFileURL(join(REPO, 'frontend/src/utils/gatewayType.js')).href);
  const tab = read('frontend/src/components/tabs/GatewaysTab.jsx');
  const help = read('help/pages/gateways.md');
  const readme = read('frontend/README.md');
  const problems368 = [];
  const APPLIANCE = ['CA Expires', 'Disk Free', 'Memory Available', 'Load (1m)', 'Flow', 'Platform', 'Custom'];
  const FORGE = ['Bundle', 'Committed', 'Reported'];
  const HEALTH = ['Health Reported', 'Runtime Uptime'];
  const same = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const expected = {
    [GATEWAY_TYPES.REMOTE]: [],
    [GATEWAY_TYPES.HOST]: [...FORGE, ...APPLIANCE],
    [GATEWAY_TYPES.SIMULATED]: [...FORGE, ...APPLIANCE],
    [GATEWAY_TYPES.PLAYBACK]: [...FORGE, ...HEALTH, ...APPLIANCE],
    [GATEWAY_TYPES.THIRD_PARTY]: [...FORGE, ...HEALTH, ...APPLIANCE],
  };
  for (const [kind, rows] of Object.entries(expected)) {
    if (!NEVER_FILLED_ROWS[kind] || !same(NEVER_FILLED_ROWS[kind], rows)) {
      problems368.push(`NEVER_FILLED_ROWS for ${kind} is [${(NEVER_FILLED_ROWS[kind] ?? []).join(', ')}], not [${rows.join(', ')}]`);
    }
  }
  const drawn = new Set([...tab.matchAll(/^\s*label: '([^']+)',?$/gm)].map((m) => m[1]));
  for (const label of new Set(Object.values(NEVER_FILLED_ROWS).flat())) {
    if (!drawn.has(label)) problems368.push(`NEVER_FILLED_ROWS names "${label}", which GatewaysTab.jsx no longer draws as a row`);
  }
  if (!/\]\.filter\(f => gatewayShowsRow\(selected, f\.label\)\) : \[\]\}/.test(tab)) problems368.push('GatewaysTab.jsx does not filter its drawer fields through gatewayShowsRow()');
  if (/THIRD_PARTY \? \[\] : \[/.test(tab) || /health_reported_at && gatewayType\(selected\) !== GATEWAY_TYPES\.THIRD_PARTY/.test(tab)) {
    problems368.push('GatewaysTab.jsx tests the Third-party kind beside a row again: the rule is NEVER_FILLED_ROWS alone');
  }
  const drawer = help.slice(help.indexOf('- **The drawer** opens'), help.indexOf('- **Publishes under group X'));
  if (!drawer.includes('A Host or Simulated gateway has no appliance, so once it reports it shows only **Health Reported** and **Runtime Uptime**.')) {
    problems368.push('help/pages/gateways.md does not say a Host or Simulated gateway shows only Health Reported and Runtime Uptime');
  }
  if (!drawer.includes('The Playback gateway shows neither.')) problems368.push('help/pages/gateways.md does not say the Playback gateway shows neither health row');
  if (!readme.includes('`NEVER_FILLED_ROWS`') || !readme.includes('`gatewayShowsRow()`')) problems368.push('frontend/README.md does not name NEVER_FILLED_ROWS and gatewayShowsRow()');
  if (!readme.includes('A row the item\'s kind can never fill is not shown.')) problems368.push('frontend/README.md does not state the rule beside the drawer\'s other rules');
  if (problems368.length) {
    fail('the Gateways drawer\'s rows by kind and the documents disagree:\n' + problems368.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Gateways drawer hides the ${NEVER_FILLED_ROWS[GATEWAY_TYPES.HOST].length} rows a Host or Simulated gateway can never fill and the ${NEVER_FILLED_ROWS[GATEWAY_TYPES.THIRD_PARTY].length} a Playback or Third-party one cannot, from one table, and the help and the README say so`);
  }
}
