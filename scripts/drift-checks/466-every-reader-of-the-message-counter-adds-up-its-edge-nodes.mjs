import { allFiles, fail, isDriftCheck, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 466. Every reader of aber_ingestion_messages_total adds up its edge nodes. The counter is one
// series for each edge node and message type, so a query that does not sum it answers once for each
// gateway. Each expression in the alert rules, the dashboards, CI, the migrations and the documents
// has a `sum` or a `sum by (...)` before the counter on its line. The daemon counts each message
// under its edge node, the registry declares the label, and the load generator reads a message type
// out of the labels and sums over every edge node, not by matching a whole label string.
// -------------------------------------------------------------------------------------------------
const COUNTER = 'aber_ingestion_messages_total';
// Where an expression of the counter can be written. The upgrade guide and its notes show the
// answer that does not sum, as what to change; tests read the exposition and not an expression.
const READ_IN = /^(?:deploy|grafana|\.github|scripts|supabase\/migrations|docs|help|ingestion\/README\.md|test-harness\/README\.md)/;
const SKIPPED = (f) => isDriftCheck(f) || f.startsWith('unreleased/') || f === 'help/site/upgrading.md'
  || /(?:^|\/)test_[^/]*\.py$|\.test\.[jt]sx?$/.test(f) || f.startsWith('supabase/migrations/archive/');
const TEXT = /\.(?:ya?ml|json|sql|md|sh|mjs|tpl)$/;
const SUMMED = /\bsum(?: by \([^)]*\))?\s*\(/;

export default function check() {
  const problems466 = [];
  const unsummed = [];
  let readers = 0;
  for (const file of allFiles) {
    if (!READ_IN.test(file) || SKIPPED(file) || !TEXT.test(file)) continue;
    read(file).split('\n').forEach((line, i) => {
      const at = line.indexOf(COUNTER);
      if (at < 0) return;
      const before = line.slice(0, at);
      // An expression names the counter straight after an open parenthesis: `rate(` or `sum(`.
      if (!/\(\s*$/.test(before)) return;
      readers += 1;
      if (!SUMMED.test(before)) unsummed.push(`${file}:${i + 1}`);
    });
  }
  if (unsummed.length) problems466.push(`${unsummed.join(', ')} read ${COUNTER} without a sum in front of it, so each answers once for each edge node`);
  if (readers === 0) problems466.push(`no expression reads ${COUNTER}, so this check is no longer checking anything`);

  if (!read('ingestion/ingestion.py').includes('count(f"messages_{msg_type.lower()}", edge_node=edge_node_id)')) problems466.push('ingestion.py does not count each message under its edge node');
  if (!read('ingestion/registry.py').includes('["msg_type", "edge_node"]')) problems466.push(`registry.py does not declare ${COUNTER} with the labels msg_type and edge_node`);

  const harness = read('test-harness/load_generator.py');
  const receivedOf = harness.slice(harness.indexOf('def received_of('), harness.indexOf('def sequence_gaps('));
  if (!receivedOf.includes('label_values(labels)')) problems466.push('test-harness/load_generator.py does not read the message type out of the labels in received_of()');
  if (/labels\.lower\(\) in/.test(harness)) problems466.push('test-harness/load_generator.py matches a whole label string of the message counter, which the edge_node label makes match nothing');

  if (problems466.length) {
    fail(`the message counter's readers do not all add up its edge nodes:\n${problems466.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`${readers} expressions that read ${COUNTER} sum it over its edge nodes, the daemon labels each message with its edge node, and the load generator reads the type out of the labels`);
  }
}
