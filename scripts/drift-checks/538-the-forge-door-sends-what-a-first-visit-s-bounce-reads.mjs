import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 538. The forge's door sends forge-membership what a first visit's bounce reads, and nothing more.
//
// firstVisit.ts tells a page load by request headers, and Envoy sends an ext_authz service only the
// ones `allowed_headers` names. One it reads and the listener does not send is a bounce that never
// happens, so a first visit by a link is Gitea's "not found" again; one sent that nothing reads (the
// door's cookies, say) leaves the gateway for nothing. The path arrives under `path_prefix`, and the
// 302 reaches the browser only while `allowed_client_headers` names `location`. Read as text from
// supabase/envoy.yaml; `sync-helm-chart-files.mjs --check` holds the chart's copy to it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems538 = [];
  const bounce = read('supabase/functions/forge-membership/firstVisit.ts');
  const handler = read('supabase/functions/forge-membership/membership.ts');
  const envoy = read('supabase/envoy.yaml');
  const start = envoy.indexOf('\n    - name: forge\n');
  const end = envoy.indexOf('\n    - name: ', start + 1);
  const listener = start < 0 ? '' : envoy.slice(start, end < 0 ? undefined : end);
  const at = listener.indexOf('\n                  - name: envoy.filters.http.ext_authz\n');
  const next = listener.indexOf('\n                  - name: envoy.filters.http.', at + 1);
  const step = at < 0 ? '' : listener.slice(at, next < 0 ? undefined : next);

  /** The `- exact:` names under one key of the step, up to the first line indented no deeper than the key. */
  const exact = (key) => {
    const lines = step.split('\n');
    const from = lines.findIndex((l) => l.trim() === `${key}:`);
    if (from < 0) return [];
    const depth = lines[from].search(/\S/);
    const rest = lines.slice(from + 1);
    const to = rest.findIndex((l) => l.trim() && l.search(/\S/) <= depth);
    return rest.slice(0, to < 0 ? undefined : to).map((l) => l.trim())
      .filter((l) => l.startsWith('- exact: ')).map((l) => l.slice('- exact: '.length));
  };
  const reads = (src) => [...src.matchAll(/headers\.get\("([A-Za-z-]+)"\)/g)].map((m) => m[1].toLowerCase());
  const read538 = [...new Set([...reads(bounce), ...reads(handler)])].sort();
  const sent = exact('allowed_headers').sort();

  if (!step) problems538.push('supabase/envoy.yaml has no ext_authz step on its `forge` listener');
  else {
    if (!read538.length || read538.join() !== sent.join()) {
      problems538.push(`the forge listener's ext_authz sends [${sent.join(', ')}], and forge-membership reads [${read538.join(', ')}]`);
    }
    const prefix = (bounce.match(/^export const PATH_PREFIX = "([^"]+)";$/m) || [])[1];
    if (!prefix || !step.split('\n').some((l) => l.trim() === `path_prefix: ${prefix}`)) {
      problems538.push(`firstVisit.ts takes the browser's path from under ${prefix ?? 'no PATH_PREFIX'}, which is not the listener's path_prefix`);
    }
    if (!exact('allowed_client_headers').includes('location')) {
      problems538.push("the forge listener's ext_authz does not let `location` reach the browser");
    }
  }
  if (problems538.length) {
    for (const p of problems538) fail(`check 538: ${p}. A first visit by a link is bounced on these, or ends on Gitea's "not found".`);
  } else {
    pass(`the forge's door sends forge-membership the ${sent.length} headers it reads (${sent.join(', ')}), the path, and its redirect back`);
  }
}
