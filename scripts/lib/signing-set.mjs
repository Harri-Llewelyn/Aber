// =================================================================================================
// The signing values a site needs, and completing a set made before 1.8.0.
//
// Every token the stack accepts is signed ES256 by the private key in the key set (secrets.jwtKeys,
// whose public half is secrets.jwtJwks), and the set holds EC keys alone: an `oct` key there would
// verify a token signed with its secret. Realtime and Storage each verify HS256 with a secret of
// their own. secrets.jwtSecret is read by GoTrue alone, which requires it and signs nothing with it.
// aber.validateSigningKeys in the chart refuses a set short of this.
//
// completeSigningSet() supplies what a set lacks and keeps every value that already meets it, so a
// second run changes nothing: setup.mjs (and so the server installer) applies it to a values file,
// `keys:rotate -- --signing-keys` to the release Secret.
// =================================================================================================
import { randomBytes } from 'node:crypto';
import { algorithmOf, generateSigningKeys, publicJwksFrom, resignJwt, signingKeyFrom } from './service-jwt.mjs';

/** The key set: values name and Secret key. */
export const KEY_SET = [
  { valuesKey: 'jwtKeys', env: 'SUPABASE_JWT_KEYS' },
  { valuesKey: 'jwtJwks', env: 'SUPABASE_JWT_JWKS' },
];

/** The JWTs the chart takes, each signed by the key set. */
export const SIGNED_JWTS = [
  { valuesKey: 'anonKey', env: 'SUPABASE_ANON_KEY' },
  { valuesKey: 'serviceRoleKey', env: 'SUPABASE_SERVICE_ROLE_KEY' },
  { valuesKey: 'ingestionKey', env: 'SUPABASE_INGESTION_KEY' },
  { valuesKey: 'playbackKey', env: 'SUPABASE_PLAYBACK_KEY' },
  { valuesKey: 'releaseCheckKey', env: 'SUPABASE_RELEASE_CHECK_KEY' },
];

/** Realtime's and Storage's own HS256 secrets, and the Deployment that reads each. */
export const SERVICE_SECRETS = [
  { valuesKey: 'realtimeJwtSecret', env: 'REALTIME_JWT_SECRET', reader: 'supabase-realtime' },
  { valuesKey: 'storageJwtSecret', env: 'STORAGE_JWT_SECRET', reader: 'supabase-storage' },
];

const ALL = [...KEY_SET, ...SIGNED_JWTS, ...SERVICE_SECRETS];

/** A per-service secret: hex, which YAML, an environment variable and psql take unescaped. */
export const newServiceSecret = () => randomBytes(32).toString('hex');

const parsed = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};
const isOct = (key) => key?.kty === 'oct';

/**
 * What `values` (values names to strings; empty is missing) lacks, as the updates that supply it:
 *   - the key pair, minted when secrets.jwtKeys is empty, and secrets.jwtJwks made from it when
 *     only that is empty; an `oct` key is taken out of both;
 *   - each JWT that is HS256, signed again ES256 by the pair with its claims unchanged;
 *   - each service secret that is empty, minted.
 * `notes` says each change in a line. Throws on a key set GoTrue would refuse.
 *
 * @returns {{updates: Record<string, string>, notes: string[], resigned: string[], kid: string}}
 */
