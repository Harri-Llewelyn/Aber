#!/usr/bin/env node
// =================================================================================================
// Re-sign the service keys the ingestion daemon, the playback worker and the release check
// authenticate with.
//
// Issue #101. `npm run setup` used to sign these for TEN YEARS, past the 90-day ceiling
// `service_token_max_days()` (0043) enforces on every other principal-bearing token in the stack --
// so an operator minting an API client's token by hand was held to 90 days while the two keys
// shipped with every installation ran until 2036.
//
// -------------------------------------------------------------------------------------------------
// WHY ROTATION IS CHEAP, WHICH IS THE FACT THE ISSUE ASSUMED AWAY
//
// The issue priced this as "the honest fix, and the expensive one", on the premise that there was no
// rotation mechanism. There did not need to be one built from scratch: these keys are signed with
// SUPABASE_JWT_SECRET, and RE-SIGNING THEM DOES NOT ROTATE THAT SECRET. A fresh token with a later
// `exp` is valid the moment it is signed, so nothing else in the stack is re-issued -- not the anon
// key, not the service-role key, not a gateway credential. The whole operation is:
//
//     mint two tokens -> put them in the release Secret -> restart two workloads
//
// Both workers read their key from the environment once, at import (`os.getenv` in ingestion.py and
// playback_worker.py), so a restart is what picks up a new value. There is no in-process refresh
// and this script does not pretend there is.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS DOES NOT DO: WITHDRAW THE OLD KEY
//
// It cannot, and neither can anything else. PostgREST validates a signature and consults no session
// table, so the previous key stays valid until its own `exp`. That is exactly why the lifetime is
// the bound that matters and why the ceiling exists: rotating a 90-day key leaves at most 90 days of
// overlap; rotating a ten-year one leaves ten years. Rotation shortens exposure going forward, it
// does not end it retroactively.
//
// -------------------------------------------------------------------------------------------------
// IT RECORDS BEFORE IT WRITES, the order mint-api-token.mjs argues for and for the same reason.
// A failure to record costs an audit row for a key nobody adopted, which is harmless. The reverse
// order costs a live credential with no record of it. Recording is BEST-EFFORT here rather than
// fatal, and that difference is deliberate: mint-api-token hands a token to a person and can
// refuse to print it, whereas this repairs a stack that may well be broken already -- refusing to
// rotate because the database is unreachable would withhold the fix from the case that needs it.
// It says loudly what it could not record.
//
// Usage:
//   node scripts/rotate-service-keys.mjs --check     # report days remaining, exit 1 if near/past
//   node scripts/rotate-service-keys.mjs             # re-sign all three and print them, with the commands to apply
//   node scripts/rotate-service-keys.mjs --apply     # ... and patch the release Secret, restart the workloads
//   node scripts/rotate-service-keys.mjs --days 30   # shorter than the 90-day default
//   node scripts/rotate-service-keys.mjs --anon-and-service-role   # ... and the API's two JWTs, ES256
//   node scripts/rotate-service-keys.mjs --signing-keys            # add the ES256 key pair, sign nothing
//
// IT SIGNS WITH WHAT THE STACK VERIFIES: ES256 with the private key in SUPABASE_JWT_KEYS once
// GoTrue publishes its kid (supabaseAuth.es256Signing is on), HS256 with SUPABASE_JWT_SECRET until
// then. An HS256 key verifies on both through 1.7; an ES256 one only once the switch is on.
//
// --signing-keys is the first of the three steps that move an existing site to ES256
// (help/site/upgrading.md, "From 1.7.0, sign tokens with ES256"): it mints the pair around the
// stack's own secret and writes it to the values file, or with --apply to the release Secret.
// Nothing reads the two values until the switch is on, so writing them changes nothing yet. It
// refuses a Secret that already holds a pair: replacing the signing key is the key-rotation
// runbook's, not this.
//
// --apply rewrites the Secret the pods read. A release installed from a values file must carry the
// new keys there too (--values=<file> rewrites secrets.ingestionKey, .playbackKey and
// .releaseCheckKey in it, adding the last where a file from before 0181 lacks it, and
// deploy/helm/aber/values-local.yaml is rewritten when it exists), or the next `helm upgrade`
// puts the old ones back; an externally managed Secret is updated where it lives.
// =================================================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  NAMESPACE, RELEASE, liveSigningKey, missingCredentialAdvice, stackCredentials,
} from './lib/stack-credentials.mjs';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  mintJwt, decodeJwt, daysUntilExpiry, generateSigningKeys,
  SERVICE_KEY_DEFAULT_DAYS, SERVICE_KEY_MAX_DAYS, EXPIRY_WARN_DAYS, INFRASTRUCTURE_KEY_DAYS,
} from './lib/service-jwt.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The keys, their principals and which workload reads each.
 *
 * PINNED, matching scripts/setup.mjs -- the principals are seeded by migrations and looked up by
 * nobody. `restart` names what has to be bounced for the new value to take, because a rotation an
 * operator forgets to apply is a rotation that did nothing.
 */
