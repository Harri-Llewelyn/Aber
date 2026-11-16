import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 385. The API reference names the places a device can be, as the database holds them. The device's
// location_scope enum is the values devices_location_scope_valid admits and its default is the
// column's; a gateway's enum is the values gateways_location_scope_valid admits, and never `gateway`;
// the location_source enum is every label device_locations produces. The three schemas that carry a
// device's scope use the device's, and the two that carry a gateway's use the gateway's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const yaml = read('docs/openapi.yaml');
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const problems385 = [];
  const list = (text) => [...text.matchAll(/'?([a-z_]+)'?(?:::text)?/g)].map((m) => m[1]).sort();

  // The text between two literals, found with indexOf: the names are fixed words of this repository,
  // and a pattern built from them would be a RegExp from a variable.
  const between = (text, open, close, from = 0) => {
    const start = text.indexOf(open, from);
    if (start < 0) return null;
    const end = text.indexOf(close, start + open.length);
    return end < 0 ? null : { text: text.slice(start + open.length, end), end };
  };
  const checkValues = (table) => {
    const found = between(baseline, `CONSTRAINT ${table}_location_scope_valid CHECK ((location_scope = ANY (ARRAY[`, ']');
    return found ? [...found.text.matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]).sort() : null;
  };
  const schemaOf = (name) => {
    const found = between(yaml, `\n    ${name}:\n      type: string\n      enum: [`, ']');
    if (!found) return null;
    // The default is the very next line.
    const marker = '\n      default: ';
    const at = found.end + 1;
    if (!yaml.startsWith(marker, at)) return null;
    return { values: list(found.text), fallback: yaml.slice(at + marker.length, yaml.indexOf('\n', at + marker.length)) };
  };

  const device = schemaOf('DeviceLocationScope');
  const gateway = schemaOf('LocationScope');
  const deviceValues = checkValues('devices');
  const gatewayValues = checkValues('gateways');
  const columnDefault = baseline.match(/CREATE TABLE IF NOT EXISTS public\.devices \([\s\S]*?\n {4}location_scope text DEFAULT '([a-z_]+)'::text NOT NULL,/)?.[1];
  if (!device || !gateway || !deviceValues || !gatewayValues || !columnDefault) {
    problems385.push('could not read DeviceLocationScope, LocationScope, the two CHECKs and the column default -- the shape changed, so this check no longer checks anything');
  } else {
    if (device.values.join() !== deviceValues.join()) problems385.push(`DeviceLocationScope lists ${device.values.join(', ')}; devices_location_scope_valid admits ${deviceValues.join(', ')}`);
    if (device.fallback !== columnDefault) problems385.push(`DeviceLocationScope defaults to ${device.fallback}; the column defaults to ${columnDefault}`);
    if (gateway.values.join() !== gatewayValues.join()) problems385.push(`LocationScope lists ${gateway.values.join(', ')}; gateways_location_scope_valid admits ${gatewayValues.join(', ')}`);
    if (gateway.values.includes('gateway')) problems385.push('LocationScope, a gateway\'s, lists gateway: a gateway has no gateway to follow');
  }

  // Which schema each property uses.
  const use = (schema, property) => {
    const at = yaml.indexOf(`\n    ${schema}:\n`);
    if (at < 0) return undefined;
    const stop = [...yaml.slice(at + 5).matchAll(/\n {4}[A-Za-z]+:\n/g)][0];
    const body = yaml.slice(at, stop ? at + 5 + stop.index : undefined);
    return between(body, `${property}: { $ref: '#/components/schemas/`, "' }")?.text;
  };
  for (const schema of ['Device', 'DeviceWrite', 'DeviceLocation']) {
    if (use(schema, 'location_scope') !== 'DeviceLocationScope') problems385.push(`${schema}.location_scope does not use DeviceLocationScope`);
  }
  for (const schema of ['Gateway', 'GatewayWrite']) {
    if (use(schema, 'location_scope') !== 'LocationScope') problems385.push(`${schema}.location_scope does not use LocationScope`);
  }

  // The sources: every label the last device_locations produces, in DeviceLocation's enum.
  const declaring = migrations.filter((f) => read(f).includes('CREATE OR REPLACE VIEW public.device_locations'));
  const last = declaring.length ? read(declaring[declaring.length - 1]) : '';
  const from = last.indexOf('CREATE OR REPLACE VIEW public.device_locations');
  const body = from >= 0 ? last.slice(from, last.indexOf(';', from)) : '';
  const produced = [...new Set([...body.matchAll(/(?:THEN|ELSE) '([a-z_]+)'::text/g)].map((m) => m[1]))].sort();
  const documented = yaml.match(/\n {8}location_source:\n {10}type: string\n {10}enum: \[([^\]]+)\]/);
  if (!produced.length || !documented) {
    problems385.push('could not read the labels device_locations produces or DeviceLocation.location_source\'s enum');
  } else if (list(documented[1]).join() !== produced.join()) {
    problems385.push(`DeviceLocation.location_source lists ${list(documented[1]).join(', ')}; device_locations produces ${produced.join(', ')}`);
  }

  // The create and update descriptions say what a client must send.
  for (const phrase of ['`devices_follow_gateway_has_no_place`', '`devices_cell_scope_names_a_cell`', 'location_scope=gateway']) {
    if (!yaml.includes(phrase)) problems385.push(`docs/openapi.yaml does not mention ${phrase}, which a client that writes a device's location meets`);
  }
  if (!supabaseReadme().includes('devices_follow_gateway_has_no_place')) problems385.push('supabase/README.md does not name devices_follow_gateway_has_no_place');

  if (problems385.length) {
    fail('the API reference describes a device\'s location otherwise than the database holds it:\n' +
      problems385.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the API reference lists the ${device.values.length} scopes a device can have, defaulting to ${device.fallback}, the ${gateway.values.length} a gateway can have, and the ${produced.length} sources device_locations produces`);
  }
}
