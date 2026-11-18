import { compare, lastDefinition, need, read } from './lib.mjs';

// 122. How old a gateway's figure may be. 0303's view blanks a figure Prometheus did not evaluate
// within the last N minutes, so a stopped job reads "not observed" and never as its last value; the
// drawer's tip says the same N (ARRIVAL_FRESH_MINUTES in frontend/src/utils/gatewayArrivals.js), and
// so do the API reference and the help. Every `interval 'N minutes'` in the view must be the one N.
export default function check() {
  const view = lastDefinition('CREATE OR REPLACE VIEW public.gateway_arrivals', ';\n', 'the gateway_arrivals view');
  const js = need(read('frontend/src/utils/gatewayArrivals.js'), /export const ARRIVAL_FRESH_MINUTES = (\d+);/,
    'ARRIVAL_FRESH_MINUTES in frontend/src/utils/gatewayArrivals.js');
  if (!view || !js) return;
  const ages = [...new Set([...view.body.matchAll(/interval '(\d+) minutes'/g)].map((m) => m[1]))];
  compare('gatewayArrivalFreshness', "the one age the gateway_arrivals view blanks a figure at and the drawer's", js[1], ages.join(', '));
  const spec = read('docs/openapi.yaml');
  const at = spec.indexOf('  /rest/v1/gateway_arrivals:');
  const path = spec.slice(at, spec.indexOf('\n  /rest/v1/gateway_arrival_figures:', at));
  compare('gatewayArrivalFreshness', 'the minutes the API reference says a figure stays observed and the view\'s',
    path.includes(`within the last ${js[1]} minutes`) ? js[1] : 'not said', js[1]);
  const help = read('help/pages/gateways.md');
  compare('gatewayArrivalFreshness', 'the minutes the Gateways help says an answer may be old and the view\'s',
    help.includes(`in the last ${js[1]} minutes`) ? js[1] : 'not said', js[1]);
}
