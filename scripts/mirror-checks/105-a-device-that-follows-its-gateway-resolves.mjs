import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, ok, problems, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 105. A device that follows its gateway resolves as the gateway does. devices.location_scope admits
// 'gateway', and a new device has it; device_locations answers a device with that scope from the
// gateway's own scope (followed_site, followed_area, followed_cell, else unassigned), after the two
// lanes and the two wide scopes and before the device's own cell; cellResolution.js derives the same
// answer where a page holds no row of the view. A scope only one side admits, an arm only one side
// has, or an order that differs files a device under a different place in two pages.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const jsPath = 'frontend/src/utils/cellResolution.js';
  const js = read(jsPath);
  const mod = await import(pathToFileURL(join(ROOT, jsPath)).href);

  // The scopes. The CHECK is in 0001's devices table, and 0293's self-check holds the live one to it.
  const scopeCheck = need(SCHEMA, /CONSTRAINT devices_location_scope_valid CHECK \(\(location_scope = ANY \(ARRAY\[([^\]]+)\]\)\)\)/,
    'devices_location_scope_valid in the applied chain');
  const sqlScopes = scopeCheck ? [...scopeCheck[1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort() : [];
  const jsScopes = [mod.SCOPE_GATEWAY, mod.SCOPE_CELL, mod.SCOPE_AREA_WIDE, mod.SCOPE_SITE_WIDE].sort();
  compare('cellResolution', 'the scopes a device can have', jsScopes.join(','), sqlScopes.join(','));
  const unknown = ['', 'building', undefined].filter((v) => mod.normaliseScope(v) !== mod.SCOPE_CELL);
  if (jsScopes.some((v) => mod.normaliseScope(v) !== v) || unknown.length) {
    problems.push('cellResolution: normaliseScope() must keep each scope the CHECK admits and read anything else as cell');
  } else {
    ok.push('cellResolution: normaliseScope() keeps the four scopes and reads anything else as cell');
  }

  // The default: a new device follows its gateway, in the table and in the form that makes one.
  const defaultScope = need(SCHEMA, /CREATE TABLE IF NOT EXISTS public\.devices \([\s\S]*?\n {4}location_scope text DEFAULT '([a-z_]+)'::text NOT NULL,/,
    "devices.location_scope's default in the applied chain");
  const formDefault = need(read('frontend/src/components/tabs/DevicesTab.jsx'), /const \[blank\][^\n]*location_scope: (SCOPE_[A-Z_]+) \}\)/,
    "the Register New Device form's starting scope in DevicesTab.jsx");
  if (defaultScope && formDefault) {
    compare('cellResolution', "a new device's scope in the table and in the form", mod[formDefault[1]], defaultScope[1]);
  }

  const view = lastDefinition('CREATE OR REPLACE VIEW public.device_locations', ';', 'public.device_locations');
  if (!view) return;
  const flat = view.body.replace(/\s+/g, ' ');

  // The arms, each as the view states it and as the module answers it. One table drives both: the
  // gateway's location, and the source a device that follows it gets.
  const gateways = {
    site_wide: { location_scope: 'site_wide', cell_id: null },
    area_wide: { location_scope: 'area_wide', cell_id: null, area_id: 'a' },
    in_a_cell: { location_scope: 'cell', cell_id: 'c' },
    no_location: { location_scope: 'cell', cell_id: null },
    no_gateway: null
  };
  const sqlArms = {
    site_wide: /WHEN \(\(d\.location_scope = 'gateway'::text\) AND \(g\.location_scope = 'site_wide'::text\)\) THEN 'followed_site'::text/,
    area_wide: /WHEN \(\(d\.location_scope = 'gateway'::text\) AND \(g\.location_scope = 'area_wide'::text\)\) THEN 'followed_area'::text/,
    in_a_cell: /WHEN \(\(d\.location_scope = 'gateway'::text\) AND \(g\.cell_id IS NOT NULL\)\) THEN 'followed_cell'::text/,
    no_location: /WHEN \(d\.location_scope = 'gateway'::text\) THEN 'unassigned'::text/
  };
  const wanted = {
    site_wide: mod.SOURCE_FOLLOWED_SITE, area_wide: mod.SOURCE_FOLLOWED_AREA, in_a_cell: mod.SOURCE_FOLLOWED_CELL,
    no_location: mod.SOURCE_UNASSIGNED, no_gateway: mod.SOURCE_UNASSIGNED
  };
  for (const [name, gateway] of Object.entries(gateways)) {
    const got = mod.resolveDeviceLocation({ location_scope: mod.SCOPE_GATEWAY }, gateway).location_source;
    compare('cellResolution', `the source of a device that follows a gateway that is ${name} (JS)`, got, wanted[name]);
    if (name !== 'no_gateway' && !sqlArms[name].test(flat)) {
      problems.push(`cellResolution: ${view.file} has no arm giving a device that follows a gateway that is ${name} the source '${wanted[name]}'`);
    } else if (name !== 'no_gateway') {
      ok.push(`cellResolution: ${view.file} gives a device that follows a gateway that is ${name} the source '${wanted[name]}'`);
    }
  }

  // What each arm resolves to, beside the cell and the area. A Site-Wide gateway has no cell and no
  // area, an Area-Wide one its area and no cell, one in a cell that cell and its area.
  const cells = new Map([['c', { cell_id: 'c', area_id: 'ca' }]]);
  const places = {
    site_wide: [null, null], area_wide: [null, 'a'], in_a_cell: ['c', 'ca'], no_location: [null, null], no_gateway: [null, null]
  };
  for (const [name, gateway] of Object.entries(gateways)) {
    const loc = mod.resolveDeviceLocation({ location_scope: mod.SCOPE_GATEWAY }, gateway, cells);
    compare('cellResolution', `the cell and area of a device that follows a gateway that is ${name} (JS)`,
      `${loc.effective_cell_id},${loc.effective_area_id}`, places[name].map(String).join(","));
  }
  const sqlPlaces = [
    ["a device that follows a gateway takes the gateway's cell", /WHEN \(d\.location_scope = 'gateway'::text\) THEN g\.cell_id/],
    ["a device that follows a Site-Wide gateway has no area", /WHEN \(\(d\.location_scope = 'gateway'::text\) AND \(g\.location_scope = 'site_wide'::text\)\) THEN NULL::uuid/],
    ["a device that follows an Area-Wide gateway takes the gateway's area", /WHEN \(\(d\.location_scope = 'gateway'::text\) AND \(g\.location_scope = 'area_wide'::text\)\) THEN g\.area_id/]
  ];
  for (const [what, re] of sqlPlaces) {
    if (re.test(flat)) ok.push(`cellResolution: ${view.file}: ${what}`);
    else problems.push(`cellResolution: ${view.file} no longer says that ${what}`);
  }

  // The order. The lanes and the wide scopes answer first on both sides, then the gateway's, then
  // the device's own cell: a device that names its own place is not moved by its gateway.
  const sqlAt = (needle) => flat.indexOf(needle);
  const sqlOrder = [`THEN 'simulated'::text`, `THEN 'area_wide'::text`, `THEN 'followed_site'::text`, `THEN 'explicit'::text`].map(sqlAt);
  const jsAt = (needle) => js.indexOf(needle);
  const jsOrder = [
    'else if (simulated) source = SOURCE_SIMULATED',
    'else if (scope === SCOPE_AREA_WIDE) source = SOURCE_AREA_WIDE',
    'else if (following) source = followedSource(gateway)',
    'else if (explicit) source = SOURCE_EXPLICIT'
  ].map(jsAt);
  const ascending = (list) => list.every((at, i) => at >= 0 && (i === 0 || at > list[i - 1]));
  if (!ascending(sqlOrder) || !ascending(jsOrder)) {
    problems.push(`cellResolution: the lanes, the wide scopes, the gateway's place and the device's own cell must answer in that order on both sides (SQL ${ascending(sqlOrder) ? 'ok' : 'WRONG ORDER'}, JS ${ascending(jsOrder) ? 'ok' : 'WRONG ORDER'})`);
  } else {
    ok.push('cellResolution: the lanes, the wide scopes, the gateway\'s place and the device\'s own cell answer in that order on both sides');
  }

  // A device that follows resolves to the gateway's cell and not its own: the effective cell reads
  // g.cell_id in the view and the gateway's cell in the module, ahead of the COALESCE of the rest.
  const sqlFollowedCell = flat.indexOf("WHEN (d.location_scope = 'gateway'::text) THEN g.cell_id") >= 0
    && flat.indexOf("WHEN (d.location_scope = 'gateway'::text) THEN g.cell_id") < flat.indexOf('ELSE COALESCE(d.cell_id, g.cell_id)');
  const jsFollowedCell = /\? null : following \? inherited : \(explicit \|\| inherited\)/.test(js);
  if (!sqlFollowedCell || !jsFollowedCell) {
    problems.push(`cellResolution: a device that follows its gateway must take the gateway's cell before the COALESCE of its own, on both sides (SQL ${sqlFollowedCell ? 'ok' : 'MISSING'}, JS ${jsFollowedCell ? 'ok' : 'MISSING'})`);
  } else {
    ok.push("cellResolution: a device that follows its gateway takes the gateway's cell ahead of the COALESCE on both sides");
  }
}
