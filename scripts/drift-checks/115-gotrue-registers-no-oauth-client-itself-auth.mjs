import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 115. GoTrue registers no OAuth client itself. auth.yaml sets
// GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION to "false" and no other chart file names it, and
// every client a migration writes into auth.oauth_clients is 'manual'. A client anyone could register
// is a consent page away from a person's approval (0197). The inserts are of two kinds and no other:
// a seed, which pins one of the stack's four ids (c0ffee00-...0001 to 0004), and register_app() (0260),
// the one place an Administrator adds an app, which asks for the role and a second factor first. A
// seed of any other id fails, as does a second place that adds a client. check-gateway-surface
// --authenticated asserts the same of a live stack.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FLAG = 'GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION';
  const authYaml = 'deploy/helm/aber/templates/supabase/auth.yaml';
  const value = read(authYaml).match(/- name: GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION\s*\n\s*value:\s*(\S+)/)?.[1];
  const chartFiles = (dir) => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? chartFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  const elsewhere = chartFiles('deploy/helm/aber')
    .filter((f) => f !== authYaml && /\.(ya?ml|tpl|txt|json)$/.test(f) && read(f).includes(FLAG));

  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const STACK_CLIENT_IDS = ['1', '2', '3', '4'].map((n) => `c0ffee00-0000-4000-8000-00000000000${n}`);
  const inserts = files.flatMap((f) => {
    const text = read(`${dir}/${f}`);
    const found = [];
    for (let at = text.indexOf('INSERT INTO auth.oauth_clients'); at >= 0;
      at = text.indexOf('INSERT INTO auth.oauth_clients', at + 1)) {
      // Inside a function body when the nearest CREATE OR REPLACE FUNCTION before it has no $$; between.
      const fn = text.lastIndexOf('CREATE OR REPLACE FUNCTION public.', at);
      const inFunction = fn >= 0 && !text.slice(fn, at).includes('\n$$;')
        ? text.slice(fn).match(/^CREATE OR REPLACE FUNCTION public\.(\w+)/)?.[1] ?? null
        : null;
      const body = inFunction ? text.slice(fn, text.indexOf('\n$$;', at)) : '';
      // A seed names its client in the DO block it sits in.
      const pinned = text.slice(Math.max(text.lastIndexOf('DO $', at), 0), at).match(/v_client_id CONSTANT UUID := '([0-9a-f-]{36})'/)?.[1] ?? null;
      found.push({ file: f, statement: text.slice(at, text.indexOf(';', at)), inFunction, body, pinned });
    }
    return found;
  });
  const notManual = inserts.filter((i) => !i.statement.includes("'manual'") || i.statement.includes("'dynamic'"));
  const registrars = inserts.filter((i) => i.inFunction !== null);
  const seeds = inserts.filter((i) => i.inFunction === null);
  const strangers = seeds.filter((i) => !STACK_CLIENT_IDS.includes(i.pinned));
  const registrarFaults = registrars.length !== 1 ? [`${registrars.length} functions add a client, not the one register_app()`]
    : [registrars[0].inFunction !== 'register_app' ? `${registrars[0].file}'s ${registrars[0].inFunction}() adds a client, and only register_app() may` : null,
      !registrars[0].body.includes("has_role(ARRAY['Administrator'])") ? 'register_app() does not ask for the Administrator role' : null,
      !registrars[0].body.includes('PERFORM public.require_mfa();') ? 'register_app() does not ask for a second factor' : null].filter(Boolean);

  if (value !== '"false"') {
    fail(`${authYaml} sets ${FLAG} to ${value ?? 'nothing'}, not "false": anyone holding the publishable key can register an OAuth client and ask a person to approve it (0197)`);
  } else if (elsewhere.length) {
    fail(`${elsewhere.join(', ')} name(s) ${FLAG}: auth.yaml holds it "false", and nothing else in the chart may set it (0197)`);
  } else if (!seeds.length || notManual.length) {
    fail(`${notManual.length ? `${notManual.map((i) => i.file).join(', ')} write(s) an OAuth client that is not registration_type 'manual'` : 'no migration seeds an OAuth client, so this check reads nothing'}: the stack's clients are the ones its migrations seed (0197)`);
  } else if (strangers.length) {
    fail(`${strangers.map((i) => `${i.file} seeds ${i.pinned ?? 'a client with no pinned id'}`).join(', ')}, which is none of the stack's four (${STACK_CLIENT_IDS.map((id) => id.slice(-4)).join(', ')}): an app an Administrator adds is register_app()'s, and no migration seeds another (0260)`);
  } else if (registrarFaults.length) {
    fail(`an Administrator registers an app in exactly one place, register_app(), which asks for the role and a second factor first: ${registrarFaults.join('; ')} (0260)`);
  } else {
    pass(`GoTrue registers no OAuth client itself: ${FLAG} is "false" in auth.yaml alone, the ${seeds.length} client(s) the migrations seed are the stack's own and 'manual', and an Administrator adds one only through register_app(), which asks for the role and a second factor`);
  }
}
