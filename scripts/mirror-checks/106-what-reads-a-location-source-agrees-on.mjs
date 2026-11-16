import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, ok, problems, read, ROOT } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 106. What reads device_locations.location_source agrees on which sources are Site-Wide, which are
// Area-Wide and which name a cell. A device that follows a Site-Wide gateway is Site-Wide: the UNS
// path and the automations document in SQL, the i3X address space in Python, and the dashboard's
// lanes in JS each hold a pair of labels, and a pair that stops at the device's own assertion files a
// followed device as Unassigned there and nowhere else. The labels themselves are check 3's.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const mod = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/cellResolution.js')).href);
  const sorted = (list) => [...list].sort().join(',');
  const labels = (text) => [...text.matchAll(/'([a-z_]+)'(?:::text)?/g)].map((m) => m[1]);

  // The meaning each source has on the JS side: the module's own sets, run over every label.
  const sources = Object.entries(mod).filter(([name]) => name.startsWith('SOURCE_')).map(([, value]) => value);
  const jsSiteWide = sources.filter((s) => mod.isSiteWideSource(s));
  const jsAreaWide = sources.filter((s) => mod.isAreaWideSource(s));
  const jsNamesCell = sources.filter((s) => !mod.NON_CELL_SOURCES.has(s) && s !== mod.SOURCE_UNASSIGNED);

  // device_uns_paths: the segments it builds and the sources it skips as cell_unfiled.
  const uns = lastDefinition('CREATE OR REPLACE VIEW public.device_uns_paths', ';', 'public.device_uns_paths');
  if (uns) {
    const body = uns.body.replace(/\s+/g, ' ');
    const site = need(body, /WHEN dl\.location_source = ANY \(ARRAY\[([^\]]+)\]\) THEN ARRAY\[e\.enterprise, s\.site, d\.name\]/, "device_uns_paths's Site-Wide segments");
    const area = need(body, /WHEN dl\.location_source = ANY \(ARRAY\[([^\]]+)\]\) THEN ARRAY\[e\.enterprise, s\.site, a\.name, d\.name\]/, "device_uns_paths's Area-Wide segments");
    const cell = need(body, /p\.location_source = ANY \(ARRAY\[([^\]]+)\]\) AND p\.area_id IS NULL THEN 'cell_unfiled'/, "device_uns_paths's cell_unfiled sources");
    if (site) compare('locationSource', `the sources ${uns.file} puts directly under the site, and the dashboard's Site-Wide`, sorted(jsSiteWide), sorted(labels(site[1])));
    if (area) compare('locationSource', `the sources ${uns.file} puts directly under an area, and the dashboard's Area-Wide`, sorted(jsAreaWide), sorted(labels(area[1])));
    if (cell) compare('locationSource', `the sources ${uns.file} can find in no area, and the sources that name a cell`, sorted(jsNamesCell), sorted(labels(cell[1])));
  }

  // automations_document(): a device behind a Site-Wide gateway is Site-wide in the comment beside its id.
  const doc = lastDefinition('CREATE OR REPLACE FUNCTION public.automations_document(', '\n$$;', 'public.automations_document');
  if (doc) {
    const place = need(doc.body, /dl\.location_source IN \(([^)]+)\) THEN 'Site-wide'/, "automations_document()'s Site-wide place");
    if (place) compare('locationSource', `the sources ${doc.file} calls Site-wide, and the dashboard's Site-Wide`, sorted(jsSiteWide), sorted(labels(place[1])));
  }

  // The i3X address space files a device by its source: Site-Wide ones directly under the site.
  const py = read('i3x/address_space.py');
  const pyConstants = Object.fromEntries([...py.matchAll(/^(SOURCE_[A-Z_]+) = "([a-z_]+)"$/gm)].map((m) => [m[1], m[2]]));
  const pySite = need(py, /if cell_id or area_id or source in \(([^)]+)\):/, "i3x/address_space.py's Site-Wide placement");
  if (pySite) {
    const names = pySite[1].split(',').map((n) => n.trim());
    const missing = names.filter((n) => !(n in pyConstants));
    if (missing.length) problems.push(`locationSource: i3x/address_space.py places a device by ${missing.join(', ')}, which it does not define`);
    else compare('locationSource', "the sources i3x/address_space.py files under the site, and the dashboard's Site-Wide", sorted(jsSiteWide), sorted(names.map((n) => pyConstants[n])));
  }

  // The automation editor words a device's place from the dashboard's own row.
  const help = need(read('frontend/src/utils/automationEditorHelp.js'), /d\.location_source === '([a-z_]+)' \|\| d\.location_source === '([a-z_]+)'/, "automationEditorHelp.js's Site-wide place");
  if (help) compare('locationSource', "the sources automationEditorHelp.js calls Site-wide, and the dashboard's Site-Wide", sorted(jsSiteWide), sorted([help[1], help[2]]));

  // Nothing else may be the sources the sets above leave out: a label no set names is a new arm.
  const view = lastDefinition('CREATE OR REPLACE VIEW public.device_locations', ';', 'public.device_locations');
  if (view) {
    const produced = new Set([...view.body.matchAll(/(?:THEN|ELSE) '([a-z_]+)'::text/g)].map((m) => m[1]));
    const covered = new Set([...jsSiteWide, ...jsAreaWide, ...jsNamesCell, mod.SOURCE_UNASSIGNED, mod.SOURCE_SIMULATED, mod.SOURCE_SHADOW]);
    const loose = [...produced].filter((s) => !covered.has(s));
    if (loose.length) problems.push(`locationSource: ${view.file} produces ${loose.join(', ')}, which no reader's set of Site-Wide, Area-Wide, cell, Unassigned or lane sources holds`);
    else ok.push(`locationSource: every source ${view.file} produces is a Site-Wide, Area-Wide, cell, Unassigned or lane source on the JS side`);
  }
}
