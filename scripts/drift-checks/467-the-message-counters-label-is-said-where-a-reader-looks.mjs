import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 467. The edge_node label of aber_ingestion_messages_total is said where a reader looks for it. The
// daemon's HELP text tells a Grafana user to sum, the ingestion README's metric table names both
// labels and says to sum, and the upgrade guide has a section for a site whose own panel or alert
// would change its answer. The guide is read with the unreleased notes folded in.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems467 = [];
  const metrics = read('ingestion/metrics.py');
  const help = metrics.slice(metrics.indexOf('"aber_ingestion_messages_total":\n'), metrics.indexOf('"aber_ingestion_messages_written_total":\n'));
  if (!help.includes('edge node') || !help.includes('sum()')) problems467.push("ingestion/metrics.py's HELP for the counter does not say it is labelled by edge node and is to be summed");

  const readme = read('ingestion/README.md');
  const row = readme.split('\n').find((l) => l.startsWith('| `aber_ingestion_messages_total` |')) ?? '';
  if (!row.includes('`msg_type`, `edge_node`')) problems467.push("ingestion/README.md's metric table does not list the counter's labels as msg_type and edge_node");
  if (!row.includes('Sum it')) problems467.push("ingestion/README.md's metric table does not tell a reader of the counter to sum it");

  const guide = upgradingGuide();
  const heading = '### From 1.9.0, `aber_ingestion_messages_total` is labelled by gateway\n';
  const start = guide.indexOf(heading);
  if (start < 0) {
    problems467.push('the upgrade guide has no "### From 1.9.0, `aber_ingestion_messages_total` is labelled by gateway" section');
  } else {
    const next = guide.indexOf('\n### ', start + heading.length);
    const section = guide.slice(start, next < 0 ? undefined : next);
    for (const phrase of ['edge_node', 'sum(', 'sum by (msg_type)']) {
      if (!section.includes(phrase)) problems467.push(`the upgrade guide's section on the counter's label does not say ${phrase}`);
    }
  }

  if (problems467.length) {
    fail("the message counter's edge_node label is not said where a reader looks:\n" + problems467.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("the message counter's edge_node label is in its HELP text, the ingestion README's metric table and an upgrade note that says to sum");
  }
}
