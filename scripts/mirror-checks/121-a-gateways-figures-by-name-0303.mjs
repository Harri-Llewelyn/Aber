import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 121. What arrives from a gateway, by name. 0303's table has one column for each figure, the view
// the dashboard reads names the same columns, the collector's query labels one vector for each
// figure with the column's own name, and the drawer reads them by those names (ARRIVAL_COLUMNS in
// frontend/src/utils/gatewayArrivals.js, and the select in api.gatewayArrivals()). A name on one
// side only is a row of the drawer that reads "Not observed" for ever, which looks like Prometheus
// not answering. The API reference's GatewayArrival schema names the same three.
export default function check() {
  const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).filter((n) => n !== 'gateway_id' && n !== 'observed_at').sort().join(', ');

  const table = need(SCHEMA, /CREATE TABLE IF NOT EXISTS public\.gateway_arrival_figures \(([\s\S]*?)\n\);/,
    'the gateway_arrival_figures table in the applied migrations');
  const view = lastDefinition('CREATE OR REPLACE VIEW public.gateway_arrivals', ';\n', 'the gateway_arrivals view');
  const collector = lastDefinition('CREATE OR REPLACE FUNCTION public.refresh_gateway_arrivals()', '$$;', 'refresh_gateway_arrivals()');
  const js = need(read('frontend/src/utils/gatewayArrivals.js'), /export const ARRIVAL_COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\)/,
    'ARRIVAL_COLUMNS in frontend/src/utils/gatewayArrivals.js');
  const select = need(read('frontend/src/api.js'), /gatewayArrivals: async[\s\S]*?\.select\('([a-z_,]+)'\)/,
    "api.gatewayArrivals()'s select in frontend/src/api.js");
  const spec = need(read('docs/openapi.yaml'), /\n {4}GatewayArrival:\n[\s\S]*?properties:\n([\s\S]*?)\n\n {4}[A-Z]/,
    "GatewayArrival's properties in docs/openapi.yaml");

  if (table && view && collector && js && select && spec) {
    const sql = names(table[1], /^ {4}([a-z_]+) (?:double precision|bigint)/gm);
    compare('gatewayArrivalColumns', 'the columns of the gateway_arrivals view and of its table', names(view.body, /\bAS ([a-z_]+)/g), sql);
    compare('gatewayArrivalColumns', "the figures the collector's query labels and the table's columns", names(collector.body, /"figure", "([a-z_]+)"/g)
      .split(', ').filter((n) => n !== 'ingestion_scraped').join(', '), sql);
    compare('gatewayArrivalColumns', 'the figures the drawer reads and the table\'s columns', names(js[1], /'([a-z_]+)'/g), sql);
    compare('gatewayArrivalColumns', "the columns api.gatewayArrivals() selects and the table's", names(select[1].split(',').map((n) => `'${n}'`).join(','), /'([a-z_]+)'/g), sql);
    compare('gatewayArrivalColumns', 'the figures the API reference names and the table\'s columns', names(spec[1], /^ {8}([a-z_]+):/gm), sql);
  }
}
