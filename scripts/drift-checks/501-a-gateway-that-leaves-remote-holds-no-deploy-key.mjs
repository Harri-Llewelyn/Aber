import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 501. A gateway that is no longer Remote holds no deploy key, as an archived one holds none (0311).
// forge-sweep decides with holdsDeployKey() in forge-sweep/keys.ts, for the gateway's own repository
// and for the platform repository, so it must read the row's deployment as well as is_archived. The
// change of type asks the sweep at once when a gateway with a repository leaves Remote, as an archive
// asks it. The lifecycle page and the Gateways help say the key goes and the repository stays. A
// sweep that judged by is_archived alone would leave the old appliance able to pull and push after its
// broker credential was ended.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems501 = [];

  const keys = read('supabase/functions/forge-sweep/keys.ts');
  const rule = keys.match(/export function holdsDeployKey\([^)]*\): boolean \{([\s\S]*?)\n\}/)?.[1];
  if (!rule) problems501.push('forge-sweep/keys.ts has no holdsDeployKey(), so this check cannot read the rule');
  else {
    if (!rule.includes('!gateway.is_archived')) problems501.push('holdsDeployKey() lets an archived gateway hold a deploy key');
    if (!rule.includes('gateway.deployment === "remote"')) problems501.push('holdsDeployKey() lets a gateway that is not Remote hold a deploy key');
  }

  const sweep = read('supabase/functions/forge-sweep/index.ts');
  const deployKeys = sweep.match(/async function sweepDeployKeys\([\s\S]*?\n\}/)?.[0] ?? '';
  const platformKeys = sweep.match(/async function sweepPlatformKeys\([\s\S]*?\n\}/)?.[0] ?? '';
  if (!deployKeys.includes('holdsDeployKey(gateway)')) problems501.push("sweepDeployKeys() does not decide a gateway's own keys with holdsDeployKey()");
  if (!platformKeys.includes('holdsDeployKey(')) problems501.push("sweepPlatformKeys() does not decide the platform repository's keys with holdsDeployKey()");
  if (!/\.select\("[^"]*\bdeployment\b[^"]*"\)/.test(sweep.match(/async function sweepRepositories\([\s\S]*?\n\}/)?.[0] ?? '')) {
    problems501.push("sweepRepositories() does not read the gateways' deployment, so holdsDeployKey() cannot see a change of type");
  }

  const files = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const needle = 'CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change(';
  const file = files.findLast((f) => read(f).includes(needle));
  if (!file) problems501.push('no migration declares clean_up_after_a_gateway_type_change(), so this check is no longer checking anything');
  else {
    const sql = read(file);
    const at = sql.lastIndexOf(needle);
    const body = sql.slice(at, sql.indexOf('$$;', sql.indexOf('AS $$', at)));
    if (!/IF OLD\.deployment = 'remote' AND NEW\.forge_repository_at IS NOT NULL THEN\s+PERFORM public\.sweep_forge\(\);/.test(body)) {
      problems501.push(`${file}: a gateway with a repository that leaves Remote does not ask the forge sweep at once`);
    }
  }

  const row = read('docs/gateway-lifecycle.md').split('\n').find((line) => line.startsWith('| **Remote, enrolled, to another type** |'));
  if (!row) problems501.push('docs/gateway-lifecycle.md has no row for an enrolled Remote gateway changed to another type');
  else if (!/removes the deploy key/.test(row.split('|')[6] ?? '') || !/repository is kept/.test(row.split('|')[6] ?? '')) {
    problems501.push("docs/gateway-lifecycle.md's Forge cell for an enrolled Remote gateway changed to another type does not say the key goes and the repository stays");
  }
  if (!read('help/pages/gateways.md').includes("A gateway that leaves Remote loses its appliance's deploy key")) {
    problems501.push('help/pages/gateways.md does not say a gateway that leaves Remote loses its deploy key');
  }

  if (problems501.length) {
    fail('a gateway that leaves Remote does not lose its deploy key everywhere it is said:\n' + problems501.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`forge-sweep removes the deploy keys of a gateway that is archived or not Remote, ${file.match(/\/(\d{4})_/)[1]}'s clean-up asks it at once, and the lifecycle page and the help say so`);
  }
}