export function completeSigningSet(values) {
  const updates = {};
  const notes = [];
  let jwtKeys = values.jwtKeys || '';
  let jwtJwks = values.jwtJwks || '';
  if (!jwtKeys) {
    const pair = generateSigningKeys();
    jwtKeys = pair.jwtKeys;
    jwtJwks = pair.jwtJwks;
    Object.assign(updates, { jwtKeys, jwtJwks });
    notes.push(`added secrets.jwtKeys and secrets.jwtJwks: a new ES256 key pair, kid ${pair.kid}`);
  } else {
    const keys = parsed(jwtKeys);
    if (!Array.isArray(keys)) throw new Error('secrets.jwtKeys is not a JSON array of keys');
    let dropped = false;
    if (keys.some(isOct)) {
      jwtKeys = JSON.stringify(keys.filter((k) => !isOct(k)));
      updates.jwtKeys = jwtKeys;
      dropped = true;
    }
    const jwks = parsed(jwtJwks);
    if (!jwtJwks) {
      jwtJwks = publicJwksFrom(jwtKeys);
      updates.jwtJwks = jwtJwks;
      notes.push('added secrets.jwtJwks: the public half of secrets.jwtKeys');
    } else if (Array.isArray(jwks?.keys) && jwks.keys.some(isOct)) {
      jwtJwks = JSON.stringify({ ...jwks, keys: jwks.keys.filter((k) => !isOct(k)) });
      updates.jwtJwks = jwtJwks;
      dropped = true;
    }
    if (dropped) notes.push('took the HS256 key (`oct`, the shared secret) out of secrets.jwtKeys and secrets.jwtJwks');
  }
  const signingKey = signingKeyFrom(jwtKeys);

  const resigned = [];
  for (const { valuesKey } of SIGNED_JWTS) {
    const token = values[valuesKey];
    if (token && algorithmOf(token) === 'HS256') {
      updates[valuesKey] = resignJwt(token, signingKey);
      resigned.push(valuesKey);
    }
  }
  if (resigned.length) {
    notes.push(`signed again ES256, claims unchanged: ${resigned.map((k) => `secrets.${k}`).join(', ')}`);
  }

  const minted = SERVICE_SECRETS.filter(({ valuesKey }) => !values[valuesKey]);
  for (const { valuesKey } of minted) updates[valuesKey] = newServiceSecret();
  if (minted.length) {
    notes.push(`added ${minted.map((s) => `secrets.${s.valuesKey}`).join(' and ')}: Realtime's and Storage's own signing secrets`);
  }
  return { updates, notes, resigned, kid: signingKey.kid };
}

/** The Secret's keys (environment names) as values names, for completeSigningSet(). */
export function valuesFromSecret(secret) {
  return Object.fromEntries(ALL.map(({ valuesKey, env }) => [valuesKey, secret[env] || '']));
}

/** completeSigningSet()'s updates as the Secret's keys. */
export function secretFromUpdates(updates) {
  return Object.fromEntries(ALL.filter(({ valuesKey }) => valuesKey in updates).map(({ valuesKey, env }) => [env, updates[valuesKey]]));
}

// -------------------------------------------------------------------------------------------------
// A values file, as setup.mjs writes one: a `secrets:` block of one-line `key: value` entries, each
// quoted or not. Read and rewritten line by line, so its comments and order are kept.
// -------------------------------------------------------------------------------------------------
const indentOf = (line) => line.length - line.trimStart().length;
const unquoted = (raw) => {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
};
/** Compact JSON holds double quotes and never a single one, so it is single-quoted; the rest double. */
const yamlValue = (value) => (value.includes('"') ? `'${value.replace(/'/g, "''")}'` : `"${value}"`);

/** The `secrets:` block's lines as [first, end) indices and its children's indent, or null. */
function secretsBlock(lines) {
  const start = lines.findIndex((l) => /^secrets:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  let indent = null;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) === 0) break;
    indent ??= indentOf(line);
  }
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  return { start, end, indent: indent ?? 2 };
}

const entryAt = (lines, block, key) => {
  for (let i = block.start + 1; i < block.end; i++) {
    const line = lines[i];
    if (indentOf(line) === block.indent && line.trimStart().startsWith(`${key}:`)) return i;
  }
  return -1;
};

/** The `secrets:` block's values by name, or null for a file with none. */
export function readSecrets(text) {
  const lines = text.split(/\r?\n/);
  const block = secretsBlock(lines);
  if (!block) return null;
  const out = {};
  for (let i = block.start + 1; i < block.end; i++) {
    const m = /^\s*([A-Za-z0-9_]+):(.*)$/.exec(lines[i]);
    if (m && indentOf(lines[i]) === block.indent) out[m[1]] = unquoted(m[2]);
  }
  return out;
}

