import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 145. Sign Out ends the sessions of the OAuth clients the two doors sign in as.
//
// end_my_door_sessions() (0208) names the Studio and forge doors' client ids, and the dashboard's
// Sign Out calls it. The doors sign in as the client_id their listener gives in supabase/envoy.yaml.
// A door whose id the function does not name keeps its GoTrue session after a Sign Out, and nothing
// fails: the browser simply stays signed in to that door.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const envoy = read('supabase/envoy.yaml');
  const clientOf = (name) => {
    const start = envoy.indexOf(`\n    - name: ${name}\n`);
    const end = envoy.indexOf('\n    - name: ', start + 1);
    const listener = start < 0 ? '' : envoy.slice(start, end < 0 ? undefined : end);
    return listener.match(/^ +client_id: ([0-9a-f-]{36})$/m)?.[1] ?? null;
  };
  const doors = { studio: clientOf('studio'), forge: clientOf('forge') };
  const migration = readdirSync(join(REPO, 'supabase', 'migrations'))
    .find((f) => /^0208_.*\.sql$/.test(f));
  const sql = migration ? read(`supabase/migrations/${migration}`) : '';
  const from = sql.indexOf('CREATE OR REPLACE FUNCTION public.end_my_door_sessions()');
  const to = sql.indexOf('ALTER FUNCTION public.end_my_door_sessions()');
  const body = from >= 0 && to > from ? sql.slice(from, to) : '';
  const ended = new Set([...body.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]));
  const signOut = read('frontend/src/utils/signOut.js');
  const problems145 = [];
  if (!body) problems145.push('no applied 0208 declares end_my_door_sessions()');
  for (const [door, id] of Object.entries(doors)) {
    if (!id) problems145.push(`supabase/envoy.yaml's ${door} listener names no client_id`);
    else if (!ended.has(id)) problems145.push(`end_my_door_sessions() does not end the ${door} door's sessions (client ${id})`);
  }
  for (const id of ended) {
    if (!Object.values(doors).includes(id)) problems145.push(`end_my_door_sessions() ends client ${id}, which no door signs in as`);
  }
  if (!/supabase\.rpc\('end_my_door_sessions'\)/.test(signOut)) {
    problems145.push('frontend/src/utils/signOut.js no longer calls end_my_door_sessions()');
  }
  if (problems145.length) {
    for (const p of problems145) fail(`check 145: ${p}. docs/security-model.md says Sign Out ends every door session the person holds.`);
  } else {
    pass(`Sign Out ends the sessions of the ${Object.keys(doors).length} door clients the gateway signs in as`);
  }
}
