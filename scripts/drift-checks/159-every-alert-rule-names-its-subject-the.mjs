import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 159. Every alert rule names its subject the way grafana-alert-webhook reads it. An alert whose
// `entity_type` is `gateway` or `device` (the webhook's default) needs a `sparkplug_id` label, and
// a `service_identity` one a `principal_id`: without it the webhook skips the alert, which fires in
// Grafana and never reaches the dashboard. The label is set on the rule, as a literal or a template
// such as `{{ .Labels.edge_node }}`, or is a column a SQL query selects. And no label value holds a
// `$`: Grafana's file provisioning expands each label value as environment variables (`$$` is its
// escape), and not the annotations, so `{{ $labels.x }}` reaches the rule as `{{ .x }}`, which fails
// to expand and is sent as written.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const WEBHOOK = 'supabase/functions/grafana-alert-webhook/index.ts';
  const SUBJECT_LABEL = { device: 'sparkplug_id', gateway: 'sparkplug_id', service_identity: 'principal_id' };
  const accepted = new Set([...(read(WEBHOOK).match(/const ENTITY_TYPES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '')
    .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

  // The output names of a query's SELECT list: each top-level item's alias, else its bare column.
  const selectedColumns = (sql) => {
    const body = sql.replace(/--[^\n]*/g, '');
    const start = body.search(/\bSELECT\b/i);
    if (start === -1) return [];
    const items = [];
    let depth = 0;
    let quoted = false;
    let from = start + 'SELECT'.length;
    for (let i = from; i <= body.length; i += 1) {
      const c = body[i];
      const end = i === body.length
        || (!quoted && depth === 0 && /\s/.test(body[i - 1]) && /^FROM\b/i.test(body.slice(i)));
      if (end || (!quoted && depth === 0 && c === ',')) {
        items.push(body.slice(from, i));
        from = i + 1;
        if (end) break;
      } else if (c === "'") quoted = !quoted;
      else if (!quoted && c === '(') depth += 1;
      else if (!quoted && c === ')') depth -= 1;
    }
    return items.map((item) => item.trim().match(/"?(\w+)"?$/)?.[1]).filter(Boolean);
  };

  const rules = read(RULES).split(/^ {6}- uid: /m).slice(1).map((block) => {
    const labels = Object.fromEntries([...(block.match(/^ {8}labels:\n((?: {10}\S.*\n)+)/m)?.[1] ?? '')
      .matchAll(/^ {10}(\w+): *(.*)$/gm)].map(([, k, v]) => [k, v.trim().replace(/^(['"])(.*)\1$/, '$2')]));
    const sql = [...block.matchAll(/rawSql: \|\n((?:(?: {16}.*)?\n)+)/g)].map((m) => m[1]);
    return { uid: block.split('\n')[0].trim(), labels, columns: new Set(sql.flatMap(selectedColumns)) };
  });

  const missing = [];
  const expanded = [];
  let byLabel = 0;
  let byColumn = 0;
  for (const { uid, labels, columns } of rules) {
    for (const [name, value] of Object.entries(labels)) {
      if (value.split('$$').some((part) => part.includes('$'))) expanded.push(`${uid}: ${name}: ${value}`);
    }
    const type = labels.entity_type ?? 'device';
    const needs = SUBJECT_LABEL[type];
    if (!accepted.has(type)) {
      missing.push(`${uid}: entity_type "${type}" is not one ${WEBHOOK} accepts (${[...accepted].join(', ')})`);
    } else if (!needs) {
      continue;
    } else if (labels[needs]) {
      byLabel += 1;
    } else if (columns.has(needs)) {
      byColumn += 1;
    } else {
      missing.push(`${uid} (entity_type ${type}): no \`${needs}\` label and no query selecting a \`${needs}\` column`);
    }
  }

  if (rules.length < 30 || !accepted.size) {
    fail(`check 159 read ${rules.length} rule(s) from ${RULES} and ${accepted.size} entity type(s) from ${WEBHOOK}; `
      + 'the parse has stopped matching one of them');
  } else if (missing.length) {
    fail(`${missing.length} alert rule(s) fire in Grafana and never reach the dashboard, because the `
      + `webhook cannot tell what they are about:\n      ${missing.join('\n      ')}\n`
      + '      A Prometheus series names a gateway by its edge_node label: add\n'
      + "      `sparkplug_id: '{{ .Labels.edge_node }}'` to the rule's labels.");
  } else {
    pass(`all ${byLabel + byColumn} alert rule(s) about an asset or a machine identity name it as the webhook reads it `
      + `(${byLabel} by a label, ${byColumn} by a query column)`);
  }
  if (expanded.length) {
    fail(`${expanded.length} alert rule label(s) hold a \`$\`:\n      ${expanded.join('\n      ')}\n`
      + '      Grafana expands a provisioned label as environment variables, and not an annotation, so\n'
      + '      `{{ $labels.x }}` arrives as `{{ .x }}`, fails to expand and is sent as written. Write\n'
      + '      `{{ .Labels.x }}` (and `$$` for a literal dollar).');
  } else if (rules.length >= 30) {
    pass(`no alert rule label holds a \`$\`, which Grafana's provisioning would expand as an environment variable`);
  }
}
