import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10g. A gateway status is refused by one rule in the three places that hold it: ingestion's
// RESERVED_GATEWAY_STATUSES and MAX_GATEWAY_STATUS_LENGTH, the heartbeat gate
// ingest_record_gateway_health(), and the table's gateways_status_valid CHECK. A CHECK narrower
// than the gate fails the heartbeat's UPDATE, and a live gateway goes STALE.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const py = read('ingestion/ingestion.py');
  const chain = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => read(`supabase/migrations/${f}`)).join('\n');
  // The last declaration wins on replay, so the gate is read from there.
  const gateAt = chain.lastIndexOf('CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(');
  const gate = gateAt < 0 ? '' : chain.slice(gateAt, chain.indexOf('$$;', gateAt));
  const checkAt = chain.lastIndexOf('ADD CONSTRAINT gateways_status_valid');
  const check = checkAt < 0 ? '' : chain.slice(checkAt, chain.indexOf(';', checkAt));
  const words = (m) => (m ? [...m[1].matchAll(/['"]([A-Z_]+)['"]/g)].map((w) => w[1]).sort().join(', ') : null);

  const places = [
    ['ingestion.py', words(py.match(/^RESERVED_GATEWAY_STATUSES = frozenset\(\{([^}]*)\}\)/m)),
      py.match(/^MAX_GATEWAY_STATUS_LENGTH = (\d+)$/m)?.[1]],
    ['ingest_record_gateway_health()', words(gate.match(/upper\(p_status\) IN \(([^)]*)\)/)),
      gate.match(/length\(p_status\) > (\d+)/)?.[1]],
    // As written (`NOT IN (...)`) or as the baseline's dump renders it (`<> ALL (ARRAY[...])`).
    ['gateways_status_valid', words(check.match(/upper\(status\) (?:NOT IN \(|<> ALL \(ARRAY\[)([^)\]]*)[)\]]/)),
      check.match(/length\(status\) <= (\d+)/)?.[1]],
  ];
  const unread = places.filter(([, reserved, cap]) => !reserved || !cap).map(([where]) => where);
  if (unread.length) {
    fail(`could not read the reserved gateway statuses or the length cap from ${unread.join(', ')}; `
      + 'the shape this check reads has changed, so it is checking nothing.');
  } else if (new Set(places.map(([, reserved, cap]) => `${reserved} / ${cap}`)).size > 1) {
    fail('the gateway status rule disagrees between the places that hold it:\n'
      + places.map(([where, reserved, cap]) => `        ${where}: reserved ${reserved}; at most ${cap} characters`).join('\n'));
  } else {
    pass(`ingestion, the heartbeat gate and gateways_status_valid reserve ${places[0][1]} and cap a status at ${places[0][2]}`);
  }
}
