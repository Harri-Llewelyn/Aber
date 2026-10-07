/**
 * Write a values file for a stack of your own, with the credentials generated rather than copied.
 *
 * values-dev.yaml ships working demo values that are in git and in every self-host guide, and the
 * gateway's key filter admits the anon and service-role JWTs as API keys, so a stack installed
 * from it accepts published credentials at its edge. This writes
 * deploy/helm/aber/values-local.yaml (gitignored) with every secret minted here:
 *
 *   npm run setup                        # asks two questions on a terminal
 *   npm run setup -- --domain=aber.example.com --admin-email=ops@example.com
 *
 * It ends with the next step docs/install.md gives: write site.yaml (step 6, "Describe your
 * site"), then install the published chart at Chart.yaml's `version:` (step 7, "Install Aber"):
 *
 *   helm install aber oci://ghcr.io/harri-llewelyn/aber/aber --version <version> \
 *     -n aber --create-namespace \
 *     -f deploy/helm/aber/values-local.yaml -f site.yaml --timeout 15m
 *
 * `--out=<path>` writes the values file elsewhere. An existing file is never overwritten.
 *
 * The JWTs are a set: the anon and service-role keys are HS256 JWTs signed by the JWT secret, and
 * rotating the secret without re-minting both yields a stack that comes up healthy and rejects
 * every request. Node's built-in `crypto` does HMAC-SHA256, so this stays a zero-install script.
 *
 * Two questions are asked, on a terminal only. The domain every host is published under, which is
 * what a browser and a Remote gateway both dial: `--domain=<base>` answers it from a script, and
 * without a terminal it is left at the chart's default. And the first administrator's email:
 * `--admin-email=<address>` answers it, and db-init creates that account with the password minted
 * here (migration 0163). Without one, nobody can sign in until it is set.
 *
 * For anything another person can reach, an externally managed Secret (`secrets.existingSecret`,
 * values-prod.yaml.example) is the intended home for these values; this file is the laptop and
 * the single box.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline/promises';
import { fileURLToPath } from 'url';
// SHARED WITH scripts/rotate-service-keys.mjs, which signs the same two keys again on a live
// stack (issue #101). lib/service-jwt.mjs is node:crypto and nothing else.
import {
  mintJwt, SERVICE_KEY_DEFAULT_DAYS, INFRASTRUCTURE_KEY_DAYS
} from './lib/service-jwt.mjs';
import { installCommand, readChartVersion } from './lib/release-chart.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = path.resolve(rootDir, outArg ? outArg.slice('--out='.length) : 'deploy/helm/aber/values-local.yaml');
/** The values file as the install command names it: relative to the checkout when it is inside it. */
const outRel = path.relative(rootDir, outPath);
const valuesFile = (outRel.startsWith('..') || path.isAbsolute(outRel) ? outPath : outRel).replace(/\\/g, '/');
const nextStep = installCommand({ version: readChartVersion(rootDir), valuesFile });

/** Hex: these values land in connection strings, psql `-v` variables and YAML, and hex needs no
 *  escaping in any of them. */
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

console.log('🚀 Aber setup: a values file with credentials of its own');

if (fs.existsSync(outPath)) {
  console.log(`ℹ️  ${path.relative(rootDir, outPath)} already exists — left untouched. Delete it first for fresh credentials.`);
  process.exit(0);
}

const jwtSecret = hex(32);

/** Service_Ingestor and Service_Playback, seeded by 0002. Pinned: this runs before any database
 *  exists. Two machine identities because the two hold different things at the broker. */
const INGESTION_PRINCIPAL = 'b0000000-0000-4000-8000-000000000002';
const PLAYBACK_PRINCIPAL = 'b0000000-0000-4000-8000-000000000003';

const ingestionKey = mintJwt({
  role: 'authenticated', secret: jwtSecret, subject: INGESTION_PRINCIPAL, days: SERVICE_KEY_DEFAULT_DAYS,
});
const playbackKey = mintJwt({
  role: 'authenticated', secret: jwtSecret, subject: PLAYBACK_PRINCIPAL, days: SERVICE_KEY_DEFAULT_DAYS,
});

/**
 * Every `secrets.*` key the chart reads, and why each is the length it is. Two carry hard limits
 * enforced by the supabase/realtime container and asserted by the chart's validateRealtime.
 */
