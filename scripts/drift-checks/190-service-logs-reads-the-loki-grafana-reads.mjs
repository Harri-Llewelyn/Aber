import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 190. service-logs reads the Loki Grafana reads, and nothing else may. aber.lokiUrl (Grafana's
// datasource) is aber.lokiUrlOrNone with a refusal, so the two cannot name different stores; the
// functions Deployment sets LOKI_URL from aber.lokiUrlOrNone; main/index.ts forwards LOKI_URL to
// service-logs alone, since the store has no access control of its own; and the NetworkPolicy
// admits supabase-functions to loki on the port loki.yaml's Service serves. Each link missing reads
// as a store that cannot be reached, or as observability off, on a stack where it is on.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const helpers = read('deploy/helm/aber/templates/_helpers.tpl');
  const fnChart = read('deploy/helm/aber/templates/supabase/functions.yaml');
  const policy = read('deploy/helm/aber/templates/networkpolicy.yaml');
  const lokiChart = read('deploy/helm/aber/templates/obs/loki.yaml');
  const registry = read('supabase/functions/main/index.ts');
  const problems190 = [];

  const lokiUrl = helpers.match(/\{\{- define "aber\.lokiUrl" -\}\}([\s\S]*?)\{\{- end -\}\}\n\{\{- end -\}\}/)?.[1] ?? '';
  // The refusal's sentence names grafana.lokiUrl too, so only a value read or an address counts.
  if (!/include "aber\.lokiUrlOrNone" \./.test(lokiUrl) || /\.Values\.grafana\.lokiUrl|http:\/\/loki:/.test(lokiUrl)) {
    problems190.push('aber.lokiUrl does not take its address from aber.lokiUrlOrNone alone, so Grafana and the functions can name different stores');
  }
  if (!/include "aber\.lokiUrlOrNone" \.[\s\S]{0,40}\n\s*- name: LOKI_URL\n/.test(fnChart)) {
    problems190.push('templates/supabase/functions.yaml does not set LOKI_URL from aber.lokiUrlOrNone');
  }
  const block = registry.match(/const FUNCTION_REGISTRY[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const holders = [...block.matchAll(/^\s*"([a-z0-9-]+)"\s*:\s*\[([^\]]*)\]/gm)]
    .filter((m) => m[2].includes('"LOKI_URL"')).map((m) => m[1]);
  if (holders.join() !== 'service-logs') {
    problems190.push(`main/index.ts forwards LOKI_URL to ${holders.join(', ') || 'no function'}; service-logs alone may hold it`);
  }
  const lokiPort = lokiChart.match(/\n {2}ports:\n\s*- name: \S+\n\s*port: (\d+)/)?.[1];
  const edge = policy.match(/\(dict "from" "supabase-functions" "to" "loki"\s+"port" (\d+) "why" "([^"]+)"\)/);
  if (!edge) {
    problems190.push('networkpolicy.yaml has no supabase-functions -> loki edge');
  } else if (!lokiPort || edge[1] !== lokiPort) {
    problems190.push(`networkpolicy.yaml admits supabase-functions to loki on ${edge[1]}, and loki.yaml's Service serves ${lokiPort ?? '(not found)'}`);
  } else if (!edge[2].includes('service-logs')) {
    problems190.push("networkpolicy.yaml's supabase-functions -> loki edge does not say service-logs needs it");
  }
  if (problems190.length) {
    fail(`service-logs does not read the Loki Grafana reads:\n` + problems190.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`service-logs alone holds LOKI_URL, set from the helper Grafana's datasource derives from, and reaches loki:${lokiPort} through its own edge`);
  }
}
