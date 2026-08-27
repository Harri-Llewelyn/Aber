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
 *
 * `subject` NAMES A PRINCIPAL AND IS WHAT MAKES A NARROW SERVICE KEY POSSIBLE (roadmap item 16).
 * The anon and service-role keys carry a `role` and no `sub`, because they are not anybody --
 * PostgREST switches to the database role and RLS never asks who is calling. A key minted with a
 * `sub` is somebody: `role: authenticated` puts it through RLS like any signed-in user, and
 * `auth.uid()` resolves to the principal seeded in a migration.
 *
 * WHY NOT `scripts/mint-mcp-token.mjs`, which already signs tokens for a named principal. That
 * script enforces a 90-day ceiling, and it is right to: it mints tokens that get pasted into a
 * config file on somebody's laptop, cannot be revoked, and walk out of the building with the
 * machine. An infrastructure key held by a container is the other case entirely -- the one this
 * function's own comment above describes -- and giving it a 90-day expiry would take ingestion off
 * the air on a date nobody wrote down, which is exactly what that comment exists to prevent.
 */
function mintJwt(role, secret, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'supabase',
    role,
    ...(subject ? { sub: subject } : {}),
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
 * Service_Ingestor, seeded by migration 0046. Pinned here rather than looked up, for the reason
 * 0034's principal is pinned: this file runs before any database exists.
 */
const INGESTION_PRINCIPAL = 'b0000000-0000-4000-8000-000000000002';

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
  // The ingestion daemon's own credential (roadmap item 16). `authenticated` with a `sub`, not a
  // role that bypasses RLS: it authenticates as Service_Ingestor (migration 0046), which holds
  // Operator and therefore cannot write a single row directly. Every write it makes goes through
  // one of the SECURITY DEFINER gates in 0047, and those check that the caller IS this principal.
  //
  // The daemon still needs SUPABASE_ANON_KEY as well, and that is not a redundancy: the gateway's
  // apikey check admits exactly two literal keys, so this token would be refused at the edge if it
  // were sent as the apikey. It travels as the Authorization bearer, the way i3X passes a caller's
  // own token through to PostgREST.
  SUPABASE_INGESTION_KEY: mintJwt('authenticated', jwtSecret, INGESTION_PRINCIPAL),
  PG_META_CRYPTO_KEY: hex(32),
  REALTIME_DB_ENC_KEY: hex(8),          // EXACTLY 16 chars
  REALTIME_SECRET_KEY_BASE: hex(32),    // AT LEAST 64 chars
  // ONE MQTT PASSWORD PER PRINCIPAL, independently generated on purpose. mosquitto.acl confines
  // each account to a different subtree, which is worth nothing if one leaked password opens the
  // rest. The USERNAMES are not generated: most are `sparkplug_id`s derived from pinned UUIDs, and
  // the ACL matches the topic's edge-node segment against the username exactly.
  MQTT_INGESTION_PASSWORD: hex(24),
  MQTT_I3X_PASSWORD: hex(24),
  MQTT_VALIDATOR_PASSWORD: hex(24),
  MQTT_MONITOR_PASSWORD: hex(24),
  // THE FOUR SIMULATED CELL GATEWAYS, generated here rather than left to `provision:gateways`.
  //
  // THE FOUR GATEWAY PASSWORDS ARE NO LONGER MINTED HERE, and the deadlock they existed to break
  // is gone rather than worked around. The reasoning that put them here was sound at the time:
  // that script needs a RUNNING stack -- it talks to PostgREST and to the broker container -- but
  // node-red-init fails closed when a broker node declares a credential pair it cannot find, and
  // it runs during the very `docker compose up` that would bring that stack up. Leaving them to
  // provisioning meant the documented quickstart exited 1 on
  // `service "node-red-init" didn't complete successfully`, naming neither the flow, the variable,
  // nor the script that would have written it.
  //
  // What made that unavoidable was the FLOW being seeded unconditionally: four broker nodes, four
  // mandatory credential pairs. Roadmap §14 makes the simulator opt-in, so a default stack seeds a
  // starter flow with no broker nodes at all -- and minting four passwords here would now create
  // four broker accounts for four gateways that do not exist, on a stack whose whole point is that
  // it generates no assets.
  //
  // `npm run provision:gateways` mints them against a running stack and writes .env.gateways for
  // folding back in; `npm run stack:reset` does the whole sequence. See the block on these in
  // .env.example for which way authority runs afterwards.
  GRAFANA_ADMIN_PASSWORD: hex(12),
  GRAFANA_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_CREDENTIAL_SECRET: hex(32),
  NODERED_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_WEBHOOK_JWT_SECRET: hex(32),  // at least 32 chars
  // The bearer secret Grafana presents to grafana-alert-webhook. Its own value, not shared with any
  // other credential: it is the whole reason Grafana is not given the service-role key, and a secret
  // reused elsewhere would mean one leak reopens the authority this one exists to withhold.
  GRAFANA_ALERT_WEBHOOK_SECRET: hex(32),
  // The bearer token supabase-functions presents to the gateway-credential service. Its own value
  // for the same reason as the one above: that service can mint a Mosquitto account for any edge
  // node, and mosquitto.acl makes an account the ability to publish telemetry as that gateway --
  // so a token shared with anything else would mean one leak grants forgery across the site.
  // The service REFUSES TO START if this is shorter than 32 characters.
  MQTT_CREDENTIAL_SERVICE_TOKEN: hex(32),
  // The secret the `gateways` trigger presents to revoke-gateway-credential when a gateway is
  // archived or deleted (0038). SEPARATE FROM THE ONE ABOVE, and the asymmetry is the point: that
  // token authorises minting an account for ANY edge node, this one only authorises rotating a
  // decommissioned gateway's account to a password nobody records. Merging them would hand the
  // revocation path the issuance authority.
  //
  // GENERATED RATHER THAN LEFT EMPTY BECAUSE AN UNSET VALUE MAKES REVOCATION INERT -- archiving a
  // gateway would silently leave its broker credential working, which is a security control whose
  // default is "off". Every other secret on this list is generated for the same reason.
  GATEWAY_REVOKE_SECRET: hex(32),
  // The read-only historian role external BI tools connect as, and the one Grafana uses. Generated
  // like the rest so a local stack never runs a reporting tool as the `postgres` superuser, which
  // is what the Grafana datasource did before this existed.
  BI_READER_PASSWORD: hex(24),
};

