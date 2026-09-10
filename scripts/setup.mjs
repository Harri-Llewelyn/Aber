/**
 * Create `.env` for a local stack, generating the credentials rather than copying them.
 *
 * `.env.example` ships working demo values that are in git and in every self-host guide, and the
 * gateway's key filter admits the anon and service-role JWTs as API keys, so a copied `.env` is
 * a stack that accepts published credentials at its edge.
 *
 * The JWTs are a set: `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are HS256 JWTs signed
 * by `SUPABASE_JWT_SECRET`, and rotating the secret without re-minting both yields a stack that
 * comes up healthy and rejects every request. Node's built-in `crypto` does HMAC-SHA256, so this
 * stays a zero-install script.
 *
 * `.env.example` keeps its demo values: `--demo` is the supported way for CI to ask for them.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
// SHARED WITH scripts/rotate-service-keys.mjs, which signs the same two keys again on a live
// stack (issue #101). Still no new dependencies -- lib/service-jwt.mjs is node:crypto and nothing
// else, so this remains a zero-install script.
import {
  mintJwt, SERVICE_KEY_DEFAULT_DAYS, INFRASTRUCTURE_KEY_DAYS
} from './lib/service-jwt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

const demoMode = process.argv.includes('--demo');

/** Hex: these values land in connection strings, a mosquitto password file, psql `-v` variables
 *  and YAML, and hex needs no escaping in any of them. */
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/**
 * The claims live in scripts/lib/service-jwt.mjs, shared with the rotation script.
 *
 * The anon and service-role keys stay at ten years: they carry a `role` and no `sub`, and they
 * are the stack's API keys, so shortening them needs a story for re-issuing them to every client
 * at once. The two principal keys are bounded at 90 days, the same ceiling
 * `scripts/mint-mcp-token.mjs` enforces; `npm run keys:rotate` re-signs them with the same
 * secret, and `npm run keys:check` reports the expiry.
 */

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
 * Service_Ingestor, seeded by 0002. Pinned rather than looked up: this file runs before any
 * database exists.
 */
const INGESTION_PRINCIPAL = 'b0000000-0000-4000-8000-000000000002';

/**
 * Service_Playback, seeded by 0002. A second machine identity rather than a second use of the
 * first, because the two hold different things at the broker: the ingestion principal may
 * publish `spBv1.0/+/NCMD/+` only, and the playback worker publishes asset data as one gateway.
 */
const PLAYBACK_PRINCIPAL = 'b0000000-0000-4000-8000-000000000003';

/**
 * The two bounded keys, minted here rather than inline so their `jti` and expiry can be reported
 * at the moment they are created.
 */
const ingestionKey = mintJwt({
  role: 'authenticated', secret: jwtSecret, subject: INGESTION_PRINCIPAL,
  days: SERVICE_KEY_DEFAULT_DAYS,
});
const playbackKey = mintJwt({
  role: 'authenticated', secret: jwtSecret, subject: PLAYBACK_PRINCIPAL,
  days: SERVICE_KEY_DEFAULT_DAYS,
});

/**
 * Every value replaced, and why each is the length it is. Two carry hard limits enforced by the
 * container (supabase/realtime refuses to boot on anything else) and asserted by the chart's
 * `acs-cymru.validateRealtime`. Keep the three in step.
 */
