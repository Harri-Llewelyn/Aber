import { ok, problems, read, SCHEMA } from './lib.mjs';

// 59. Every site that changes the platform for a covered role asks the MFA switch (0251). A write
// policy calls require_mfa() beside each has_role() arm naming Administrator or Shopfloor_Manager,
// in its final form and in storage-policies.sql; a function whose final body names either role in
// has_role() calls it too. Anything else is in supabase/mfa-exemptions.json with its reason, and an
// entry there that names no such site is stale. A new write policy or function with neither fails.
export default function check() {
  const before = problems.length;
  const exemptions = JSON.parse(read('supabase/mfa-exemptions.json'));
  const COVERED = /has_role\(ARRAY\[[^\]]*'(?:Administrator|Shopfloor_Manager)'/g;
  const count = (text, re) => (text.match(re) || []).length;
  // A machine-capable permission guards these, and require_mfa() admits every caller without a
  // covered role, so they call it though has_role() is not theirs.
  const GATED_BY_AUTHORITY = ['fork_schema', 'publish_schema_version', 'discard_schema_draft'];

  // Final policy forms: the last CREATE POLICY of each name on each table, in replay order.
  const policies = new Map();
  for (const m of SCHEMA.matchAll(/^CREATE POLICY (\S+) ON (\S+) FOR (\w+) [^\n]*$/gm)) policies.set(`${m[2]} ${m[1]}`, { cmd: m[3], text: m[0] });
  for (const m of read('supabase/storage-policies.sql').matchAll(/^CREATE POLICY "([^"]+)" ON storage\.objects\s+FOR (\w+)([\s\S]*?\);)$/gm)) {
    policies.set(`storage.objects ${m[1]}`, { cmd: m[2], text: m[3] });
  }
  const writes = [...policies].filter(([, p]) => p.cmd !== 'SELECT' && count(p.text, COVERED) > 0);
  for (const [name, p] of writes) {
    if (name in exemptions.policies) continue;
    if (count(p.text, /require_mfa\(\)/g) < count(p.text, COVERED)) {
      problems.push(`mfaSites: the ${p.cmd} policy ${name} admits Administrator or Shopfloor_Manager without require_mfa() beside each has_role(): add it, or exempt it in supabase/mfa-exemptions.json with its reason`);
    }
  }
  for (const name of Object.keys(exemptions.policies)) {
    if (!writes.some(([n]) => n === name)) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts the policy ${name}, which is no write policy naming a covered role`);
  }

  // Final function bodies, by name.
  const bodies = new Map();
  for (const m of SCHEMA.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\([\s\S]*?\bAS (\$[a-z_]*\$)([\s\S]*?)\2/g)) bodies.set(m[1], m[3]);
  const sites = [...bodies].filter(([, body]) => count(body, COVERED) > 0).map(([name]) => name);
  const ungated = sites.filter((name) => !bodies.get(name).includes('require_mfa()') && !(name in exemptions.functions));
  for (const name of ungated) {
    problems.push(`mfaSites: ${name}() names Administrator or Shopfloor_Manager in has_role() and calls no require_mfa(): call it after the role check if it changes the platform, or exempt it in supabase/mfa-exemptions.json with its reason`);
  }
  for (const name of Object.keys(exemptions.functions)) {
    if (!sites.includes(name)) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts ${name}(), whose final body names no covered role in has_role()`);
    else if (bodies.get(name).includes('require_mfa()')) problems.push(`mfaSites: supabase/mfa-exemptions.json exempts ${name}(), which calls require_mfa(): drop the entry`);
    if (!String(exemptions.functions[name]).trim()) problems.push(`mfaSites: the exemption of ${name}() gives no reason`);
  }
  for (const name of GATED_BY_AUTHORITY.filter((n) => !bodies.get(n)?.includes('require_mfa()'))) {
    problems.push(`mfaSites: ${name}() no longer calls require_mfa(); a person changes the platform through it`);
  }
  if (!writes.length || !sites.length) {
    problems.push('mfaSites: found no write policy or function naming a covered role -- the shape changed, so this check is no longer checking anything');
  } else if (problems.length === before) {
    const gated = sites.filter((n) => bodies.get(n).includes('require_mfa()')).length;
    ok.push(`mfaSites: ${writes.length} write policies and ${gated + GATED_BY_AUTHORITY.length} functions ask require_mfa(); ${Object.keys(exemptions.functions).length} functions are exempt, each with its reason`);
  }
}
