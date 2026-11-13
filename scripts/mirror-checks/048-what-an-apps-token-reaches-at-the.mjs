import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lastDefinition, ok, problems, read, ROOT } from './lib.mjs';

// 48. What an app's token reaches at the gateway. The API listener's app check (supabase/envoy.yaml)
// admits a token GoTrue issued to one of the stack's apps on all of /auth/v1/, and on the functions
// that app calls, by client id; each door listener signs in as a client of its own. An id
// stack_app_ids() does not list is an app the stack does not register, given a route; an id it lists
// that the stack-apps-sign-in policy lacks is an app of the stack held to the sign-in endpoints an
// outside app has; a function with no directory, or one the edge runtime's allow-list
// (functions/main/index.ts) does not name, is a route to nothing.
export default function check() {
  const before = problems.length;
  const envoy = read('supabase/envoy.yaml').replace(/\r\n/g, '\n');
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const listed = ids ? [...ids.body.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]) : [];
  const start = envoy.indexOf('\n    - name: gateway\n');
  const next = envoy.indexOf('\n    - name: ', start + 1);
  const gateway = start < 0 ? '' : envoy.slice(start, next < 0 ? undefined : next);
  const rbacAt = gateway.indexOf('- name: envoy.filters.http.rbac');
  const rbac = rbacAt < 0 ? '' : gateway.slice(rbacAt, gateway.indexOf('- name: envoy.filters.http.router', rbacAt));
  const lines = rbac.split('\n');
  const at = lines.findIndex((l) => /^\s*policies:\s*$/.test(l));
  const indent = at < 0 ? -1 : lines[at].search(/\S/) + 2;
  const routes = {};
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (line.length - line.trimStart().length === indent && /^\s*[a-z0-9-]+:\s*$/.test(line)) current = { ids: [], fns: [] };
    if (!current) continue;
    for (const m of line.matchAll(/string_match: \{ exact: ([0-9a-f-]{36}) \}/g)) current.ids.push(m[1]);
    for (const m of line.matchAll(/url_path: \{ path: \{ exact: "\/functions\/v1\/([a-z0-9-]+)" \} \}/g)) current.fns.push(m[1]);
    for (const id of current.ids) routes[id] = [...new Set([...(routes[id] || []), ...current.fns])];
  }
  const doors = [...envoy.matchAll(/^\s+client_id: ([0-9a-f-]{36})\s*$/gm)].map((m) => m[1]);
  const registry = read('supabase/functions/main/index.ts');
  const block = registry.slice(registry.indexOf('const FUNCTION_REGISTRY'), registry.indexOf('\n};', registry.indexOf('const FUNCTION_REGISTRY')));
  const registered = new Set([...block.matchAll(/^\s+"([a-z0-9-]+)": \[/gm)].map((m) => m[1]));

  if (!rbac || at < 0) {
    problems.push('appRoutes: found no app check (rbac policies) on the gateway listener in supabase/envoy.yaml -- the shape changed, so this check is no longer checking anything');
  } else if (Object.keys(routes).length === 0 || doors.length === 0 || registered.size === 0) {
    problems.push('appRoutes: found no app route, door client or registered function -- the shape changed, so this check is no longer checking anything');
  } else {
    for (const id of [...Object.keys(routes), ...doors].filter((x) => !listed.includes(x))) {
      problems.push(`appRoutes: supabase/envoy.yaml names the client ${id}, which stack_app_ids() (${ids?.file}) does not list: an app the stack does not register is given a route`);
    }
    for (const id of listed.filter((x) => !(x in routes))) {
      problems.push(`appRoutes: stack_app_ids() (${ids?.file}) lists the client ${id}, which the gateway's stack-apps-sign-in policy does not name: its token reaches the sign-in endpoints an outside app's does, and not the rest of /auth/v1/`);
    }
    for (const fn of Object.values(routes).flat()) {
      if (!existsSync(join(ROOT, 'supabase/functions', fn, 'index.ts'))) {
        problems.push(`appRoutes: the gateway admits an app's token to /functions/v1/${fn}, and supabase/functions/${fn}/index.ts does not exist`);
      } else if (!registered.has(fn)) {
        problems.push(`appRoutes: the gateway admits an app's token to /functions/v1/${fn}, which FUNCTION_REGISTRY in functions/main/index.ts does not name, so the edge runtime answers 404`);
      }
    }
    if (problems.length === before) {
      ok.push(`appRoutes: ${Object.entries(routes).map(([id, fns]) => `${id} -> ${fns.join(', ')}`).join('; ')}; the doors sign in as ${doors.join(', ')}; every id is in stack_app_ids() and every function exists and is registered`);
    }
  }
}