/** Where a key a file lacks is added: after the first of these it holds, else at the block's end. */
const ANCHORS = {
  jwtKeys: ['jwtSecret'],
  jwtJwks: ['jwtKeys', 'jwtSecret'],
  releaseCheckKey: ['playbackKey', 'ingestionKey'],
  realtimeJwtSecret: ['realtimeMetricsJwtSecret', 'realtimeSecretKeyBase', 'jwtJwks'],
  storageJwtSecret: ['realtimeJwtSecret'],
};

/** `text` with each update written into its `secrets:` block: the line rewritten, or added. */
export function writeSecrets(text, updates) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const order = ALL.map((k) => k.valuesKey).filter((k) => k in updates);
  for (const key of Object.keys(updates)) if (!order.includes(key)) order.push(key);
  for (const key of order) {
    const block = secretsBlock(lines);
    if (!block) throw new Error('it has no secrets: block');
    const line = `${' '.repeat(block.indent)}${key}: ${yamlValue(updates[key])}`;
    const at = entryAt(lines, block, key);
    if (at >= 0) {
      lines[at] = line;
      continue;
    }
    const anchor = (ANCHORS[key] || []).map((k) => entryAt(lines, block, k)).find((i) => i >= 0);
    lines.splice(anchor >= 0 ? anchor + 1 : block.end, 0, line);
  }
  return lines.join(eol);
}

/**
 * `text` without the deprecated supabaseAuth.es256Signing, and the comment setup.mjs wrote above
 * it, where its map keeps another key. Where it is the map's only key, removing it would leave
 * `supabaseAuth:` null, which replaces the chart's map: there `false`, which the chart refuses,
 * becomes `true`, which it ignores. Null and no note when there is no such line.
 */
function withoutSwitch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^[ \t]+es256Signing:[ \t]*(true|false)[ \t]*(#.*)?$/.test(l));
  if (at < 0) return null;
  const indent = indentOf(lines[at]);
  let parent = at - 1;
  while (parent >= 0 && (!lines[parent].trim() || lines[parent].trimStart().startsWith('#') || indentOf(lines[parent]) >= indent)) parent--;
  if (parent < 0 || !/^supabaseAuth:\s*(#.*)?$/.test(lines[parent])) return null;
  let siblings = 0;
  for (let i = parent + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) < indent) break;
    if (i !== at && indentOf(line) === indent) siblings++;
  }
  if (!siblings) {
    if (!/:[ \t]*false/.test(lines[at])) return null;
    lines[at] = `${lines[at].slice(0, indent)}es256Signing: true`;
    return { text: lines.join(eol), note: 'supabaseAuth.es256Signing: false is now true, which the chart accepts and ignores' };
  }
  const comment = at > 0 && indentOf(lines[at - 1]) === indent && /^\s*#.*ES256/.test(lines[at - 1]);
  lines.splice(comment ? at - 1 : at, comment ? 2 : 1);
  return { text: lines.join(eol), note: 'removed supabaseAuth.es256Signing, which is deprecated: every token is ES256' };
}

/**
 * A values file completed as completeSigningSet() completes its secrets, and without the deprecated
 * supabaseAuth.es256Signing (withoutSwitch). `changed` is false, and `text` the file as it was,
 * when there is nothing to do.
 *
 * @returns {{text: string, changed: boolean, notes: string[], resigned: string[], kid: string}}
 */
export function completeValuesText(text) {
  const values = readSecrets(text);
  if (!values) throw new Error('it has no secrets: block');
  const { updates, notes, resigned, kid } = completeSigningSet(values);
  let next = Object.keys(updates).length ? writeSecrets(text, updates) : text;
  const unswitched = withoutSwitch(next);
  if (unswitched) {
    next = unswitched.text;
    notes.push(unswitched.note);
  }
  return { text: next, changed: next !== text, notes, resigned, kid };
}
