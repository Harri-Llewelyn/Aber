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
// the key set's private key, and RE-SIGNING THEM DOES NOT ROTATE THAT KEY. A fresh token with a later
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
//   node scripts/rotate-service-keys.mjs --check     # days remaining, what 1.8.0 needs, HS256 tokens to re-mint
//   node scripts/rotate-service-keys.mjs             # re-sign all three and print them, with the commands to apply
//   node scripts/rotate-service-keys.mjs --apply     # ... and patch the release Secret, restart the workloads
//   node scripts/rotate-service-keys.mjs --days 30   # shorter than the 90-day default
//   node scripts/rotate-service-keys.mjs --anon-and-service-role   # ... and the API's two JWTs
//   node scripts/rotate-service-keys.mjs --signing-keys            # complete the signing set for 1.8.0
//   node scripts/rotate-service-keys.mjs --service-secrets         # replace Realtime's and Storage's secrets
//
// IT SIGNS ES256 with the private key in SUPABASE_JWT_KEYS, and only once GoTrue publishes its kid:
// a token no verifier takes would be no rotation at all.
//
// --signing-keys brings a site made before 1.8.0 to what it needs (lib/signing-set.mjs): the ES256
// pair, its JWTs signed again by it, the HS256 key out of the set, and Realtime's and Storage's own
// secrets. It completes the values file when there is one, and the release Secret otherwise, keeping
// every value that already meets it. With --apply it patches the release Secret and restarts nothing:
// the `helm upgrade` to 1.8.0 that follows does (help/site/upgrading.md, "From 1.8.0, every token is
// signed ES256"). --service-secrets replaces the two secrets and, with --apply, restarts Realtime
// and Storage; a signed URL Storage issued before stops working.
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
  mintJwt, decodeJwt, daysUntilExpiry, algorithmOf,
  SERVICE_KEY_DEFAULT_DAYS, SERVICE_KEY_MAX_DAYS, EXPIRY_WARN_DAYS, INFRASTRUCTURE_KEY_DAYS,
} from './lib/service-jwt.mjs';
import {
  KEY_SET, SERVICE_SECRETS, completeSigningSet, completeValuesText, newServiceSecret, readSecrets,
  secretFromUpdates, valuesFromSecret, writeSecrets,
} from './lib/signing-set.mjs';
import { readEs256Since } from './lib/signing-history.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = 'help/site/upgrading.md, "From 1.8.0, every token is signed ES256"';

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
const API_JWTS = [
  { env: 'SUPABASE_ANON_KEY', valuesKey: 'anonKey', role: 'anon' },
  { env: 'SUPABASE_SERVICE_ROLE_KEY', valuesKey: 'serviceRoleKey', role: 'service_role' },
];
const API_JWT_RESTARTS = ['supabase-envoy', 'supabase-storage'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const apply = args.includes('--apply');
const signingKeys = args.includes('--signing-keys');
const serviceSecrets = args.includes('--service-secrets');
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
  'SUPABASE_JWT_KEYS', 'SUPABASE_JWT_JWKS', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', ...KEYS.map((k) => k.env), ...SERVICE_SECRETS.map((s) => s.env),
]);
const envValue = (key) => creds[key] || '';
const supabaseUrl = envValue('SUPABASE_URL') || 'http://127.0.0.1:54321';

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
// --signing-keys: the signing set 1.8.0 needs, completed where it lives
//
// From the values file when there is one, since `helm upgrade` renders the Secret from it; else from
// the release Secret, for a Secret kept elsewhere. Completing both separately would mint two pairs.
// -------------------------------------------------------------------------------------------------
if (signingKeys) {
  let updates;
  let notes;
  if (existsSync(valuesPath)) {
    let completed;
    try {
      completed = completeValuesText(readFileSync(valuesPath, 'utf8'));
    } catch (err) {
      console.error(`❌ ${valuesPath} could not be completed: ${err.message}. It is left as it was.`);
      process.exit(1);
    }
    if (completed.changed) writeFileSync(valuesPath, completed.text, { mode: 0o600 });
    notes = completed.notes;
    const after = readSecrets(completed.text);
    updates = Object.fromEntries([...KEY_SET, ...API_JWTS, ...KEYS, ...SERVICE_SECRETS]
      .filter(({ valuesKey }) => after[valuesKey]).map(({ valuesKey }) => [valuesKey, after[valuesKey]]));
    console.log(completed.changed ? `✅ Completed ${valuesPath}:` : `ℹ️  ${valuesPath} already holds the signing set 1.8.0 needs.`);
  } else {
    const present = Object.fromEntries([...KEY_SET, ...API_JWTS, ...KEYS, ...SERVICE_SECRETS].map((k) => [k.env, envValue(k.env)]));
    if (!present.SUPABASE_ANON_KEY) {
      console.error('❌ ' + missingCredentialAdvice('SUPABASE_ANON_KEY'));
      console.error(`   With no values file at ${valuesPath}, the set is completed from the release Secret.`);
      process.exit(1);
    }
    let completed;
    try {
      completed = completeSigningSet(valuesFromSecret(present));
    } catch (err) {
      console.error(`❌ The release Secret's signing set could not be completed: ${err.message}.`);
      process.exit(1);
    }
    ({ updates, notes } = completed);
    if (!Object.keys(updates).length) console.log(`ℹ️  ${RELEASE}-secrets already holds the signing set 1.8.0 needs.`);
  }
  for (const note of notes) console.log(`   - ${note}`);
  const changedEnv = secretFromUpdates(updates);
  if (apply) {
    patchSecret(changedEnv);
    console.log(`✅ Wrote ${Object.keys(changedEnv).join(', ')} into ${RELEASE}-secrets. Nothing restarted.`);
  } else if (!existsSync(valuesPath) && Object.keys(changedEnv).length) {
    for (const [k, v] of Object.entries(changedEnv)) console.log(`${k}=${v}`);
    console.error('Printed only. Put these in the release Secret where it lives, or re-run with --apply.');
  }
  console.log('');
  console.log(`Next: helm upgrade to 1.8.0 with the same values (${GUIDE}).`);
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// --service-secrets: Realtime's and Storage's own signing secrets, replaced
// -------------------------------------------------------------------------------------------------
if (serviceSecrets) {
  const fresh = Object.fromEntries(SERVICE_SECRETS.map((s) => [s.valuesKey, newServiceSecret()]));
  if (existsSync(valuesPath)) {
    const text = readFileSync(valuesPath, 'utf8');
    if (!readSecrets(text)) {
      console.error(`❌ ${valuesPath} has no secrets: block; not rewritten.`);
      process.exit(1);
    }
    writeFileSync(valuesPath, writeSecrets(text, fresh), { mode: 0o600 });
    console.log(`✅ Rewrote ${SERVICE_SECRETS.map((s) => `secrets.${s.valuesKey}`).join(' and ')} in ${valuesPath}.`);
  }
  const restart = SERVICE_SECRETS.map((s) => `deploy/${s.reader}`);
  const env = secretFromUpdates(fresh);
  if (!apply) {
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
    console.error(`Printed only. Put these in ${RELEASE}-secrets, or re-run with --apply; then:  kubectl -n ${NAMESPACE} rollout restart ${restart.join(' ')}`);
    process.exit(0);
  }
  patchSecret(env);
  const restarted = spawnSync('kubectl', ['-n', NAMESPACE, 'rollout', 'restart', ...restart], { encoding: 'utf8' });
  console.log(`✅ Replaced ${Object.keys(env).join(' and ')} in ${RELEASE}-secrets.`);
  console.log(restarted.status === 0 ? `   Restarted ${restart.join(' ')}.` : `   Restart by hand: kubectl -n ${NAMESPACE} rollout restart ${restart.join(' ')}`);
  console.log('   A signed URL Storage issued before stops working.');
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// --check: the answer to "a date nobody wrote down", and to "is this site ready for 1.8.0"
//
// THIS IS THE HALF THAT MAKES ANY LIFETIME SAFE, and it is why shortening the keys is not simply
// trading one silent outage for a more frequent one. The old ten-year expiry did not remove that
// failure, it deferred it to 2036 and removed every opportunity to notice.
//
// Exits non-zero when anything is within EXPIRY_WARN_DAYS or already past, or the release Secret
// lacks what 1.8.0 needs, so it can be a CI step or a cron line rather than something somebody
// remembers to run. The tokens outside the stack it lists do not change the exit code: the stack
// holds none of them, and after the upgrade they are refused anyway.
// -------------------------------------------------------------------------------------------------

/**
 * Why the release Secret falls short of 1.8.0, one line each: what `--signing-keys` would change.
 * Empty when it needs nothing, or holds no API keys to judge.
 */
function signingSetProblems() {
  if (!envValue('SUPABASE_ANON_KEY')) return [];
  const problems = [];
  const holdsOct = (json, keysOf) => {
    try {
      return (keysOf(JSON.parse(json)) || []).some((k) => k?.kty === 'oct');
    } catch {
      return false;
    }
  };
  if (!envValue('SUPABASE_JWT_KEYS')) problems.push('SUPABASE_JWT_KEYS (secrets.jwtKeys, the ES256 key pair) is missing');
  else if (holdsOct(envValue('SUPABASE_JWT_KEYS'), (v) => v)) problems.push('SUPABASE_JWT_KEYS holds the HS256 key (`oct`, the shared secret)');
  if (!envValue('SUPABASE_JWT_JWKS')) problems.push('SUPABASE_JWT_JWKS (secrets.jwtJwks, its public half) is missing');
  else if (holdsOct(envValue('SUPABASE_JWT_JWKS'), (v) => v.keys)) problems.push('SUPABASE_JWT_JWKS holds the HS256 key (`oct`, the shared secret)');
  const hs256 = [...API_JWTS, ...KEYS].filter((k) => envValue(k.env) && algorithmOf(envValue(k.env)) === 'HS256');
  if (hs256.length) problems.push(`signed HS256, which no service accepts from 1.8.0: ${hs256.map((k) => k.env).join(', ')}`);
  for (const s of SERVICE_SECRETS) {
    if (!envValue(s.env)) problems.push(`${s.env} (secrets.${s.valuesKey}) is missing`);
  }
  return problems;
}

/**
 * The live tokens issued on Access Control or by scripts/mint-api-token.mjs (renewal
 * access_control in service_token_health, 0204) that were signed HS256: all of them while GoTrue
 * signs HS256, else those issued before the release began signing ES256. `note` qualifies the list.
 */
async function hs256TokensOutsideTheStack() {
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) return { error: 'SUPABASE_SERVICE_ROLE_KEY is not in the release Secret' };
  let rows;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/service_token_health?renewal=eq.access_control&select=identity_name,jti,issued_at,expires_at&order=issued_at`, {
      headers: { apikey: envValue('SUPABASE_PUBLISHABLE_KEY'), Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!res.ok) return { error: `${supabaseUrl} answered ${res.status} for service_token_health` };
    rows = await res.json();
  } catch (err) {
    return { error: `${supabaseUrl} could not be reached (${err.message})` };
  }
  const signing = await liveSigningKey({
    jwtKeys: envValue('SUPABASE_JWT_KEYS'), supabaseUrl, apikey: envValue('SUPABASE_PUBLISHABLE_KEY'),
  }).catch((err) => ({ key: null, why: err.message }));
  if (!signing.key) return { rows, note: `every one: tokens are signed HS256 here (${signing.why})` };
  const history = readEs256Since(RELEASE, NAMESPACE);
  if (history.error || !history.since) {
    return { rows, note: `those issued before ES256 signing went live; ${history.error || 'helm history does not show when'}, so all are listed` };
  }
  // Ten minutes for the rollout: the token mint restarts after the revision is recorded.
  const cutoff = new Date(history.since.getTime() + 10 * 60_000);
  return {
    rows: rows.filter((r) => new Date(r.issued_at) < cutoff),
    note: `issued before ES256 signing went live, ${history.exact ? '' : 'on or before '}${history.since.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  };
}

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

  const problems = signingSetProblems();
  console.log('');
  if (problems.length) {
    console.log('The signing set falls short of what 1.8.0 needs; its render refuses it:');
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`  Complete it with \`npm run keys:rotate -- --signing-keys\` (${GUIDE}).`);
  } else if (envValue('SUPABASE_ANON_KEY')) {
    console.log('The signing set is what 1.8.0 needs: the ES256 pair alone, and Realtime\'s and Storage\'s own secrets.');
  }

  const outside = await hs256TokensOutsideTheStack();
  console.log('');
  if (outside.error) {
    console.log(`Tokens outside the stack: not read (${outside.error}).`);
    console.log('  Access Control lists every machine identity\'s tokens.');
  } else if (!outside.rows.length) {
    console.log('Tokens outside the stack signed HS256: none.');
  } else {
    console.log(`Tokens outside the stack signed HS256 (${outside.note}). From 1.8.0 no service accepts them;`);
    console.log('mint each again (Access Control, Issue Token; scripts/mint-api-token.mjs for the Read-only API client):');
    for (const r of outside.rows) {
      console.log(`  ${String(r.identity_name).padEnd(28)} issued ${String(r.issued_at).slice(0, 10)}  expires ${String(r.expires_at).slice(0, 10)}  jti ${r.jti}`);
    }
  }

  if (worst < EXPIRY_WARN_DAYS || problems.length) {
    console.error('');
    if (worst < 0) console.error('❌ At least one service key has expired. The worker holding it is failing every write.');
    else if (worst < EXPIRY_WARN_DAYS) console.error(`⚠️  At least one service key expires within ${EXPIRY_WARN_DAYS} days.`);
    if (worst < EXPIRY_WARN_DAYS) console.error('   Run `npm run keys:rotate -- --apply`, which restarts the workloads it names.');
    if (problems.length) console.error('❌ The signing set is not ready for 1.8.0 (above).');
    process.exit(1);
  }
  console.log('');
  console.log('✅ Every service key set is valid well beyond the warning window.');
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// Mint
// -------------------------------------------------------------------------------------------------
const signing = await liveSigningKey({
  jwtKeys: envValue('SUPABASE_JWT_KEYS'), supabaseUrl, apikey: envValue('SUPABASE_PUBLISHABLE_KEY'),
});
if (!signing.key) {
  console.error(`❌ The keys are signed ES256, and ES256 is not live: ${signing.why}.`);
  console.error(`   A site still on HS256 completes its signing set first (${GUIDE}).`);
  process.exit(1);
}
const signedWith = `ES256 (kid ${signing.key.kid})`;

const minted = KEYS.map((key) => ({
  ...key,
  ...mintJwt({ role: 'authenticated', signingKey: signing.key, subject: key.principal, days }),
}));
const mintedApi = apiKeys
  ? API_JWTS.map((key) => ({ ...key, ...mintJwt({ role: key.role, signingKey: signing.key, days: INFRASTRUCTURE_KEY_DAYS }) }))
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
  ...(mintedApi.length ? API_JWT_RESTARTS.map((name) => `deploy/${name}`) : []),
])];
if (existsSync(valuesPath)) {
  // A file written before 0181 lacks releaseCheckKey: it is added beside playbackKey.
  const text = readFileSync(valuesPath, 'utf8');
  if (!readSecrets(text)) {
    console.error(`⚠️  ${valuesPath} has no secrets: block; not rewritten.`);
  } else {
    writeFileSync(valuesPath, writeSecrets(text, Object.fromEntries(all.map((k) => [k.valuesKey, k.token]))), { mode: 0o600 });
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