const generated = {
  POSTGRES_PASSWORD: hex(24),
  DB_PASSWORD: hex(24),
  SUPABASE_JWT_SECRET: jwtSecret,
  SUPABASE_ANON_KEY: mintJwt({ role: 'anon', secret: jwtSecret, days: INFRASTRUCTURE_KEY_DAYS }).token,
  SUPABASE_SERVICE_ROLE_KEY: mintJwt({ role: 'service_role', secret: jwtSecret, days: INFRASTRUCTURE_KEY_DAYS }).token,
  // The key format that replaces the two above, minted alongside them. Opaque random strings,
  // not JWTs and not derived from SUPABASE_JWT_SECRET: the gateway matches the key as a string
  // and hands the upstream the legacy JWT. `npm run keys:rotate` does not touch them. Hex, for the
  // reason every other value here is hex. The prefixes are upstream's, so a leaked `sb_secret_`
  // is recognisable on sight.
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${hex(24)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${hex(24)}`,
  // The ingestion daemon's own credential (see Machine Identities in supabase/README.md):
  // `authenticated` with a `sub`, which cannot write a row directly; every write goes through a
  // SECURITY DEFINER gate that checks the caller is Service_Ingestor. The daemon still needs the
  // anon key as `apikey`; this token travels as the Authorization bearer.
  SUPABASE_INGESTION_KEY: ingestionKey.token,
  // The playback worker's own credential, same shape and reasoning. Its narrowness is what makes
  // the storage read arm meaningful: that policy admits this principal for exactly one object.
  SUPABASE_PLAYBACK_KEY: playbackKey.token,
  PG_META_CRYPTO_KEY: hex(32),
  REALTIME_DB_ENC_KEY: hex(8),          // EXACTLY 16 chars
  REALTIME_SECRET_KEY_BASE: hex(32),    // AT LEAST 64 chars
  // Mandatory from realtime v2.102.3 (`System.fetch_env!`). Signs the bearer token its /metrics
  // endpoint requires. Its own secret rather than SUPABASE_JWT_SECRET.
  REALTIME_METRICS_JWT_SECRET: hex(32),
  // One MQTT password per principal, independently generated: mosquitto.acl confines each account
  // to a different subtree. The usernames are not generated: most are `sparkplug_id`s.
  MQTT_INGESTION_PASSWORD: hex(24),
  MQTT_I3X_PASSWORD: hex(24),
  MQTT_VALIDATOR_PASSWORD: hex(24),
  MQTT_MONITOR_PASSWORD: hex(24),
  // No gateway passwords are minted here: nothing is seeded into the flow, and a gateway's account
  // is minted against a row that already exists, from the dashboard or by the enrolment bundle,
  // which is the only order in which its generated sparkplug_id can be known.
  GRAFANA_ADMIN_PASSWORD: hex(12),
  // Gitea's administrator, the only account the forge is meant to have. No shopfloor user gets an
  // account here; roles stay in Postgres.
  GITEA_ADMIN_PASSWORD: hex(12),
  // The machine account enroll-gateway authenticates as. Its own value, shared with nothing: the
  // administrator above is for a human at a browser, this one is held by an edge function, and a
  // single password would mean one leak grants both.
  GITEA_MACHINE_PASSWORD: hex(12),
  GRAFANA_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_CREDENTIAL_SECRET: hex(32),
  NODERED_OAUTH_CLIENT_SECRET: hex(32),
  NODERED_WEBHOOK_JWT_SECRET: hex(32),  // at least 32 chars
  // The bearer secret Grafana presents to grafana-alert-webhook. Its own value, not shared with any
  // other credential: it is the whole reason Grafana is not given the service-role key, and a secret
  // reused elsewhere would mean one leak reopens the authority this one exists to withhold.
  GRAFANA_ALERT_WEBHOOK_SECRET: hex(32),
  // The two halves of Studio's door (0081, and the `studio` listener in supabase/envoy.yaml): one
  // credential the gateway presents at GoTrue and the migration stores the hash of, read from one
  // variable; and the cookie signing key, which rotating signs everyone out. Generated because
  // unset silently disables access: an unset pair is a Studio that answers a login nobody can
  // complete.
  STUDIO_OAUTH_CLIENT_SECRET: hex(32),
  STUDIO_PROXY_HMAC_SECRET: hex(32),
  // The forge's door (0094, and the `forge` listener in supabase/envoy.yaml): the same two halves
  // as Studio's, for the same reasons.
  GITEA_OAUTH_CLIENT_SECRET: hex(32),
  GITEA_PROXY_HMAC_SECRET: hex(32),
  // The forge's push webhook (0095): what Gitea signs each delivery with and forge-events verifies.
  // Unset does not disable access, only the dashboard's early word of a merge -- but a secret
  // nobody chose is a secret nobody can leak, so it is generated with the rest.
  GITEA_WEBHOOK_SECRET: hex(32),
  // The bearer token supabase-functions presents to the gateway-credential service. Its own value:
  // that service can mint a Mosquitto account for any edge node, which is the ability to publish
  // as that gateway. The service refuses to start if this is shorter than 32 characters.
  MQTT_CREDENTIAL_SERVICE_TOKEN: hex(32),
  // The secret the `gateways` trigger presents to revoke-gateway-credential on archive or delete.
  // Separate from the token above: that authorises minting for any edge node, this only rotating
  // a decommissioned gateway's account. Generated because an unset value makes revocation inert.
  GATEWAY_REVOKE_SECRET: hex(32),
  // The read-only historian role external BI tools connect as, and the one Grafana uses. Generated
  // like the rest so a local stack never runs a reporting tool as the `postgres` superuser, which
  // is what the Grafana datasource did before this existed.
  BI_READER_PASSWORD: hex(24),
  // The two historian roles the stack cannot run without (`ingest_writer` for the daemon,
  // `fdw_reader` for the FDW mapping). Generated because the only alternative credential is the
  // historian superuser, and a stack that comes up on it says nothing about having done so.
  INGEST_WRITER_PASSWORD: hex(24),
  FDW_READER_PASSWORD: hex(24),
};

/**
 * Names this script leaves empty, each because a generated value would be a standing credential
 * nobody asked for. NODERED_ADMIN_TOKEN is break-glass: it returns permissions '*' on the
 * Node-RED admin API and bypasses Supabase entirely.
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
 * A key this script means to generate but cannot find is a hard failure: a renamed variable in
 * `.env.example` would otherwise silently ship the committed default for that one value.
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
console.log('   A publishable/secret key pair was minted too — the format Supabase replaces the anon');
console.log('   and service-role JWTs with by the end of 2026. The gateway accepts BOTH formats at');
console.log('   once, so nothing has to move to them today.');
console.log(`   Left empty on purpose: ${deliberatelyEmpty.join(', ')} (break-glass only).`);
console.log('');
// SAID AT THE MOMENT THEY ARE CREATED, because these now expire and the failure this change has to
// avoid is an operator learning the date from ingestion stopping. Issue #101: the ten years these
// replace were 40x the ceiling the platform enforces on every other principal-bearing token.
console.log('🔑 The two service keys expire — they are bounded, unlike the anon and service-role keys:');
console.log(`   SUPABASE_INGESTION_KEY  jti ${ingestionKey.jti}`);
console.log(`   SUPABASE_PLAYBACK_KEY   jti ${playbackKey.jti}`);
console.log(`   Both valid ${SERVICE_KEY_DEFAULT_DAYS} days, until ${ingestionKey.expiresAt.toISOString().slice(0, 10)}.`);
console.log('   `npm run keys:check` reports the remaining days; `npm run keys:rotate` re-signs both');
console.log('   in place. Rotation reuses SUPABASE_JWT_SECRET, so nothing else has to be re-issued.');
console.log('');
console.log('⚠️  Demo LOGINS are separate and unchanged: admin@acs-cymru.local / acscymru123');
console.log('   and the other three accounts are seeded by supabase/seed.sql, not by .env.');
console.log('   Change them before anyone else can reach this stack.');
console.log('');
console.log('🎉 Environment file ready. Run `docker compose up --build -d`.');
