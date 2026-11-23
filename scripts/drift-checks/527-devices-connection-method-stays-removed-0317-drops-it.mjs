import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, pass, read, REPO, sectionOf, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 527. devices.connection_method stays removed. 0317 drops it on every boot, after the released
// files that still name it have replayed with it in place: 0001 adds it back, 0001 and 0165 declare
// approve_proposal() with it, 0001 and 0202 proposable_columns(). A file after 0317 that names it
// would bring it back or fail the replay. audit_event_class() (0228 and every redeclaration) reads it
// out of an old snapshot as `-> 'connection_method'` alone, and 0293 names it in a comment. The API
// reference documents it on neither Device nor DeviceWrite, no code reads it but the Approvals
// page's label for a proposal filed before 1.10.0, and the upgrade note's query is the one the
// suite runs.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DROPPER = '0317_a_device_has_no_connection_method_column.sql';
  const SUITE = 'supabase/migrations/test_a_device_has_no_connection_method_column.py';
  const dir = 'supabase/migrations';
  // Released before the drop, and replayed before it with the column in place. Never edited.
  const RELEASED = new Set([
    '0001_baseline_schema.sql',
    '0165_not_found_is_a_404.sql',
    '0202_a_cell_s_dashboard_address_is_one_of_its_links.sql',
    '0293_a_device_can_follow_its_gateway_s_location.sql',
  ]);
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const offences = [];
  for (const f of [DROPPER, ...RELEASED]) if (!files.includes(f)) offences.push(`${dir}/${f} is missing`);

  for (const f of files.filter((name) => name !== DROPPER && !RELEASED.has(name))) {
    const sql = read(`${dir}/${f}`);
    const classifier = /CREATE OR REPLACE FUNCTION public\.audit_event_class\(/.test(sql);
    const named = classifier ? sql.split("-> 'connection_method'").join('') : sql;
    if (/\bconnection_method\b/.test(named)) offences.push(`${f} names connection_method`);
  }
  if (files.includes(DROPPER)) {
    const dropper = read(`${dir}/${DROPPER}`);
    if (!/ALTER TABLE public\.devices DROP COLUMN connection_method;/.test(dropper)) {
      offences.push(`${DROPPER} no longer drops devices.connection_method`);
    }
    const last = files.filter((f) => RELEASED.has(f)).pop();
    if (last && files.indexOf(DROPPER) < files.indexOf(last)) {
      offences.push(`${DROPPER} replays before ${last}, which names the column`);
    }
  }

  const spec = read('docs/openapi.yaml');
  // A component schema's body: the lines after its 4-space key, up to the next 4-space key.
  const components = {
    Device: spec.match(/^ {4}Device:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
    DeviceWrite: spec.match(/^ {4}DeviceWrite:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
  };
  for (const [name, body] of Object.entries(components)) {
    if (body === null) offences.push(`docs/openapi.yaml has no ${name} schema`);
    else if (/^ {8}connection_method:/m.test(body)) offences.push(`docs/openapi.yaml's ${name} still documents connection_method`);
  }

  // The Approvals page names the key of a proposal filed before 1.10.0, which can still be open.
  const LABEL = "  connection_method: 'Connection method',";
  const READERS = /^(?:frontend\/src|supabase\/functions|i3x|ingestion|node-red)\/.*\.(?:js|jsx|ts|mjs|py|json)$/;
  const TESTS = /(?:^|\/)(?:__tests__\/|test_[^/]*\.py$|[^/]*\.test\.[jt]sx?$|[^/]*_test\.ts$)/;
  for (const f of allFiles.filter((p) => READERS.test(p) && !TESTS.test(p))) {
    const text = read(f).split('\n').filter((line) => !(f.endsWith('/ApprovalsTab.jsx') && line === LABEL)).join('\n');
    if (/\bconnection_method\b/.test(text)) offences.push(`${f} names connection_method`);
  }

  const heading = '### From 1.10.0, `devices.connection_method` is removed';
  const note = sectionOf(upgradingGuide(), heading);
  const query = read(SUITE).match(/^PENDING_QUERY = \(\n([\s\S]*?)\n\)$/m)?.[1];
  const words = (s) => s.replace(/\s+/g, ' ').trim();
  if (!note) {
    offences.push(`help/site/upgrading.md has no "${heading}" (or its note in unreleased/upgrading/)`);
  } else if (!query) {
    offences.push(`${SUITE} has no PENDING_QUERY`);
  } else {
    const sql = words([...query.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(''));
    if (!words(note).includes(sql.replace(/;$/, ''))) {
      offences.push(`the upgrade note's query for open proposals naming the key is not ${SUITE}'s PENDING_QUERY`);
    }
  }

  if (offences.length) {
    fail(`devices.connection_method must stay removed (0317):\n  ${offences.join('\n  ')}`);
  } else {
    pass('devices.connection_method stays removed: no migration after the released ones but 0317 names it, the API spec documents it on neither Device nor DeviceWrite, no code reads it but the Approvals label, and the upgrade note lists open proposals with the suite\'s query');
  }
}
