import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 153. GoTrue offers TOTP second factors and no other kind, and the dashboard enrols only those.
// auth.yaml sets every GOTRUE_MFA_* below: phone needs an SMS provider, WebAuthn a hostname
// relying-party id and a secure context, and the dashboard's auth-js has no client for recovery
// codes, so a factor of any of those would be one nobody can use from Profile › Security.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const authYaml = 'deploy/helm/aber/templates/supabase/auth.yaml';
  const WANT = {
    GOTRUE_MFA_TOTP_ENROLL_ENABLED: '"true"', GOTRUE_MFA_TOTP_VERIFY_ENABLED: '"true"',
    GOTRUE_MFA_PHONE_ENROLL_ENABLED: '"false"', GOTRUE_MFA_PHONE_VERIFY_ENABLED: '"false"',
    GOTRUE_MFA_WEB_AUTHN_ENROLL_ENABLED: '"false"', GOTRUE_MFA_WEB_AUTHN_VERIFY_ENABLED: '"false"',
    GOTRUE_MFA_RECOVERY_CODES_ENROLL_ENABLED: '"false"', GOTRUE_MFA_RECOVERY_CODES_VERIFY_ENABLED: '"false"',
  };
  const text = read(authYaml);
  const set = Object.fromEntries([...text.matchAll(/- name: (GOTRUE_MFA_\w+)\s*\n\s*value:\s*(\S+)/g)].map((m) => [m[1], m[2]]));
  const wrong = [
    ...Object.entries(WANT).filter(([name, value]) => set[name] !== value)
      .map(([name, value]) => `${authYaml}: ${name} is ${set[name] ?? 'not set'}, not ${value}`),
    ...Object.keys(set).filter((name) => !(name in WANT))
      .map((name) => `${authYaml}: ${name} is set, and this check does not know it`),
  ];
  const enrolled = [...read('frontend/src/api.js').matchAll(/mfa\.enroll\(\{ factorType: '(\w+)'/g)].map((m) => m[1]);
  if (!enrolled.length || enrolled.some((t) => t !== 'totp')) {
    wrong.push(`frontend/src/api.js enrols ${enrolled.join(', ') || 'nothing this check can read'}, not TOTP alone`);
  }
  if (wrong.length) {
    fail(`second factors disagree:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  } else {
    pass(`GoTrue offers TOTP second factors alone (${Object.keys(WANT).length} GOTRUE_MFA_* in auth.yaml), and the dashboard enrols only TOTP`);
  }
}
