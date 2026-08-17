/**
 * Create `.env` for a local stack — GENERATING the credentials rather than copying them.
 *
 * WHY THIS CHANGED. `.env.example` ships working Supabase demo values, and the documented
 * quickstart was `npm run setup`, which copied them verbatim. Two later changes made that
 * expensive: Kong now runs `key-auth` with the anon and service-role JWTs registered as gateway
 * API KEYS, so a default install accepts published credentials at its edge; and the four MQTT
 * principals' passwords are committed alongside them. The keys are in git, in this repository, and
 * in every other Supabase self-host guide on the internet.
 *
 * THE JWTS ARE A SET AND MUST BE GENERATED TOGETHER. `SUPABASE_ANON_KEY` and
 * `SUPABASE_SERVICE_ROLE_KEY` are HS256 JWTs *signed by* `SUPABASE_JWT_SECRET`. Rotating the
 * secret without re-minting both yields a stack that comes up entirely healthy and rejects every
 * request at the gateway — which is why this script mints them here instead of telling the reader
 * to run three `openssl` commands and hope. It is the same warning `acs-cymru.validateSecrets`
 * prints for the Helm path.
 *
 * NO NEW DEPENDENCIES. Node's built-in `crypto` does HMAC-SHA256, which is the whole of HS256, so
 * this stays a zero-install script that runs on any platform — the property `scripts/setup.mjs`
 * has always had (no POSIX shell, no openssl on PATH).
 *
 * `.env.example` KEEPS ITS DEMO VALUES, deliberately. CI does `cp .env.example .env` because a
 * pipeline needs the same credentials every run — the k3d job's `values-dev.yaml` carries the same
 * set for the same reason. `--demo` below is the supported way to ask for that behaviour so it is
 * a named choice rather than a shell command that bypasses this script.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

const demoMode = process.argv.includes('--demo');

/** Hex, not base64 or a passphrase alphabet. These values land in `postgres://user:pass@host`
 *  connection strings, a mosquitto password file, psql `-v` variables and YAML — hex is the one
 *  encoding that needs no escaping in any of them. A `+` or `/` from base64 eventually meets a
 *  URL parser or a shell and the failure is a connection refused three layers away. */
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Mint a Supabase HS256 JWT.
 *
 * The claims match what the demo tokens carry, because that is what the rest of the stack reads:
 * PostgREST switches to the database role named in `role`, GoTrue checks the signature against
 * SUPABASE_JWT_SECRET, and Kong treats the whole string as an opaque API key. `iss: supabase` is
 * what the Supabase tooling expects to see.
 *
 * `exp` is ten years out, matching the demo tokens' 2033. These are infrastructure keys held by
 * services, not user sessions: a short expiry here would silently take the stack off the air on a
 * date nobody wrote down, and there is no refresh path for them.
 */
function mintJwt(role, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'supabase',
    role,
    iat: now,
    exp: now + 10 * 365 * 24 * 60 * 60,
  }));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

console.log('🚀 Running ACS-Cymru Asset Tracking Environment Setup...');

if (fs.existsSync(envPath)) {
  console.log('ℹ️  .env already exists — left untouched. Delete it first if you want fresh credentials.');
  process.exit(0);
}
if (!fs.existsSync(envExamplePath)) {
  console.error('❌ .env.example not found.');
  process.exit(1);
}

let contents = fs.readFileSync(envExamplePath, 'utf8');

if (demoMode) {
  fs.writeFileSync(envPath, contents);
  console.log('✅ Created .env from .env.example VERBATIM (--demo).');
  console.log('⚠️  These are PUBLISHED credentials. Local development and CI only.');
  process.exit(0);
}

const jwtSecret = hex(32);

/**
 * Every value replaced, and why each is the length it is.
 *
 * Two carry hard limits enforced by the container rather than by taste — supabase/realtime refuses
 * to boot on anything else, and the Helm chart asserts the same two numbers in
 * `acs-cymru.validateRealtime`. Keep the three in step.
 */