const secrets = {
  jwtSecret,
  // Ten years: they carry a `role` and no `sub`, and they are the stack's API keys, so shortening
  // them needs a story for re-issuing them to every client at once.
  anonKey: mintJwt({ role: 'anon', secret: jwtSecret, days: INFRASTRUCTURE_KEY_DAYS }).token,
  serviceRoleKey: mintJwt({ role: 'service_role', secret: jwtSecret, days: INFRASTRUCTURE_KEY_DAYS }).token,
  // The key format Supabase replaces the two above with: opaque strings the gateway matches as
  // strings, not JWTs. Upstream's prefixes, so a leaked `sb_secret_` is recognisable on sight.
  publishableKey: `sb_publishable_${hex(24)}`,
  secretKey: `sb_secret_${hex(24)}`,
  // The two bounded principal keys (90 days): `authenticated` with a `sub`, which cannot write a
  // row directly. `npm run keys:check` reports their expiry.
  ingestionKey: ingestionKey.token,
  playbackKey: playbackKey.token,
  postgresPassword: hex(24),
  timescalePassword: hex(24),
  pgMetaCryptoKey: hex(32),
  realtimeDbEncKey: hex(8),          // EXACTLY 16 chars
  realtimeSecretKeyBase: hex(32),    // AT LEAST 64 chars
  realtimeMetricsJwtSecret: hex(32),
  // One MQTT password per principal, independently generated: the broker's roles confine each
  // account to a different subtree. The usernames keep the chart's defaults.
  mqttIngestionPassword: hex(24),
  mqttI3xPassword: hex(24),
  mqttValidatorPassword: hex(24),
  mqttMonitorPassword: hex(24),
  mqttDynsecAdminPassword: hex(24),
  // The bearer the edge functions present to the credential service (32+ chars, enforced), the
  // secret the gateways trigger presents to revoke a credential, and the one pg_cron presents to
  // sweep the forge. Each authorises one thing; generated because unset makes each inert.
  mqttCredentialServiceToken: hex(32),
  gatewayRevokeSecret: hex(32),
  forgeSweepSecret: hex(32),
  giteaAdminPassword: hex(12),
  giteaMachinePassword: hex(12),
  giteaOAuthClientSecret: hex(32),
  giteaProxyHmacSecret: hex(32),
  giteaWebhookSecret: hex(32),
  grafanaAdminPassword: hex(12),
  grafanaOAuthClientSecret: hex(32),
  grafanaAlertWebhookSecret: hex(32),
  // Studio's door: the credential the gateway presents at GoTrue and the cookie signing key.
  studioOAuthClientSecret: hex(32),
  studioProxyHmacSecret: hex(32),
  // The read-only historian role Grafana and BI tools use, and the two roles the stack cannot
  // run without.
  biReaderPassword: hex(24),
  ingestWriterPassword: hex(24),
  fdwReaderPassword: hex(24),
  noderedCredentialSecret: hex(32),
  noderedOAuthClientSecret: hex(32),
  noderedWebhookJwtSecret: hex(32),  // at least 32 chars
};

/** Left empty on purpose: a generated value would be a standing credential nobody asked for.
 *  noderedAdminToken is break-glass on the Node-RED admin API and bypasses Supabase entirely. */
const deliberatelyEmpty = ['noderedAdminToken'];

/** The forge's external SSH port on a site this sets up. k3s's ServiceLB binds a LoadBalancer's
 *  port on the node itself, and 22 there is the machine's own sshd. The chart's default stays 22,
 *  because an enrolled gateway keeps the clone URL and host key it was given. */
const FORGE_SSH_PORT = 2222;

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
function parseDomain(answer) {
  const domain = String(answer ?? '').trim().toLowerCase();
  if (!domain) return { domain: '' };
  if (/^[a-z]+:\/\//.test(domain) || domain.includes('/') || domain.includes(':')) {
    return { error: `'${domain}' is a URL or carries a port. Give the base domain alone; the hosts and scheme are derived.` };
  }
  if (!DOMAIN_SHAPE.test(domain)) return { error: `'${domain}' is not a domain name.` };
  if (domain === 'localhost' || domain.endsWith('.localhost') || domain.includes('127.0.0.1')) {
    return { error: `'${domain}' resolves to this machine only. An appliance cannot dial it; give the name or <ip>.nip.io the plant network resolves, or leave it blank.` };
  }
  return { domain };
}

/** From `--domain=`, else asked on a terminal, else blank. */
async function resolveDomain() {
  const flag = process.argv.find((a) => a.startsWith('--domain='));
  if (flag) {
    const parsed = parseDomain(flag.slice('--domain='.length));
    if (parsed.error) { console.error(`❌ --domain: ${parsed.error}`); process.exit(1); }
    return parsed.domain;
  }
  if (!process.stdin.isTTY) return '';
  console.log('');
  console.log('🌐 Every host is published under one domain: app.<domain>, api.<domain>, mqtt.<domain> and');
  console.log('   the rest. A browser and a Remote gateway both dial it, so it has to resolve on the');
  console.log('   plant network -- a name, or <ip>.nip.io. Leave it blank to keep the chart\'s loopback');
  console.log('   default, which works on this machine and withholds remote enrolment.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question('   Domain [blank = localhost]: ');
      const parsed = parseDomain(answer);
      if (!parsed.error) return parsed.domain;
      console.log(`   ${parsed.error}`);
    }
  } finally {
    rl.close();
  }
}

const domain = await resolveDomain();

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

