import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 383. 0293's two CHECKs and its move are described as the file holds them. Cell requires a cell
// (devices_cell_scope_names_a_cell) and Follow Gateway names no cell and no area
// (devices_follow_gateway_has_no_place); every device that was 'cell' with no cell becomes 'gateway'
// before the first is added, and the upgrade guide's query counts exactly those rows. The section the
// file's header cites names both constraints, the lock, the NOTICE and the value 0001 carries; the
// guide's section names the migration, the constraints a client meets, and the three new sources.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FILE = 'supabase/migrations/0293_a_device_can_follow_its_gateway_s_location.sql';
  const sql = read(FILE);
  const guide = upgradingGuide();
  const readme = supabaseReadme();
  const problems383 = [];

  const declares = (name, definition) => sql.split(`ADD CONSTRAINT ${name} CHECK (${definition});`).length - 1;
  const cellCheck = "((location_scope <> 'cell'::text) OR (cell_id IS NOT NULL))";
  const followCheck = "((location_scope <> 'gateway'::text) OR ((cell_id IS NULL) AND (area_id IS NULL)))";
  if (declares('devices_cell_scope_names_a_cell', cellCheck) !== 1) {
    problems383.push(`${FILE} does not declare devices_cell_scope_names_a_cell once, as location_scope <> 'cell' OR cell_id IS NOT NULL`);
  }
  if (declares('devices_follow_gateway_has_no_place', followCheck) !== 1) {
    problems383.push(`${FILE} does not declare devices_follow_gateway_has_no_place once, as location_scope <> 'gateway' OR cell_id and area_id both NULL`);
  }

  // The move: the rows the first CHECK would refuse, and nothing else.
  const move = sql.match(/UPDATE public\.devices\s+SET location_scope = 'gateway'\s+WHERE (location_scope = 'cell' AND cell_id IS NULL)/);
  if (!move) problems383.push(`${FILE} no longer moves WHERE location_scope = 'cell' AND cell_id IS NULL to 'gateway'`);
  if (!/RAISE NOTICE '0293: % device\(s\) were In a cell with no cell and now follow their gateway/.test(sql)) {
    problems383.push(`${FILE} no longer raises the NOTICE the upgrade guide quotes ("0293: ... device(s) were In a cell with no cell and now follow their gateway")`);
  }
  if (!sql.includes('LOCK TABLE public.devices IN SHARE ROW EXCLUSIVE MODE;')) {
    problems383.push(`${FILE} no longer takes the lock the README section describes`);
  }

  const title = sql.match(/Reasoning: supabase\/README\.md, "([^"]+)"/)?.[1];
  const sectionAt = title ? readme.indexOf(`\n### ${title}\n`) : -1;
  if (sectionAt < 0) {
    problems383.push(`${FILE} cites ${title ? `"${title}"` : 'no section'} in supabase/README.md, which has no such heading`);
  } else {
    const end = readme.indexOf('\n### ', sectionAt + 5);
    const section = readme.slice(sectionAt, end < 0 ? undefined : end);
    for (const phrase of ['devices_cell_scope_names_a_cell', 'devices_follow_gateway_has_no_place', 'SHARE ROW EXCLUSIVE',
      'followed_cell', 'followed_area', 'followed_site', '`0001` carries', 'NOTICE', 'approve_quarantined_device()',
      'relocate_devices()', 'device_uns_paths', 'automations_document()']) {
      if (!section.includes(phrase)) problems383.push(`the section "${title}" does not mention ${phrase}`);
    }
  }

  const heading = 'From 1.9.0, a device can follow its gateway\'s location';
  const guideAt = guide.indexOf(`\n### ${heading}\n`);
  if (guideAt < 0) {
    problems383.push(`help/site/upgrading.md has no "${heading}" section, which the 0293 section names`);
  } else {
    const end = guide.indexOf('\n### ', guideAt + 5);
    const section = guide.slice(guideAt, end < 0 ? undefined : end);
    // The count is of the rows the move changes: the same predicate, qualified by its table alias.
    if (!section.includes("WHERE d.location_scope = 'cell' AND d.cell_id IS NULL")) {
      problems383.push(`"${heading}" does not count WHERE d.location_scope = 'cell' AND d.cell_id IS NULL, the rows 0293 moves`);
    }
    for (const phrase of ['migration `0293`', 'devices_follow_gateway_has_no_place', 'devices_cell_scope_names_a_cell',
      'followed_cell', 'followed_area', 'followed_site', 'Unassigned', 'starts `0293:`']) {
      if (!section.includes(phrase)) problems383.push(`"${heading}" does not mention ${phrase}`);
    }
  }
  if (!readme.includes(`help/site/upgrading.md\`, *${heading}*`)) {
    problems383.push(`the 0293 section does not point to "${heading}" in the upgrade guide`);
  }

  if (problems383.length) {
    fail('0293\'s checks and move are described otherwise than the file holds them:\n' +
      problems383.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`0293 declares both device CHECKs and moves only a cell-scoped device with no cell, and "${title}" and "${heading}" say so`);
  }
}
