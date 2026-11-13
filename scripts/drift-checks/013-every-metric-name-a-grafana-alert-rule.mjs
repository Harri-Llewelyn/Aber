import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 13. Every metric name a Grafana alert rule queries exists in `metric_catalog`.
//
// `metric_catalog.name` is unique and immutable, so a rule naming the wrong case matches no row,
// evaluates an empty series and reports Normal forever; `noDataState: OK` turns that into silence
// by design. Scoped to quoted literals after `metric_name`, not every string in the file.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // One rule file. The Platform Conditions and Ingestion Pipeline groups count rows and read views;
  // the guard below is what stops "no metric named" from becoming silent if the shape changes.
  const RULES = ['grafana/provisioning/alerting/alert-rules.yaml'];
  const rules = RULES.map(read).join('\n');

  // `metric_name = 'X'` and `metric_name IN ('X', 'Y')` are the only two shapes the rules use.
  const named = new Set();
  for (const m of rules.matchAll(/metric_name\s*(?:=|IN)\s*\(?([^)\n]+)\)?/g)) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) named.add(lit[1]);
  }

  // Zero is the correct answer: no provisioned rule currently queries a metric by name. The check
  // re-arms the moment one does.
  if (named.size === 0) {
    pass('the provisioned alert rules query no metric by name, so there is no catalog agreement to check');
  } else {
    // No migration registers a metric (check 12), so the corpus is the example set, the names a
    // stack registers when asked to, with the migrations kept in case that ever changes.
    let catalog = read('supabase/example-metrics.sql');
    for (const f of readdirSync(join(REPO, 'supabase/migrations'))) {
      if (f.endsWith('.sql')) catalog += read(`supabase/migrations/${f}`);
    }

    // Matched against the INSERT's own quoted name, so a metric mentioned only in a comment does not
    // count as registered.
    const registered = new Set(
      [...catalog.matchAll(/INSERT INTO public\.metric_catalog VALUES \('[^']*',\s*'([^']+)'/g)]
        .map((m) => m[1])
    );
    // The named-column form, which the example set uses.
    for (const m of catalog.matchAll(/metric_catalog[\s\S]{0,400}?VALUES\s*\(\s*'([^']+)'/g)) {
      registered.add(m[1]);
    }

    const unknown = [...named].filter((n) => !catalog.includes(`'${n}'`));
    if (unknown.length) {
      fail(
        `Grafana alert rule(s) query metric name(s) absent from metric_catalog: ${unknown.join(', ')}.\n` +
          '      metric_catalog.name is UNIQUE and IMMUTABLE, so a wrong name matches no row and the\n' +
          '      rule evaluates an empty series -- reporting Normal forever, which is indistinguishable\n' +
          '      from a healthy floor.'
      );
    } else {
      pass(`all ${named.size} metric name(s) in the Grafana alert rules exist in metric_catalog`);
    }
  }

  // The contact point must not carry the service-role key. Comment lines are stripped first, since
  // that file's header explains why service_role is withheld and matching the prose would fail the
  // check on the documentation of the property it enforces.
  const contactPoint = read('grafana/provisioning/alerting/contact-points.template.yaml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (/SERVICE_ROLE/i.test(contactPoint)) {
    fail(
      'the Grafana contact point references a SERVICE_ROLE credential. Grafana is deliberately\n' +
        '      given only GRAFANA_ALERT_WEBHOOK_SECRET, which authorises recording an alert and\n' +
        '      nothing else; service_role bypasses RLS entirely and can rewrite audit_trail.'
    );
  } else {
    pass('the Grafana contact point holds only the scoped webhook secret');
  }
}
