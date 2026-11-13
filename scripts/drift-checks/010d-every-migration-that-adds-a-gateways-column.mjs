import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10d. Every migration that adds a `gateways` column rebuilds the view that exposes it.
//
// `public.gateway_status` is declared `SELECT g.*`, and Postgres expands the star at creation
// time into a frozen column list. Replay order makes it permanent: the baseline's own
// `ensure_gateway_status_view()` call runs before any later ALTER on every boot.
//
// And nothing STATES the view. A `CREATE OR REPLACE VIEW public.gateway_status` carries the column
// list of the day it was written, so on the boot after a later migration has widened the view it
// tries to drop that column and aborts the chain ("cannot drop columns from view").
// -------------------------------------------------------------------------------------------------
export default function check() {
  const ADDS_COLUMN = /ALTER TABLE (?:ONLY )?public\.gateways\s+ADD COLUMN/i;
  const REBUILDS = /SELECT\s+public\.ensure_gateway_status_view\(\)/i;

  // Statements only: both regexes would otherwise match prose about the rebuild.
  const statements = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  const migrations = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => [f, statements(read(`supabase/migrations/${f}`))]);

  // A rebuild in a later migration covers an earlier add, because the chain replays in filename
  // order. What breaks is an add that nothing after it rebuilds.
  const offenders = [];
  let checked = 0;
  for (let i = 0; i < migrations.length; i += 1) {
    if (!ADDS_COLUMN.test(migrations[i][1])) continue;
    checked += 1;
    const coveredBy = migrations.slice(i).find(([, sql]) => REBUILDS.test(sql));
    if (!coveredBy) offenders.push(migrations[i][0]);
  }

  const STATES = /CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.gateway_status\b/i;
  const stating = migrations.filter(([, sql]) => STATES.test(sql)).map(([f]) => f);
  if (stating.length) {
    fail(
      `${stating.join(', ')} state(s) public.gateway_status with CREATE OR REPLACE VIEW.\n` +
        '      The stated column list is frozen, so the replay after a migration widens gateways\n' +
        '      fails with "cannot drop columns from view". Build it with\n' +
        '        SELECT public.ensure_gateway_status_view();\n' +
        '      which is what generate-baseline-section.mjs emits for the baseline (REBUILT_BY).'
    );
  } else {
    pass('no migration states public.gateway_status; it is built by ensure_gateway_status_view()');
  }

  if (!checked) {
    // Zero is the correct answer since the squash: the baseline declares every gateways column
    // inline. The self-guard asserts instead that the rebuild helper this rule is about still
    // exists, so a rename cannot make the rule go quiet.
    const baseline = statements(read('supabase/migrations/0001_baseline_schema.sql'));
    if (!/FUNCTION public\.ensure_gateway_status_view\(\)/i.test(baseline)) {
      fail('public.ensure_gateway_status_view() is not declared in the baseline, so this rule '
        + 'cannot recognise a rebuild.\n      Rename in REBUILDS above to match, or this check '
        + 'will pass every migration that forgets one.');
    } else {
      pass('no migration adds a gateways column; the baseline declares them inline');
    }
  } else if (offenders.length) {
    fail(
      `${offenders.length} migration(s) add a public.gateways column that NOTHING after them `
      + `rebuilds public.gateway_status for: ${offenders.join(', ')}.\n`
      + '      The view is `SELECT g.*`, which Postgres freezes at creation, so the column is\n'
      + '      invisible through it and nothing errors -- the view goes on returning what it was\n'
      + '      born with. db-init replays migrations in filename order on every boot, so an\n'
      + '      earlier rebuild never picks it up and the state does not self-correct. End the\n'
      + '      migration with:\n'
      + '        SELECT public.ensure_gateway_status_view();'
    );
  } else {
    pass(`all ${checked} migrations adding a gateways column rebuild gateway_status`);
  }
}
