import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 296. GoTrue's issuer is the site's public auth address (0260). auth.yaml sets GOTRUE_JWT_ISSUER to
// the API address with /auth/v1 after it, from the helper API_EXTERNAL_URL uses, so discovery names an
// absolute issuer and every token carries it. No jwt_authn provider on the gateway names an issuer: a
// token signed before the issuer was set has none, and nothing else here checks it. The author's guide
// and the security model say so.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const authYaml = read('deploy/helm/aber/templates/supabase/auth.yaml');
  const envoy = read('supabase/envoy.yaml');
  const problems296 = [];
  const issuer = authYaml.match(/- name: GOTRUE_JWT_ISSUER\s*\n\s*value: \{\{ printf "%s\/auth\/v1" \. \| quote \}\}/);
  const external = authYaml.match(/- name: API_EXTERNAL_URL\s*\n\s*value: \{\{ include "aber\.supabaseUrl" \. \| quote \}\}/);
  if (!external) problems296.push('auth.yaml no longer sets API_EXTERNAL_URL from aber.supabaseUrl, which the issuer is built beside');
  if (!issuer || !authYaml.includes('{{- with include "aber.supabaseUrl" . }}')) {
    problems296.push('auth.yaml does not set GOTRUE_JWT_ISSUER to the aber.supabaseUrl address and /auth/v1');
  }
  const named = envoy.split('\n').filter((l) => !l.trim().startsWith('#') && /^\s*issuer:/.test(l));
  if (named.length) problems296.push(`supabase/envoy.yaml names an issuer for a jwt_authn provider (${named.length}), which hides every token signed before GoTrue's issuer was set`);
  for (const [file, pieces] of [
    ['docs/sign-in-with-aber.md', ['/.well-known/openid-configuration', 'carries it as `iss`']],
    ['docs/security-model.md', ['GOTRUE_JWT_ISSUER', 'Nothing on the stack checks `iss`']],
  ]) {
    const text = read(file);
    for (const piece of pieces) if (!text.includes(piece)) problems296.push(`${file} does not say "${piece}"`);
  }
  if (problems296.length) {
    for (const p of problems296) fail(`GoTrue's issuer: ${p}`);
  } else {
    pass("GoTrue's issuer is the API address and /auth/v1 (auth.yaml, beside API_EXTERNAL_URL); no jwt_authn provider names one, and the author's guide and the security model say what that means");
  }
}
