import { edgeFunctionNames, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 44. Studio's door reads user_roles on every request, and Studio never sees the bearer.
//
// docs/security-model.md says a removed Administrator is refused at Studio's next request. That is
// the studio listener's ext_authz step to studio-admission, after rbac; without it the role claim
// admits until the token expires. jwt_authn forwards the token for that step, so header_mutation
// must remove it before the router, or Studio, which runs as the database owner, receives a
// Supabase JWT. Read as text from supabase/envoy.yaml; `sync-helm-chart-files.mjs --check` holds
// the chart's copy to it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const envoy = read('supabase/envoy.yaml');
  const start = envoy.indexOf('\n    - name: studio\n');
  const end = envoy.indexOf('\n    - name: ', start + 1);
  const listener = start < 0 ? '' : envoy.slice(start, end < 0 ? undefined : end);
  const filters = listener.slice(listener.indexOf('http_filters:'));
  const order = [...filters.matchAll(/^ {18}- name: envoy\.filters\.http\.([a-z0-9_]+)$/gm)].map((m) => m[1]);
  const expected = ['oauth2', 'jwt_authn', 'rbac', 'ext_authz', 'header_mutation', 'router'];
  /** One filter's own lines, up to the next filter in the chain. */
  const block = (name) => {
    const at = filters.indexOf(`- name: envoy.filters.http.${name}\n`);
    if (at < 0) return '';
    const next = filters.indexOf('\n                  - name: envoy.filters.http.', at + 1);
    return filters.slice(at, next < 0 ? undefined : next);
  };
  const problems44 = [];
  if (!listener) problems44.push('supabase/envoy.yaml has no `studio` listener');
  else if (order.join(',') !== expected.join(',')) {
    problems44.push(`the studio listener's http_filters run ${order.join(' -> ') || 'nothing'}; expected ${expected.join(' -> ')}`);
  }
  if (listener && !/path_prefix: \/studio-admission$/m.test(block('ext_authz'))) {
    problems44.push("the studio listener's ext_authz does not ask /studio-admission");
  }
  if (listener && !/- remove: authorization$/m.test(block('header_mutation'))) {
    problems44.push("the studio listener's header_mutation does not remove authorization, which jwt_authn forwards");
  }
  if (!edgeFunctionNames().includes('studio-admission')) {
    problems44.push('studio-admission is not in FUNCTION_REGISTRY, so the router answers its ext_authz step 404');
  }
  if (problems44.length) {
    for (const p of problems44) fail(`check 44: ${p}. docs/security-model.md says Studio refuses a removed Administrator at the next request.`);
  } else {
    pass("Studio's door asks studio-admission after rbac on every request, and strips the bearer before Studio");
  }
}