/** From `--admin-email=`, else asked on a terminal, else blank. */
async function resolveAdminEmail() {
  const flag = process.argv.find((a) => a.startsWith('--admin-email='));
  if (flag) {
    const email = flag.slice('--admin-email='.length).trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) { console.error(`❌ --admin-email: '${email}' is not an email address.`); process.exit(1); }
    return email;
  }
  if (!process.stdin.isTTY) return '';
  console.log('');
  console.log('👤 The first administrator signs in with this email and the password printed at the end.');
  console.log('   db-init creates the account once; after that it is yours to change. Leave it blank and');
  console.log('   nobody can sign in until supabaseAuth.firstAdministrator is set.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question('   Email [blank = none]: ')).trim().toLowerCase();
      if (!answer || EMAIL_SHAPE.test(answer)) return answer;
      console.log(`   '${answer}' is not an email address.`);
    }
  } finally {
    rl.close();
  }
}

/** A password a person types once: 24 characters from an alphabet with no look-alikes, about 119
 *  bits, in groups of six. */
function typeablePassword() {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const chars = Array.from({ length: 24 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  return [0, 6, 12, 18].map((i) => chars.slice(i, i + 6).join('')).join('-');
}

const adminEmail = await resolveAdminEmail();
if (adminEmail) secrets.firstAdministratorPassword = typeablePassword();

/** Hand-written YAML: every value is hex, a JWT or a domain, none needs quoting beyond the quotes. */
const yamlLines = [
  '# Written by `npm run setup` on ' + new Date().toISOString().slice(0, 10) + '.' +
    (/^deploy\/helm\/.+\/values-(local|try)\.yaml$/.test(valuesFile) ? ' Not in git: .gitignore ignores it.' : ''),
  '# Every credential below was generated for this file and is shared with nothing;',
  '# the anon and service-role JWTs are signed by jwtSecret, so the three are a matching set.',
  '#',
  '# Next, write site.yaml (docs/install.md, step 6 "Describe your site"), then install (step 7):',
  '#',
  ...nextStep.map((line) => `#   ${line}`),
  '#',
  '# For a stack other people reach, move these into an externally managed Secret and set',
  '# secrets.existingSecret instead (values-prod.yaml.example).',
  '',
];
if (domain) {
  yamlLines.push('global:', `  publicBaseDomain: "${domain}"`, '');
}
if (adminEmail) {
  yamlLines.push('supabaseAuth:', '  firstAdministrator:', `    email: "${adminEmail}"`, '');
}
yamlLines.push(
  `# Gateways clone from the forge over SSH on ${FORGE_SSH_PORT}, leaving port 22 to this machine's own SSH.`,
  '# Enrolled gateways keep the port they enrolled with: do not change it once one is enrolled.',
  'gitea:', '  ssh:', '    external:', `      port: ${FORGE_SSH_PORT}`, '',
);
yamlLines.push('secrets:');
for (const [key, value] of Object.entries(secrets)) yamlLines.push(`  ${key}: "${value}"`);
for (const key of deliberatelyEmpty) yamlLines.push(`  # Break-glass only; left empty on purpose.`, `  ${key}: ""`);
yamlLines.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, yamlLines.join('\n'), { mode: 0o600 });

console.log(`✅ Wrote ${valuesFile} with ${Object.keys(secrets).length} freshly generated credentials.`);
console.log('   The anon and service-role JWTs were signed with the new jwtSecret, so the three are a');
console.log('   matching set. A publishable/secret key pair was minted too; the gateway accepts both');
console.log(`   formats. Left empty on purpose: ${deliberatelyEmpty.join(', ')} (break-glass only).`);
console.log('');
console.log('🔑 The two service keys expire, unlike the anon and service-role keys:');
console.log(`   ingestionKey  jti ${ingestionKey.jti}`);
console.log(`   playbackKey   jti ${playbackKey.jti}`);
console.log(`   Both valid ${SERVICE_KEY_DEFAULT_DAYS} days, until ${ingestionKey.expiresAt.toISOString().slice(0, 10)}.`);
console.log('   `npm run keys:check` reports the remaining days; `npm run keys:rotate` re-signs both.');
console.log('');
if (domain) {
  console.log(`🌐 Every host is under ${domain}: browsers and Remote gateways dial it, and the broker`);
  console.log('   certificate carries mqtt.' + domain + ' once mosquitto.tls.enabled is on.');
} else {
  console.log('🌐 No domain was given, so the dev values\' localhost stays: this machine only, and');
  console.log('   REMOTE GATEWAYS CANNOT BE ENROLLED. Set global.publicBaseDomain in the file later.');
}
console.log(`   Gateways clone from the forge over SSH on port ${FORGE_SSH_PORT}; port 22 stays with this`);
console.log('   machine\'s own SSH.');
console.log('');
if (adminEmail) {
  console.log(`👤 The first administrator: ${adminEmail}`);
  console.log(`   password ${secrets.firstAdministratorPassword}`);
  console.log('   Created by db-init on the install; also in the file above. Sign in at app.<domain>.');
} else {
  console.log('⚠️  No first administrator was given, so NOBODY CAN SIGN IN. Run again with');
  console.log('   --admin-email=<address> (delete the file first), or set supabaseAuth.firstAdministrator.email');
  console.log('   and secrets.firstAdministratorPassword (12+ characters) in it.');
}
console.log('');
console.log('🎉 Next, write site.yaml (docs/install.md, step 6 "Describe your site"). Then install');
console.log('   the release (step 7):');
console.log('');
for (const line of nextStep) console.log(`   ${line}`);