/**
 * Names this script leaves EMPTY, each because a generated value would be a standing credential
 * nobody asked for.
 *
 * NODERED_ADMIN_TOKEN is break-glass: a static token accepted on the Node-RED admin API that
 * bypasses Supabase entirely, for when Supabase Auth is down. It returns permissions '*', and a
 * flow `function` node executes arbitrary JavaScript in a container holding the MQTT credential --
 * so minting one by default would create the most powerful credential in the stack, on the one
 * path that skips every check the rest of it performs.
 *
 * MQTT_SIMULATOR_PASSWORD is the RETIRED single-device simulator's broker account. Migration 0020
 * deletes its gateway row, so resolve_gateway() finds nothing for it and every message it could
 * publish is refused -- yet a password was generated on every `npm run setup` and mosquitto-init
 * created the account on every boot, on both targets. A live broker credential for an edge node
 * that has no asset record is exactly the thing an ACL audit is supposed to turn up.
 *
 * It is EMPTY rather than removed, because the account still has one real use: a Node-RED volume
 * created before the flow was consolidated still holds an `mqtt-broker-config` node that node-red-
 * init points at this pair. Setting a value here re-creates the account for that case;
 * mosquitto-init now skips it when empty, exactly as it already did for the four cell gateways.
 */
const deliberatelyEmpty = ['NODERED_ADMIN_TOKEN', 'MQTT_SIMULATOR_PASSWORD'];

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
