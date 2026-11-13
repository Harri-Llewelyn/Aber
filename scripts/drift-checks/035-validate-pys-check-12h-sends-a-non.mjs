import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 35. validate.py's check 12h sends a non-token to every route the i3X server serves.
//
// The check proves "401 everywhere but GET /info" only for the routes it lists, so a route added to
// ROUTES and not to I3X_ROUTES would go unprobed while the check still passed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const block = (src, re) => (src.match(re) || [])[1] || '';
  const routes = (text) => new Set([...text.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g)].map((m) => m[1]));
  const served = routes(block(read('i3x/i3x_service.py'), /^ROUTES = \{\n([\s\S]*?)^\}/m));
  const swept = routes(block(read('ingestion/validate.py'), /^I3X_ROUTES = \(\n([\s\S]*?)^\)/m));
  const unswept = [...served].filter((r) => !swept.has(r));
  const unserved = [...swept].filter((r) => !served.has(r));
  if (!served.size || !swept.size) {
    fail('check 35 cannot read ROUTES in i3x/i3x_service.py or I3X_ROUTES in ingestion/validate.py');
  } else if (unswept.length || unserved.length) {
    fail('validate.py I3X_ROUTES and i3x_service.py ROUTES disagree:' +
      (unswept.length ? `\n        served but not swept by check 12h: ${unswept.join(', ')}` : '') +
      (unserved.length ? `\n        swept but not served: ${unserved.join(', ')}` : ''));
  } else {
    pass(`validate.py's check 12h probes all ${served.size} i3X routes`);
  }
}
