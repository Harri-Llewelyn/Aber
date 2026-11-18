import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 469. The Gateways drawer reads what arrives from a gateway in two reads, and the documents say
// so. useGatewayArrivals() starts the Prometheus figures and the devices' last readings as two
// calls inside one Promise.allSettled, so a historian that cannot be read leaves the figures
// standing, and neither read throws. The drawer draws the three rows by the names the help page
// gives, and the help and the README say what Not observed means.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems469 = [];
  const hook = read('frontend/src/hooks/useGatewayArrivals.js');
  const tab = read('frontend/src/components/tabs/GatewaysTab.jsx');
  const help = read('help/pages/gateways.md');
  const readme = read('frontend/README.md');
  const ROWS = ['Messages Per Second (5m)', 'Sequence Gaps (1h)', 'Messages Missed (1h)'];

  const from = hook.indexOf('Promise.allSettled([');
  const settled = from < 0 ? '' : hook.slice(from, hook.indexOf(']);', from));
  for (const call of ['api.gatewayArrivals(gatewayId)', 'api.gatewayDevicesLastReading(gatewayId)']) {
    if (!settled.includes(`Promise.resolve().then(() => ${call})`)) problems469.push(`useGatewayArrivals.js does not start ${call} as a call of its own inside Promise.allSettled()`);
  }
  if (/\bthrow\b/.test(hook.replace(/\/\*[\s\S]*?\*\//g, ''))) problems469.push('useGatewayArrivals.js throws, which would report the page as having stopped updating for a figure in a drawer');

  if (!tab.includes('useGatewayArrivals(selected?.gateway_id, arrivalsApply)')) problems469.push('GatewaysTab.jsx does not read what arrives while a gateway is selected');
  if (!tab.includes('arrivalsApply = !!selected && !selected.is_archived && !selected.is_shadow')) problems469.push('GatewaysTab.jsx does not leave out an archived gateway and the Playback gateway');
  for (const row of ROWS) {
    if (!tab.includes(`'${row}'`)) problems469.push(`GatewaysTab.jsx has no row ${row}`);
  }

  const arriving = help.slice(help.indexOf('- **The Arriving block**'), help.indexOf('- **Publishes under group X'));
  for (const row of ROWS.map((r) => r.replace(/ \(.*$/, ''))) {
    if (!arriving.includes(`**${row}`)) problems469.push(`help/pages/gateways.md does not name ${row} in the Arriving block's paragraph`);
  }
  for (const phrase of ['It is closed when the drawer opens', '**Not observed**', 'last 3 minutes', 'reads 0']) {
    if (!arriving.includes(phrase)) problems469.push(`help/pages/gateways.md's paragraph on the Arriving block does not say "${phrase}"`);
  }
  for (const phrase of ['**Last reading not observed**', '**No reading yet**']) {
    if (!help.includes(phrase)) problems469.push(`help/pages/gateways.md does not say ${phrase}`);
  }
  for (const phrase of ['`useGatewayArrivals()`', '`gateway_devices_last_reading()`', '`gateway_arrivals`', '`ARRIVAL_FRESH_MINUTES`', 'Neither read reports the page as having stopped updating']) {
    if (!readme.includes(phrase)) problems469.push(`frontend/README.md does not say ${phrase}`);
  }

  if (problems469.length) {
    fail("the Gateways drawer's reads of what arrives and the documents disagree:\n" + problems469.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Gateways drawer reads the ${ROWS.length} figures and the devices' last readings as two reads that cannot fail together, and the help and the README say so`);
  }
}