const KEYS = [
  {
    env: 'SUPABASE_INGESTION_KEY',
    valuesKey: 'ingestionKey',
    principal: 'b0000000-0000-4000-8000-000000000002',
    name: 'Service_Ingestor',
    restart: 'ingestion',
  },
  {
    env: 'SUPABASE_PLAYBACK_KEY',
    valuesKey: 'playbackKey',
    principal: 'b0000000-0000-4000-8000-000000000003',
    name: 'Service_Playback',
    restart: 'playback',
  },
  // OPTIONAL: read only with releaseCheck.enabled, and by a CronJob, which reads the Secret at each
  // run, so nothing restarts. Absent from a stack set up before 0181, which --check does not count
  // against it, and minted here so an existing site can turn the check on (docs/upgrades.md).
  {
    env: 'SUPABASE_RELEASE_CHECK_KEY',
    valuesKey: 'releaseCheckKey',
    principal: 'b0000000-0000-4000-8000-000000000004',
    name: 'Service_ReleaseCheck',
    restart: null,
    optional: 'releaseCheck.enabled',
  },
];

/**
 * The API's two JWTs, re-signed only with --anon-and-service-role: no principal, so no jti and no
 * record, and ten years like setup.mjs's. The gateway substitutes them into its config at start and
 * storage-api reads them at start, so both restart.
 */
const API_KEYS = [
  { env: 'SUPABASE_ANON_KEY', valuesKey: 'anonKey', role: 'anon' },
  { env: 'SUPABASE_SERVICE_ROLE_KEY', valuesKey: 'serviceRoleKey', role: 'service_role' },
];
const API_KEY_RESTARTS = ['supabase-envoy', 'supabase-storage'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const apply = args.includes('--apply');
const addSigningKeys = args.includes('--signing-keys');
const apiKeys = args.includes('--anon-and-service-role');
const valuesArg = args.find((a) => a.startsWith('--values='));
const valuesPath = valuesArg ? valuesArg.slice('--values='.length) : join(REPO, 'deploy', 'helm', 'aber', 'values-local.yaml');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : SERVICE_KEY_DEFAULT_DAYS;

if (!Number.isFinite(days) || days <= 0 || days > SERVICE_KEY_MAX_DAYS) {
  console.error(`❌ --days must be between 1 and ${SERVICE_KEY_MAX_DAYS} (got ${args[daysArg + 1] ?? days}).`);
  console.error(`   ${SERVICE_KEY_MAX_DAYS} is service_token_max_days() in archived migration 0043. A longer key`);
  console.error('   could not be recorded in the credential inventory and could not be withdrawn.');
  process.exit(1);
}

// The keys as the running stack holds them, from the release Secret (or the environment).
const creds = stackCredentials([
  'SUPABASE_JWT_SECRET', 'SUPABASE_JWT_KEYS', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', ...KEYS.map((k) => k.env),
]);
const envValue = (key) => creds[key] || '';

/** A token's alg, from its header: what a verifier picks its key by. */
function algorithmOf(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).alg ?? '?';
  } catch {
    return '?';
  }
}

/** YAML for a values file: compact JSON single-quoted (it holds no single quote), the rest double. */
const yamlValue = (value) => (value.includes('"') ? `'${value}'` : `"${value}"`);

/**
 * `key: value` set in a values file's text: the line rewritten where it exists, else added under
 * the `after` key at its indent. Null when neither line exists.
 */
function assign(text, key, value, after) {
  const line = new RegExp(`^(\\s*)${key}:.*$`, 'm');
  if (line.test(text)) return text.replace(line, (m, indent) => `${indent}${key}: ${yamlValue(value)}`);
  const anchor = after && new RegExp(`^(\\s*)${after}:.*$`, 'm');
  if (anchor && anchor.test(text)) return text.replace(anchor, (m, indent) => `${m}\n${indent}${key}: ${yamlValue(value)}`);
  return null;
}

