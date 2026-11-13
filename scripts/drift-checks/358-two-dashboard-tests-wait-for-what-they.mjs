import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 358. Two dashboard tests wait for what they check. The History Alerts test of the limit's rule
// mocks ALERT_HISTORY_LIMIT small, so it renders a handful of rows where the page's limit is a
// thousand and its cost does not depend on the machine. The editor's completion test waits for the
// completion with waitFor, not for 30 ms. frontend/README.md's Testing section gives the rule. A
// test that rendered the real limit, or slept for the completion, fails on a busy machine for
// nothing it checks.
// -------------------------------------------------------------------------------------------------
function part1() {
  const problems358 = [];
  const alerts = read('frontend/src/__tests__/historyAlerts.test.jsx');
  const real = Number(read('frontend/src/api.js').match(/^export const ALERT_HISTORY_LIMIT = (\d+);$/m)?.[1]);
  const small = Number(alerts.match(/vi\.mock\('\.\.\/api', async \(\) => \{[\s\S]*?ALERT_HISTORY_LIMIT: (\d+),/)?.[1]);
  if (!(real > 0)) problems358.push('could not read ALERT_HISTORY_LIMIT in frontend/src/api.js');
  if (!(small > 0)) problems358.push("historyAlerts.test.jsx does not mock ALERT_HISTORY_LIMIT in its vi.mock of '../api'");
  else if (real > 0 && !(small <= 10 && small < real)) problems358.push(`historyAlerts.test.jsx mocks ALERT_HISTORY_LIMIT as ${small}: a handful of rows, well under the page's ${real}`);
  if (!alerts.includes('ended(ALERT_HISTORY_LIMIT + 1)')) problems358.push('the limit test of historyAlerts.test.jsx does not read one more than the limit, as the page asks for');
  const editor = read('frontend/src/__tests__/automationEditor.test.jsx');
  const completes = editor.match(/ {2}it\('completes a metric from the catalogue where the cursor is'[\s\S]*?(?=\n {2}it\()/)?.[0] ?? '';
  if (!completes) problems358.push('automationEditor.test.jsx has no test "completes a metric from the catalogue where the cursor is"');
  else {
    if (!completes.includes('await waitFor(() => expect(currentCompletions(')) problems358.push("the editor's completion test does not wait for the completion with waitFor");
    if (/setTimeout/.test(completes)) problems358.push("the editor's completion test waits for a time");
  }
  const testing = read('frontend/README.md').replace(/\s+/g, ' ').match(/\n?## Testing ([\s\S]*?)(?= --- ## )/)?.[1] ?? '';
  if (!testing.includes('A test waits for the condition it checks, not for a time.')) problems358.push("frontend/README.md's Testing section does not say a test waits for its condition");
  if (!testing.includes('mock the limit small')) problems358.push("frontend/README.md's Testing section does not say to mock a limit small");
  if (problems358.length) {
    fail('two dashboard tests and the Testing section disagree about what a test waits for:\n' +
      problems358.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`historyAlerts.test.jsx mocks the limit as ${small} (the page's is ${real}), the editor's completion test uses waitFor, and the Testing section says a test waits for its condition`);
  }
}

// -------------------------------------------------------------------------------------------------
// Every gateway health column the daemon can produce is written by the gate it goes through.
// `ingest_record_gateway_health()` names its columns literally in a SET clause; a metric added to
// GATEWAY_HEALTH_METRICS but not to that clause is extracted, logged as recognised, and dropped,
// with the page showing a stale value rather than an absent one.
function part2() {
  const py = read('ingestion/ingestion.py');
  const block = py.match(/GATEWAY_HEALTH_METRICS\s*=\s*\{([\s\S]*?)\n\}/);
  // The LAST definition in the chain, since a tail file may redefine the gate (0100 does): the
  // baseline's copy would pass this check while the one that runs dropped a column. `$$` for the
  // body tag: the baseline is generated from a dump, and pg_dump chooses its own delimiter.
  const fn = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => read(`supabase/migrations/${f}`).match(/CREATE OR REPLACE FUNCTION public\.ingest_record_gateway_health[\s\S]*?\$\$;/))
    .filter(Boolean)
    .at(-1);

  if (!block) {
    fail('check-docs-drift: could not find GATEWAY_HEALTH_METRICS in ingestion/ingestion.py.');
  } else if (!fn) {
    fail('check-docs-drift: could not find ingest_record_gateway_health() in any migration.');
  } else {
    // ("Metric_Name": ("column_name", "kind")) -- the column is what has to appear in the gate.
    // [a-z0-9_] and not [a-z_]: `load_1m` carries a digit, and a class without one drops it from
    // the corpus silently -- the check then passes while ignoring the column it was meant to guard.
    const columns = [...block[1].matchAll(/\(\s*"([a-z0-9_]+)"\s*,\s*"[a-z_]+"\s*\)/g)].map((m) => m[1]);
    const missing = columns.filter((c) => !new RegExp(`\\b${c}\\s*=`).test(fn[0]));

    if (missing.length) {
      fail(
        `ingest_record_gateway_health() does not write gateway health column(s): ${missing.join(', ')}.\n` +
          '      GATEWAY_HEALTH_METRICS in ingestion.py maps a Sparkplug metric onto each of these,\n' +
          '      so the daemon extracts the value, validates it, and then has nowhere to put it. The\n' +
          '      write is dropped without an error and the dashboard shows a stale value rather than\n' +
          '      a missing one.'
      );
    } else {
      pass(
        `all ${columns.length} gateway health column(s) in GATEWAY_HEALTH_METRICS are written by ` +
          `ingest_record_gateway_health()`
      );
    }
  }
}

export default function check() {
  part1();
  part2();
}
