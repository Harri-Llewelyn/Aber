import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 254. supabase/README.md's 0251 section lists every has_role() site as the code has it. Its policy
// table names each final-form policy that calls has_role(), in the migrations and in
// storage-policies.sql, with whether it calls require_mfa(); its function table names each function
// whose final body names a covered role in has_role(), with the same. A row the code contradicts,
// or a site with no row, is a classification nobody reviewed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems254 = [];
  const files = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const policies = new Map();
  const bodies = new Map();
  for (const f of files) {
    const sql = read(`supabase/migrations/${f}`);
    for (const m of sql.matchAll(/^CREATE POLICY (\S+) ON (\S+) FOR \w+ [^\n]*$/gm)) policies.set(`${m[2].replace(/^public\./, '')} ${m[1]}`, m[0]);
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\([\s\S]*?\bAS (\$[a-z_]*\$)([\s\S]*?)\2/g)) bodies.set(m[1], m[3]);
  }
  for (const m of read('supabase/storage-policies.sql').matchAll(/^CREATE POLICY "([^"]+)" ON storage\.objects\s+FOR \w+([\s\S]*?\);)$/gm)) {
    policies.set(`storage.objects ${m[1]}`, m[2]);
  }
  const readme = supabaseReadme();
  const at = readme.indexOf('### With MFA required, a change to the platform needs a session that gave its code (0251)');
  const section = at < 0 ? '' : readme.slice(at, readme.indexOf('\n### ', at + 10));
  // The policy table's first two cells are the table and the policy; the function table's first
  // is the function.
  const policyRows = new Map([...section.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| \w+ \| [^|]* \| (yes|no) \|/gm)]
    .map((m) => [`${m[1]} ${m[2]}`, m[3] === 'yes']));
  const functionRows = new Map([...section.matchAll(/^\| `([a-z0-9_]+)\(\)` \| `[^`]+` \| (yes|no) \|/gm)]
    .map((m) => [m[1], m[2] === 'yes']));
  if (!section || !policyRows.size || !functionRows.size) {
    problems254.push("supabase/README.md has no 0251 section with its two tables, so the classification is not checked");
  } else {
    const COVERED = /has_role\(ARRAY\[[^\]]*'(?:Administrator|Shopfloor_Manager)'/;
    for (const [name, text] of policies) {
      if (!text.includes('has_role(')) continue;
      const asks = text.includes('require_mfa()');
      if (!policyRows.has(name)) problems254.push(`the policy ${name} calls has_role() and has no row`);
      else if (policyRows.get(name) !== asks) problems254.push(`the policy ${name} is listed as ${policyRows.get(name) ? '' : 'not '}asking require_mfa(), and ${asks ? 'does' : 'does not'}`);
    }
    for (const name of policyRows.keys()) {
      if (!policies.get(name)?.includes('has_role(')) problems254.push(`a row names the policy ${name}, which calls no has_role()`);
    }
    for (const [name, body] of bodies) {
      const asks = body.includes('require_mfa()');
      if (!COVERED.test(body) && !(asks && functionRows.has(name))) continue;
      if (!functionRows.has(name)) problems254.push(`${name}() names a covered role in has_role() and has no row`);
      else if (functionRows.get(name) !== asks) problems254.push(`${name}() is listed as ${functionRows.get(name) ? '' : 'not '}asking require_mfa(), and ${asks ? 'does' : 'does not'}`);
    }
    for (const name of functionRows.keys()) {
      if (!bodies.has(name)) problems254.push(`a row names ${name}(), which no applied migration declares`);
    }
  }
  if (problems254.length) {
    for (const p of problems254) fail(`check 254: ${p}. supabase/README.md's 0251 section classifies every has_role() site.`);
  } else {
    pass(`supabase/README.md's 0251 tables classify all ${policyRows.size} has_role() policies and ${functionRows.size} functions as the code has them`);
  }
}