const generated = {
  POSTGRES_PASSWORD: hex(24),
  DB_PASSWORD: hex(24),
  SUPABASE_JWT_SECRET: jwtSecret,
  SUPABASE_ANON_KEY: mintJwt('anon', jwtSecret),
  SUPABASE_SERVICE_ROLE_KEY: mintJwt('service_role', jwtSecret),
  PG_META_CRYPTO_KEY: hex(32),
  REALTIME_DB_ENC_KEY: hex(8),          // EXACTLY 16 chars
  REALTIME_SECRET_KEY_BASE: hex(32),    // AT LEAST 64 chars
  // FOUR MQTT PASSWORDS, ONE PER PRINCIPAL, and independently generated on purpose. mosquitto.acl
  // confines each account to a different subtree, which is worth nothing if one leaked password
  // opens all four. The USERNAMES are not generated: two of them are `sparkplug_id`s derived from
  // pinned UUIDs, and the ACL matches the topic's edge-node segment against the username exactly.
  MQTT_INGESTION_PASSWORD: hex(24),
  MQTT_I3X_PASSWORD: hex(24),
  MQTT_SIMULATOR_PASSWORD: hex(24),
  MQTT_VALIDATOR_PASSWORD: hex(24),
  MQTT_MONITOR_PASSWORD: hex(24),
  GRAFANA_ADMIN_PASSWORD: hex(12),
  GRAFANA_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_CREDENTIAL_SECRET: hex(32),
  NODERED_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_WEBHOOK_JWT_SECRET: hex(32),  // at least 32 chars
  // The bearer secret Grafana presents to grafana-alert-webhook. Its own value, not shared with any
  // other credential: it is the whole reason Grafana is not given the service-role key, and a secret
  // reused elsewhere would mean one leak reopens the authority this one exists to withhold.
  GRAFANA_ALERT_WEBHOOK_SECRET: hex(32),
  // The read-only historian role external BI tools connect as, and the one Grafana uses. Generated
  // like the rest so a local stack never runs a reporting tool as the `postgres` superuser, which
  // is what the Grafana datasource did before this existed.
  BI_READER_PASSWORD: hex(24),
};

/**
 * NODERED_ADMIN_TOKEN is deliberately NOT generated. It is break-glass: a static token accepted on
 * the Node-RED admin API that bypasses Supabase entirely, for when Supabase Auth is down. Minting
 * one by default would create a standing credential nobody asked for, on the one path that skips
 * every check the rest of this stack performs. It stays empty until an operator decides otherwise.
 */
const deliberatelyEmpty = ['NODERED_ADMIN_TOKEN'];

const missing = [];
for (const [key, value] of Object.entries(generated)) {
  // Anchored to the start of a line so a mention inside a comment is never rewritten.
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(contents)) {
    missing.push(key);
    continue;
  }
  // Function replacement: a generated secret can contain `$` sequences that `$&`-style
  // substitution would interpret rather than insert.
  contents = contents.replace(pattern, () => `${key}=${value}`);
}

/**
 * A key this script means to generate but cannot find is a HARD FAILURE, not a warning.
 *
 * The failure it prevents: someone renames a variable in `.env.example`, this script silently
 * stops generating it, and every install from then on ships the committed default for that one
 * value — which is exactly the bug this whole change exists to fix, reintroduced quietly for a
 * subset of the credentials.
 */
if (missing.length) {
  console.error(`❌ .env.example has no assignment for: ${missing.join(', ')}`);
  console.error('   Either the variable was renamed or it was removed. Fix scripts/setup.mjs to match');
  console.error('   — a credential this script cannot find is a credential it cannot rotate.');
  process.exit(1);
}

fs.writeFileSync(envPath, contents, { mode: 0o600 });

console.log(`✅ Created .env with ${Object.keys(generated).length} freshly generated credentials.`);
console.log('   The anon and service-role JWTs were signed with the new SUPABASE_JWT_SECRET, so the');
console.log('   three are a matching set. Nothing in .env is shared with any other install.');
console.log(`   Left empty on purpose: ${deliberatelyEmpty.join(', ')} (break-glass only).`);
console.log('');
console.log('⚠️  Demo LOGINS are separate and unchanged: admin@acs-cymru.local / acscymru123');
console.log('   and the other three accounts are seeded by supabase/seed.sql, not by .env.');
console.log('   Change them before anyone else can reach this stack.');
console.log('');
console.log('🎉 Environment file ready. Run `docker compose up --build -d`.');
