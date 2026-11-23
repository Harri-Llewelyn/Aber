import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, pass, read, REPO, sectionOf, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 527. devices.connection_method stays removed. 0317 drops it, guarded by its existence, so only an
// upgrade's first boot touches devices. db-init replays every file on every boot, so another file
// that declares the column or names it in a function body would bring it back or fail the replay:
// 0001, 0165, 0202 and 0293 were brought to their final form in place, and 0317 redeclares nothing.
// The Audit Trail's configuration fields, which past rows carry, are audit_event_class()'s (0228,
// and each later file that redeclares it), which reads it out of a snapshot as `-> 'connection_method'`
// alone. The API spec documents it on neither Device nor DeviceWrite, no code reads or writes it but
// the Approvals page's label for a proposal filed before 1.10.0, and the upgrade note lists open
// proposals naming it with the suite's query.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DROPPER = '0317_a_device_has_no_connection_method_column.sql';
  const SUITE = 'supabase/migrations/test_a_device_has_no_connection_method_column.py';
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const offences = [];
  if (!files.includes(DROPPER)) offences.push(`${dir}/${DROPPER} is missing`);

  for (const f of files.filter((name) => name !== DROPPER)) {
    const sql = read(`${dir}/${f}`);
    const classifier = /CREATE OR REPLACE FUNCTION public\.audit_event_class\(/.test(sql);
    const named = classifier ? sql.split("-> 'connection_method'").join('') : sql;
    if (/\bconnection_method\b/.test(named)) offences.push(`${f} names connection_method`);
  }
  if (files.includes(DROPPER)) {
    const dropper = read(`${dir}/${DROPPER}`);
    if (!/attname = 'connection_method' AND NOT attisdropped\) THEN\s+RETURN;/.test(dropper)) {
      offences.push(`${DROPPER} no longer returns before its drop when devices.connection_method is gone`);
    }
    if (/CREATE OR REPLACE FUNCTION/.test(dropper)) {
      offences.push(`${DROPPER} declares a function: the earlier files already declare it without the column`);
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

  // The Approvals page labels the key of a proposal filed before 1.10.0, which can still be open.
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
    pass('devices.connection_method stays removed: no migration but 0317 (guarded) names it outside the audit classifier\'s snapshot reads, the API spec documents it on neither Device nor DeviceWrite, no code reads it but the Approvals label, and the upgrade note lists open proposals with the suite\'s query');
  }
}