/** Patches the release Secret with `values` (env name -> value); exits on a refusal. */
function patchSecret(values) {
  const patch = { data: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
  const patched = spawnSync('kubectl', ['-n', NAMESPACE, 'patch', 'secret', `${RELEASE}-secrets`, '--type=merge', '-p', JSON.stringify(patch)], { encoding: 'utf8' });
  if (patched.status !== 0) {
    console.error(`❌ could not patch the Secret: ${(patched.stderr || '').trim()}`);
    process.exit(1);
  }
}

// -------------------------------------------------------------------------------------------------
// --signing-keys: the ES256 key pair, around the secret the stack already signs with
// -------------------------------------------------------------------------------------------------
if (addSigningKeys) {
  const secret = envValue('SUPABASE_JWT_SECRET');
  if (!secret) {
    console.error('❌ ' + missingCredentialAdvice('SUPABASE_JWT_SECRET'));
    console.error('   The pair carries it as the legacy key, so HS256 tokens signed before keep verifying.');
    process.exit(1);
  }
  if (envValue('SUPABASE_JWT_KEYS')) {
    console.error('❌ The release Secret already holds SUPABASE_JWT_KEYS. Replacing the signing key would');
    console.error('   invalidate every ES256 token at once; supabase/README.md, "Rotating the ES256 signing key",');
    console.error('   adds a second key first.');
    process.exit(1);
  }
  const set = generateSigningKeys(secret);
  const values = { SUPABASE_JWT_KEYS: set.jwtKeys, SUPABASE_JWT_JWKS: set.jwtJwks };
  if (existsSync(valuesPath)) {
    const keysSet = assign(readFileSync(valuesPath, 'utf8'), 'jwtKeys', set.jwtKeys, 'jwtSecret');
    const both = keysSet && assign(keysSet, 'jwtJwks', set.jwtJwks, 'jwtKeys');
    if (both) {
      writeFileSync(valuesPath, both, { mode: 0o600 });
      console.log(`✅ Wrote secrets.jwtKeys and secrets.jwtJwks (kid ${set.kid}) into ${valuesPath}.`);
    } else {
      console.error(`⚠️  ${valuesPath} has no secrets.jwtSecret to write the pair beside; not rewritten.`);
    }
  }
  if (apply) {
    patchSecret(values);
    console.log(`✅ Added SUPABASE_JWT_KEYS and SUPABASE_JWT_JWKS (kid ${set.kid}) to ${RELEASE}-secrets.`);
  } else if (!existsSync(valuesPath)) {
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
    console.error(`Printed only. Add these two keys to the release Secret where it lives, or re-run with --apply.`);
  }
  console.log('');
  console.log('Nothing reads the pair until the switch is on. Next:');
  console.log('  1. Set supabaseAuth.es256Signing: true (site.yaml) and helm upgrade with the same values.');
  console.log('  2. npm run keys:rotate -- --apply --anon-and-service-role   (re-signs the JWTs ES256)');
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// --check: the answer to "a date nobody wrote down"
//
// THIS IS THE HALF THAT MAKES ANY LIFETIME SAFE, and it is why shortening the keys is not simply
// trading one silent outage for a more frequent one. The old ten-year expiry did not remove that
// failure, it deferred it to 2036 and removed every opportunity to notice.
//
// Exits non-zero when anything is within EXPIRY_WARN_DAYS or already past, so it can be a CI step
// or a cron line rather than something somebody remembers to run.
// -------------------------------------------------------------------------------------------------
if (checkOnly) {
  let worst = Infinity;
  console.log('Service key expiry:');
  for (const key of KEYS) {
    const token = envValue(key.env);
    if (!token && key.optional) {
      console.log(`  ${key.env.padEnd(26)} not set; read only with ${key.optional}`);
      continue;
    }
    if (!token) {
      console.log(`  ${key.env.padEnd(26)} MISSING from the release Secret`);
      worst = -Infinity;
      continue;
    }
    const remaining = daysUntilExpiry(token);
    const claims = decodeJwt(token) ?? {};
    if (remaining === null) {
      // A KEY WITH NO `exp` IS THE WORST CASE, NOT THE BEST. It never expires, which means it can
      // never be withdrawn -- so it is reported as a failure rather than as "no action needed".
      console.log(`  ${key.env.padEnd(26)} NO EXPIRY — this key can never be withdrawn`);
      worst = -Infinity;
      continue;
    }
    const whole = Math.floor(remaining);
    const state = remaining < 0 ? 'EXPIRED' : remaining < EXPIRY_WARN_DAYS ? 'DUE' : 'ok';
    console.log(
      `  ${key.env.padEnd(26)} ${String(whole).padStart(5)} days  ${new Date(Date.now() + remaining * 86400000).toISOString().slice(0, 10)}  ${state}`
      + `  ${algorithmOf(token)}  jti ${claims.jti ?? 'NONE'}`
    );
    worst = Math.min(worst, remaining);
  }
  // Not a failure in 1.7: HS256 still verifies everywhere, until 1.8.
  const hs256 = [...KEYS, ...API_KEYS].filter((k) => envValue(k.env) && algorithmOf(envValue(k.env)) === 'HS256');
  if (hs256.length) {
    console.log('');
    console.log(`  HS256, which stops verifying in 1.8: ${hs256.map((k) => k.env).join(', ')}.`);
    console.log('  Re-sign ES256 once supabaseAuth.es256Signing is on (help/site/upgrading.md, "From 1.7.0, sign tokens with ES256").');
  }

  if (worst < EXPIRY_WARN_DAYS) {
    console.error('');
    console.error(worst < 0
      ? '❌ At least one service key has expired. The worker holding it is failing every write.'
      : `⚠️  At least one service key expires within ${EXPIRY_WARN_DAYS} days.`);
    console.error('   Run `npm run keys:rotate -- --apply`, which restarts the workloads it names.');
    process.exit(1);
  }
  console.log('');
  console.log('✅ Every service key set is valid well beyond the warning window.');
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// Mint
// -------------------------------------------------------------------------------------------------
const supabaseUrl = envValue('SUPABASE_URL') || 'http://127.0.0.1:54321';
const secret = envValue('SUPABASE_JWT_SECRET');
const signing = await liveSigningKey({
  jwtKeys: envValue('SUPABASE_JWT_KEYS'), supabaseUrl, apikey: envValue('SUPABASE_PUBLISHABLE_KEY'),
});
if (apiKeys && !signing.key) {
  console.error(`❌ --anon-and-service-role re-signs them ES256, and ES256 is not live: ${signing.why}.`);
  console.error('   Turn supabaseAuth.es256Signing on first (help/site/upgrading.md, "From 1.7.0, sign tokens with ES256").');
  process.exit(1);
}
if (!signing.key && !secret) {
  console.error('❌ ' + missingCredentialAdvice('SUPABASE_JWT_SECRET'));
  console.error('   The new keys have to be signed with the');
  console.error('   SAME secret the stack already trusts — signing with a new one would invalidate');
  console.error('   the anon and service-role keys along with everything else.');
  process.exit(1);
}
const signedWith = signing.key ? `ES256 (kid ${signing.key.kid})` : `HS256 (${signing.why})`;

const minted = KEYS.map((key) => ({
  ...key,
  ...mintJwt({ role: 'authenticated', secret, signingKey: signing.key, subject: key.principal, days }),
}));
const mintedApi = apiKeys
  ? API_KEYS.map((key) => ({ ...key, ...mintJwt({ role: key.role, signingKey: signing.key, days: INFRASTRUCTURE_KEY_DAYS }) }))
  : [];

// -------------------------------------------------------------------------------------------------
// Record, best-effort — see the header for why this one is not fatal
// -------------------------------------------------------------------------------------------------
const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY');
const unrecorded = [];

for (const key of minted) {
  if (!serviceRoleKey) {
    unrecorded.push({ ...key, reason: 'SUPABASE_SERVICE_ROLE_KEY is not in the release Secret' });
    continue;
  }
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/record_service_token_issued`, {
      method: 'POST',
      headers: {
        apikey: envValue('SUPABASE_PUBLISHABLE_KEY'),
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_principal_id: key.principal,
        p_jti: key.jti,
        p_expires_at: key.expiresAt.toISOString(),
        // Only `os_user` and `host` are lifted out of this by 0043, and it labels them `claimed`
        // because the database cannot verify either.
        p_context: { os_user: userInfo().username, host: hostname(), tool: 'rotate-service-keys' },
      }),
    });
    if (!res.ok) unrecorded.push({ ...key, reason: `${res.status} ${(await res.text()).slice(0, 200)}` });
  } catch (err) {
    unrecorded.push({ ...key, reason: err.message });
  }
}

// -------------------------------------------------------------------------------------------------
// Apply, or print. The release Secret is what the pods read, so --apply patches it and restarts
// the workloads that read the keys at start. Without --apply the values are printed with the
// commands, for a Secret managed outside the cluster (External Secrets, SOPS), where the operator
// applies them where they live. Either way a values file the release was installed from is
// rewritten when it exists, or the next `helm upgrade` would put the old keys back.
// -------------------------------------------------------------------------------------------------
const all = [...minted, ...mintedApi];
const restart = [...new Set([
  ...minted.filter((k) => k.restart).map((k) => `deploy/${k.restart}`),
  ...(mintedApi.length ? API_KEY_RESTARTS.map((name) => `deploy/${name}`) : []),
])];
if (existsSync(valuesPath)) {
  let values = readFileSync(valuesPath, 'utf8');
  const notFound = [];
  for (const key of minted) {
    const pattern = new RegExp(`^(\\s*${key.valuesKey}:\\s*)"?[^"\\n]*"?\\s*$`, 'm');
    if (pattern.test(values)) {
      values = values.replace(pattern, (m, lead) => `${lead}"${key.token}"`);
      continue;
    }
    // A file written before this key existed: added under the key before it, at its indent.
    const before = minted[minted.indexOf(key) - 1];
    const anchor = key.optional && before && new RegExp(`^(\\s*)${before.valuesKey}:.*$`, 'm');
    if (anchor && anchor.test(values)) {
      values = values.replace(anchor, (line, indent) => `${line}\n${indent}${key.valuesKey}: "${key.token}"`);
      continue;
    }
    notFound.push(key.valuesKey);
  }
  for (const key of mintedApi) {
    const next = assign(values, key.valuesKey, key.token, null);
    if (next) values = next;
    else notFound.push(key.valuesKey);
  }
  if (notFound.length) {
    console.error(`⚠️  ${valuesPath} has no assignment for secrets.${notFound.join(', ')}; not rewritten.`);
  } else {
    writeFileSync(valuesPath, values, { mode: 0o600 });
    console.log(`✅ Rewrote ${all.map((k) => `secrets.${k.valuesKey}`).join(', ')} in ${valuesPath}.`);
  }
}
if (!apply) {
  for (const key of all) console.log(`${key.env}=${key.token}`);
  console.error('');
  console.error(`Signed ${signedWith}. Printed only. Put these in the release Secret (${RELEASE}-secrets in`);
  console.error(`${NAMESPACE}), or re-run with --apply to patch it here; then:  kubectl -n ${NAMESPACE} rollout restart ${restart.join(' ')}`);
  console.error('The release check reads its key at each run; nothing restarts for it.');
  process.exit(0);
}
patchSecret(Object.fromEntries(all.map((k) => [k.env, k.token])));
const restarted = spawnSync('kubectl', ['-n', NAMESPACE, 'rollout', 'restart', ...restart], { encoding: 'utf8' });
console.log(`✅ Re-signed ${minted.length} service keys for ${days} days, ${signedWith}, in the release Secret.`);
for (const key of minted) {
  console.log(`   ${key.env.padEnd(26)} ${key.name}  jti ${key.jti}`);
}
console.log(`   All expire ${minted[0].expiresAt.toISOString().slice(0, 10)}.`);
if (mintedApi.length) {
  console.log(`   And ${mintedApi.map((k) => k.env).join(' and ')}, for ${INFRASTRUCTURE_KEY_DAYS} days.`);
}
console.log(restarted.status === 0 ? `   Restarted ${restart.join(' ')}.` : `   Restart by hand: kubectl -n ${NAMESPACE} rollout restart ${restart.join(' ')}`);
console.log('');

if (unrecorded.length) {
  console.log('⚠️  Not recorded in the credential inventory:');
  for (const key of unrecorded) console.log(`   ${key.env}: ${key.reason}`);
  console.log('   The keys are valid regardless — recording is an audit row, not the credential.');
  console.log('   They will not appear on the Access Control page until a rotation records them.');
  console.log('');
}

// THE LAST LINE IS THE ONE THAT MATTERS. The two workers read their key once at import, so until
// these restart they are still presenting the previous token -- which still works, and is exactly
// what makes it easy to believe the rotation is finished when it is not.
console.log('⚠️  NOT LIVE YET. The two workers read their key at boot, so restart them:');
console.log(`   kubectl -n ${NAMESPACE} rollout restart ${KEYS.filter((k) => k.restart).map((k) => 'deploy/' + k.restart).join(' ')}`);
console.log('   The release check reads its key at its next run.');
console.log('   The previous keys keep working until they expire — rotation shortens exposure,');
console.log('   it cannot withdraw a token that is already out there.');
