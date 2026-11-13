import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 386. The writers that take a device's scope take every scope the CHECK admits. The approve-quarantine
// function validates the four, its README names them, and the Python mirror its suite holds to the
// source lists them; relocate_devices() and approve_quarantined_device(), as 0293 redeclares them,
// admit the same four and clear the cell and the area for `gateway` as for `site_wide`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const sql = read('supabase/migrations/0293_a_device_can_follow_its_gateway_s_location.sql');
  const index = read('supabase/functions/approve-quarantine/index.ts');
  const readme = read('supabase/functions/approve-quarantine/README.md');
  const suite = read('supabase/functions/approve-quarantine/test_approve_quarantine.py');
  const problems386 = [];
  const four = ['area_wide', 'cell', 'gateway', 'site_wide'];
  const names = (text) => [...text.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]).sort();

  const admitted = baseline.match(/CONSTRAINT devices_location_scope_valid CHECK \(\(location_scope = ANY \(ARRAY\[([^\]]+)\]\)\)\)/);
  if (!admitted || names(admitted[1].replace(/::text/g, '')).join() !== four.join()) {
    problems386.push(`devices_location_scope_valid does not admit exactly ${four.join(', ')}`);
  }

  const source = index.match(/scope !== "gateway" && scope !== "cell" && scope !== "site_wide" && scope !== "area_wide"/);
  if (!source) problems386.push('approve-quarantine/index.ts does not validate location_scope against gateway, cell, site_wide and area_wide');
  const message = index.match(/location_scope must be ([^"]+)"/)?.[1] || '';
  if (names(message).join() !== four.join()) problems386.push(`approve-quarantine/index.ts says location_scope must be ${message}, not the four`);
  const mirror = suite.match(/if scope not in \(([^)]+)\):/)?.[1] || '';
  if (names(mirror).join() !== four.join()) problems386.push(`test_approve_quarantine.py's mirror admits ${mirror}, not the four`);
  const documented = readme.match(/\(`gateway`, `cell`, `area_wide` or `site_wide`\)/);
  if (!documented) problems386.push('approve-quarantine/README.md does not list location_scope as gateway, cell, area_wide or site_wide');

  const approve = sql.match(/IF p_set_location_scope AND p_location_scope IN \('site_wide', 'gateway'\) THEN\s+v_cell := NULL;\s+v_area := NULL;/);
  if (!approve) problems386.push('0293 does not clear the cell and the area when approve_quarantined_device() is given site_wide or gateway');
  const relocate = sql.match(/IF v_scope NOT IN \(([^)]+)\) THEN/)?.[1] || '';
  if (names(relocate).join() !== four.join()) problems386.push(`0293's relocate_devices() admits ${relocate}, not the four`);
  if (!/IF v_scope IN \('site_wide', 'gateway'\) THEN\s+v_cell := NULL;\s+v_area := NULL;/.test(sql)) {
    problems386.push('0293\'s relocate_devices() does not clear the cell and the area for site_wide and gateway');
  }
  for (const refusal of ['a cell device must name its cell', 'a cell move for device % must name cell_id']) {
    if (!sql.includes(refusal)) problems386.push(`0293 does not refuse a cell scope with no cell in the words "${refusal}"`);
  }

  if (problems386.length) {
    fail('a writer of a device\'s scope takes other scopes than the CHECK admits:\n' +
      problems386.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('approve-quarantine, its README and mirror, approve_quarantined_device() and relocate_devices() take the four scopes devices_location_scope_valid admits and clear the cell and area for gateway');
  }
}
