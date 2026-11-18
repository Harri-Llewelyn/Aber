import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 468. The network policy's supabase-db -> prometheus route names every function that asks
// Prometheus. A function that fires a request at directory_prometheus_url() is a reader of the
// route, and a reader the policy's `why` does not name is one a person deleting the rule would not
// know to look for. The architecture page names the same readers.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems468 = [];
  const readers = new Set();
  const files = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^[0-9]{4}_.*\.sql$/.test(f));
  for (const file of files) {
    const sql = read(`supabase/migrations/${file}`);
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)) {
      const body = sql.slice(m.index, sql.indexOf('$$;', m.index));
      if (body.includes('public.directory_prometheus_url() ||')) readers.add(m[1]);
    }
  }
  if (readers.size === 0) problems468.push('no function asks directory_prometheus_url() for an address, so this check is no longer checking anything');

  const policy = read('deploy/helm/aber/templates/networkpolicy.yaml');
  const route = policy.split('\n').find((l) => l.includes('"from" "supabase-db"') && l.includes('"to" "prometheus"')) ?? '';
  const architecture = read('docs/kubernetes-architecture.md');
  const at = architecture.indexOf('- **`supabase-db → prometheus:9090`.**');
  const paragraph = at < 0 ? '' : architecture.slice(at, architecture.indexOf('\n\n', at));
  if (!route) problems468.push('the network policy has no supabase-db -> prometheus route');
  if (!paragraph) problems468.push('docs/kubernetes-architecture.md has no paragraph for the supabase-db -> prometheus route');
  for (const name of [...readers].sort()) {
    if (route && !route.includes(`${name}()`)) problems468.push(`the network policy's supabase-db -> prometheus route does not name ${name}()`);
    if (paragraph && !paragraph.includes(`${name}()`)) problems468.push(`docs/kubernetes-architecture.md's paragraph on that route does not name ${name}()`);
  }

  if (problems468.length) {
    fail('the Prometheus route and the functions that use it disagree:\n' + problems468.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the supabase-db -> prometheus route is named for each of the ${readers.size} functions that ask it (${[...readers].sort().join(', ')}), in the network policy and the architecture page`);
  }
}
