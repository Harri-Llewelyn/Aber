import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 542. The branches Aber proposes a platform bump from admit the machine account alone, and every
// gateway repository has the rule. An Administrator who could write one, by a push or by a pull
// request merged into it, would approve a change of their own as Aber's, so the rule names the machine
// account for both and nobody else for either. Enrolment puts it on before the appliance's key. The
// prefix holds no slash, because the rule is addressed by name in the API's path and the gateway's
// forge-api listener refuses an escaped one. The suites and the documents name the same branches.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems542 = [];

  const bump = read('supabase/functions/_shared/platformBump.ts');
  const prefix = bump.match(/export const BUMP_BRANCH_PREFIX = "([^"]+)";/)?.[1];
  if (!prefix) problems542.push('platformBump.ts has no BUMP_BRANCH_PREFIX, so this check is no longer checking anything');
  else if (prefix.includes('/')) problems542.push(`the prefix ${prefix} holds a slash, which the rule's API path would carry escaped`);

  const forge = read('supabase/functions/_shared/forge.ts');
  const rule = forge.match(/export async function ensureBumpProtection\([\s\S]*?\n\}/)?.[0] ?? '';
  for (const line of [
    'enable_push: true,',
    'enable_push_whitelist: true,',
    'push_whitelist_usernames: [cfg.user],',
    'push_whitelist_teams: [],',
    'push_whitelist_deploy_keys: false,',
    'enable_force_push: false,',
    'enable_merge_whitelist: true,',
    'merge_whitelist_usernames: [cfg.user],',
    'merge_whitelist_teams: [],',
    'enable_bypass_allowlist: false,',
    'unprotected_file_patterns: "",',
  ]) {
    if (!rule.includes(line)) problems542.push(`ensureBumpProtection() does not ask for \`${line.slice(0, -1)}\``);
  }

  const provision = forge.match(/export async function provisionGatewayRepository\([\s\S]*?\n\}/)?.[0] ?? '';
  const put = provision.indexOf('await ensureBumpProtection(');
  const keyed = provision.indexOf('await ensureOnlyDeployKey(');
  if (put === -1 || keyed === -1 || put > keyed) problems542.push("enrolment does not put the rule on before the appliance's key");
  if (!read('supabase/functions/forge-sweep/index.ts').includes('ensureBumpProtection(cfg, name)')) {
    problems542.push('forge-sweep does not put the rule on the repositories it finds');
  }

  if (prefix) {
    for (const [what, text] of [
      ['test_forge_sweep_proposes_the_platform_bump.py', read('supabase/functions/forge-sweep/test_forge_sweep_proposes_the_platform_bump.py')],
      ['test_forge_events.py', read('supabase/functions/forge-events/test_forge_events.py')],
      ['supabase/README.md', supabaseReadme()],
      ['the upgrade guide', upgradingGuide()],
    ]) {
      if (!text.includes(prefix)) problems542.push(`${what} does not name ${prefix}`);
    }
  }

  if (problems542.length) {
    fail('the branches Aber proposes a platform bump from are not closed to everyone else:\n' + problems542.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the rule on ${prefix}* admits the machine account alone, to push and to merge, enrolment puts it on before the appliance's key and the sweep on what it finds`);
  }
}
