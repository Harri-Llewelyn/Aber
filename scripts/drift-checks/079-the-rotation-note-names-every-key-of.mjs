import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 79. The rotation note names every key of the chart's Secret that a post-upgrade hook copies into
// a database. db-init and timescaledb-maintenance hand them to psql as variables, so a rotated key
// reaches the database only when `helm upgrade` re-runs the hook. Both places that list them are
// held to the hooks' `-v name="$VAR"` arguments, both ways.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HOOKS = ['deploy/helm/aber/templates/jobs/db-init.yaml', 'deploy/helm/aber/templates/jobs/timescaledb-maintenance.yaml'];
  const copied = new Set();
  for (const hook of HOOKS) {
    const text = read(hook);
    // Each env var the hook fills from the chart's Secret, in either form the templates use.
    const fromSecret = new Map([
      ...[...text.matchAll(/include "aber\.(?:optional)?[sS]ecretEnv" \(dict "name" "([A-Z0-9_]+)" "secretName" \$secretName "key" "([A-Z0-9_]+)"\)/g)],
      ...[...text.matchAll(/- name: ([A-Z0-9_]+)\s+valueFrom:\s+secretKeyRef:\s+name: \{\{ \$secretName \}\}\s+key: ([A-Z0-9_]+)/g)],
    ].map((m) => [m[1], m[2]]));
    for (const m of text.matchAll(/-v [a-z0-9_]+="\$\{?([A-Z0-9_]+)/g)) {
      if (fromSecret.has(m[1])) copied.add(fromSecret.get(m[1]));
    }
  }
  const KEY = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  const example = read('deploy/helm/aber/values-prod.yaml.example');
  const runbook = read('deploy/k8s/README.md');
  const between = (text, from, to) => {
    const start = text.indexOf(from);
    const end = start < 0 ? -1 : text.indexOf(to, start + from.length);
    return end < 0 ? '' : text.slice(start, end);
  };
  const lists = [
    ['deploy/helm/aber/values-prod.yaml.example\'s "ROTATION IS NOT AUTOMATIC" note', between(example, 'ROTATION IS NOT AUTOMATIC', 'Consider Reloader')],
    ['deploy/k8s/README.md\'s *Secrets in production*', between(runbook, '### Secrets in production', '\n### ')],
  ];

  if (!copied.size || lists.some(([, text]) => !text)) {
    fail('check 79 found no Secret key a hook passes to psql, or lost the rotation note or *Secrets in production*, so it compares nothing');
  } else {
    let bad = 0;
    for (const [where, text] of lists) {
      const named = new Set([...text.matchAll(KEY)].map((m) => m[0]));
      for (const k of copied) {
        if (!named.has(k)) {
          bad++;
          fail(`a post-upgrade hook copies ${k} into a database, and ${where} does not name it: rotating it needs a helm upgrade, so name it there`);
        }
      }
      for (const k of named) {
        if (!copied.has(k)) {
          bad++;
          fail(`${where} names ${k}, which neither db-init nor timescaledb-maintenance passes to psql: remove it, or say why elsewhere`);
        }
      }
    }
    if (!bad) pass(`the rotation note and the runbook name the ${copied.size} Secret keys db-init and timescaledb-maintenance copy into a database`);
  }
}
