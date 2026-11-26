import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 627. Only aas-api names where a device's live data is read. The Asset Interfaces Description names
// the site's broker and i3X server, so it is in the live API and never in a file aas-export writes,
// which leaves the site. shell.ts builds it for a worker given LIVE_ENDPOINTS' variables, and
// main/index.ts forwards a worker only what its entry names: aas-api's entry names each of them and
// aas-export's none. The chart sets each on the functions Deployment, and supabase/README.md names each.
// -------------------------------------------------------------------------------------------------
const entryOf = (registry, name) => registry.match(new RegExp(`\\n  "${name}": \\[([\\s\\S]*?)\\n  \\],`))?.[1];

export default function check() {
  const problems627 = [];
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const block = shell.match(/export const LIVE_ENDPOINTS: LiveEndpoints = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const names = [...block.matchAll(/Deno\.env\.get\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]);
  if (names.length < 3) problems627.push(`read ${names.length} variables out of LIVE_ENDPOINTS in shell.ts, so this check is no longer checking anything`);

  const registry = read('supabase/functions/main/index.ts');
  const api = entryOf(registry, 'aas-api');
  const exporter = entryOf(registry, 'aas-export');
  if (!api || !exporter) problems627.push('could not read the aas-api and aas-export entries out of main/index.ts');
  const chart = read('deploy/helm/aber/templates/supabase/functions.yaml');
  const readme = supabaseReadme();
  for (const name of names) {
    if (api && !api.includes(`"${name}"`)) problems627.push(`aas-api's entry in main/index.ts does not name ${name}, so its shells describe no interface`);
    if (exporter?.includes(`"${name}"`)) problems627.push(`aas-export's entry in main/index.ts names ${name}, so a file that leaves the site would name an internal endpoint`);
    if (!chart.includes(`- name: ${name}\n`)) problems627.push(`templates/supabase/functions.yaml does not set ${name}`);
    if (!readme.includes(`\`${name}\``)) problems627.push(`supabase/README.md does not name ${name}`);
  }

  if (problems627.length) {
    fail(`Where live data is read is not named by aas-api alone:\n${problems627.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`${names.join(', ')} are set by the chart, given to aas-api, kept from aas-export, and named in supabase/README.md`);
  }
}
