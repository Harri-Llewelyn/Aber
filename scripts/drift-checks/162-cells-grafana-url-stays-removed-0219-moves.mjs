import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 162. cells.grafana_url stays removed. 0219 moves what the column still holds into Attached Links
// or the Audit Trail and drops it. db-init replays every file on every boot, so another migration
// that declares the column or names it in a function body would bring it back or fail the replay;
// 0202 reads it only after returning when it is gone. The API spec documents it on neither Cell nor
// CellWrite, and no code reads it. The Audit Trail's configuration fields, which past rows carry,
// are audit_event_class()'s (0228, and a later file that redeclares it), which reads it out of a
// snapshot as `-> 'grafana_url'` alone.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DROPPER = '0219_a_cell_has_no_grafana_url_column.sql';
  const MOVER = '0202_a_cell_s_dashboard_address_is_one_of_its_links.sql';
  const CLASSIFIER = '0228_the_audit_trail_sorts_events_into_classes_in_the_database.sql';
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const offences = [];
  for (const f of [MOVER, DROPPER]) if (!files.includes(f)) offences.push(`${dir}/${f} is missing`);

  for (const f of files.filter((name) => name !== DROPPER && name !== MOVER)) {
    const sql = read(`${dir}/${f}`);
    const classifier = f === CLASSIFIER || /CREATE OR REPLACE FUNCTION public\.audit_event_class\(/.test(sql);
    const named = classifier ? sql.replace(/-> 'grafana_url'/g, '') : sql;
    if (/\bgrafana_url\b/.test(named)) offences.push(`${f} names grafana_url`);
  }
  if (files.includes(MOVER)) {
    const mover = read(`${dir}/${MOVER}`);
    if (!/attname = 'grafana_url' AND NOT attisdropped\) THEN\s+RETURN;/.test(mover)) {
      offences.push(`${MOVER} no longer returns before its move when cells.grafana_url is gone`);
    }
    if (/(?:COMMENT ON COLUMN|ALTER TABLE(?: ONLY)?) public\.cells(?:\.grafana_url)?\b[^;]*\bgrafana_url\b/.test(mover)) {
      offences.push(`${MOVER} comments on or alters cells.grafana_url, which fails once 0219 has dropped it`);
    }
  }

  const spec = read('docs/openapi.yaml');
  // A component schema's body: the lines after its 4-space key, up to the next 4-space key.
  const components = {
    Cell: spec.match(/^ {4}Cell:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
    CellWrite: spec.match(/^ {4}CellWrite:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
  };
  for (const [name, body] of Object.entries(components)) {
    if (body === null) offences.push(`docs/openapi.yaml has no ${name} schema`);
    else if (/^ {8}grafana_url:/m.test(body)) offences.push(`docs/openapi.yaml's ${name} still documents grafana_url`);
  }

  const READERS = /^(?:frontend\/src|supabase\/functions|i3x|ingestion)\/.*\.(?:js|jsx|ts|mjs|py)$/;
  const TESTS = /(?:^|\/)(?:__tests__\/|test_[^/]*\.py$|[^/]*\.test\.[jt]sx?$|[^/]*_test\.ts$)/;
  for (const f of allFiles.filter((p) => READERS.test(p) && !TESTS.test(p))) {
    if (/\bgrafana_url\b/.test(read(f))) offences.push(`${f} names grafana_url`);
  }

  if (offences.length) {
    fail(`cells.grafana_url must stay removed (0219):\n  ${offences.join('\n  ')}`);
  } else {
    pass(`cells.grafana_url stays removed: no migration but 0202 (guarded) and 0219 names it, the API spec documents it on neither Cell nor CellWrite, and no code reads it`);
  }
}
