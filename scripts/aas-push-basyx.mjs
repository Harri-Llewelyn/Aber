#!/usr/bin/env node
/**
 * Push an exported AAS Environment into a running Eclipse BaSyx server over its REST API.
 *
 * WHY THIS EXISTS AS WELL AS THE .aasx DOWNLOAD. The AASX this platform produces carries its
 * Environment as JSON at `aasx/aasenv-root.json`, which is valid AAS Part 5 -- but some BaSyx
 * builds' AASX upload path expects an XML environment part and will reject or half-load a JSON
 * one. That is a property of the consumer, not of the package, and it is not worth discovering on
 * the morning of a demo. This is the other route to the same destination: the same bytes the JSON
 * export returns, POSTed to the endpoints the AAS Part 2 API defines.
 *
 * It is also the better live demo. An upload dialog shows a file moving; this shows the shells and
 * submodels arriving as addressable resources in someone else's server, which is the actual claim
 * being made about interoperability.
 *
 * ---------------------------------------------------------------------------------------------
 * IDENTIFIERS ARE BASE64URL-ENCODED IN THE PATH, and this is the single most common way a hand-
 * rolled BaSyx client fails. AAS identifiers are IRIs -- `https://acs-cymru.local/ids/asset/...` --
 * and AAS Part 2 specifies that an identifier appearing in a URL path is base64url-encoded.
 * Sending the raw IRI produces a 404 whose message names a resource that plainly exists, or, worse,
 * a 400 from a proxy that split the path on the IRI's own slashes.
 *
 * SUBMODELS ARE POSTED BEFORE SHELLS. A shell carries `submodels` as a list of references; BaSyx
 * accepts a shell whose references dangle, so posting shell-first appears to work and leaves an
 * AAS whose submodels 404 when a viewer follows them. Posting submodels first means every
 * reference resolves the moment the shell lands.
 *
 * ---------------------------------------------------------------------------------------------
 * Usage:
 *   node scripts/aas-push-basyx.mjs --device=Simulated_CNC_01
 *   node scripts/aas-push-basyx.mjs --file=shell.json --basyx=http://localhost:8081
 *   node scripts/aas-push-basyx.mjs --device=... --dry-run
 *
 *   --basyx=URL     BaSyx AAS Environment base URL (default http://localhost:8081, or $BASYX_URL)
 *   --device=NAME   fetch the shell from this stack's aas-export function by device name
 *   --file=PATH     read an already-exported environment from disk instead
 *   --replace       PUT over an existing shell/submodel rather than skipping it
 *   --dry-run       show what would be pushed, send nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// --- arguments --------------------------------------------------------------------------------
const args = process.argv.slice(2);
let basyxUrl = process.env.BASYX_URL || 'http://localhost:8081';
let deviceName = null;
let filePath = null;
let replace = false;
let dryRun = false;

for (const arg of args) {
  if (arg.startsWith('--basyx=')) basyxUrl = arg.slice('--basyx='.length);
  else if (arg.startsWith('--device=')) deviceName = arg.slice('--device='.length);
  else if (arg.startsWith('--file=')) filePath = arg.slice('--file='.length);
  else if (arg === '--replace') replace = true;
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '-h' || arg === '--help') {
    console.log(
      'Usage: node scripts/aas-push-basyx.mjs (--device=NAME | --file=PATH) [--basyx=URL] [--replace] [--dry-run]'
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument '${arg}'.`);
    process.exit(2);
  }
}

if (!deviceName && !filePath) {
  console.error('One of --device=NAME or --file=PATH is required.');
  process.exit(2);
}
if (deviceName && filePath) {
  console.error('--device and --file are mutually exclusive: pick where the shell comes from.');
  process.exit(2);
}

basyxUrl = basyxUrl.replace(/\/+$/, '');

// --- .env -------------------------------------------------------------------------------------
function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

/**
 * AAS Part 2 path encoding: base64url, no padding.
 *
 * Node's 'base64url' encoding already strips padding, but it is asserted here rather than assumed
 * because a trailing '=' survives some proxies and is rejected by others -- a failure that appears
 * only for identifiers whose length happens to need padding, i.e. two thirds of them, at random.
 */
const encodeId = (id) => Buffer.from(id, 'utf8').toString('base64url').replace(/=+$/, '');

// --- fetching the environment -----------------------------------------------------------------
async function environmentFromFile(file) {
  const resolved = path.isAbsolute(file) ? file : path.join(rootDir, file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such file: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  // Accepts either the raw Environment or the aas-export response that wraps it, so a file saved
  // straight from the API response works without the caller having to unwrap it first.
  return parsed.aas ?? parsed;
}

async function environmentFromStack(name) {
  const supabaseUrl = (process.env.SUPABASE_URL || 'http://localhost:54321').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const email = process.env.AAS_TEST_EMAIL || 'admin@acs-cymru.local';
  const password = process.env.AAS_TEST_PASSWORD || 'acscymru123';

  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is not set; run `npm run setup` first.');

  // A USER token, not the service key. The export runs behind the same RLS an operator has, and
  // pushing a shell somebody could not have exported themselves would be a quiet privilege
  // escalation dressed up as a convenience.
  const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!authRes.ok) {
    throw new Error(`Sign-in failed (${authRes.status}). Set AAS_TEST_EMAIL / AAS_TEST_PASSWORD.`);
  }
  const { access_token: token } = await authRes.json();

  const devicesRes = await fetch(
    `${supabaseUrl}/rest/v1/devices?name=eq.${encodeURIComponent(name)}&select=id,name`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } }
  );
  const devices = await devicesRes.json();
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(`No device named '${name}'.`);
  }

  // `device_id` is read from the BODY, not the query string -- supabase-js's functions.invoke()
  // sends a body and does not expose the URL, so the function was written body-first. `format`
  // is accepted from either.
  const exportRes = await fetch(`${supabaseUrl}/functions/v1/aas-export`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_id: devices[0].id, format: 'json' }),
  });
  const body = await exportRes.json();
  if (!exportRes.ok) {
    throw new Error(`aas-export returned ${exportRes.status}: ${body.error ?? JSON.stringify(body)}`);
  }

  if (body.stats?.model_url_resolves_only_on_this_host) {
    // Not fatal here -- BaSyx may well be on this host during a rehearsal -- but silence would
    // mean discovering it when the viewer cannot load the geometry.
    console.warn(
      '\n  WARNING: this shell\'s 3D model URL resolves only on the exporting host.\n' +
      '  If BaSyx is in a container, `localhost` there is BaSyx, not this stack.\n' +
      '  Set AAS_MODEL_PUBLIC_BASE to a LAN address and re-export.\n'
    );
  }

  return body.aas;
}

// --- BaSyx ------------------------------------------------------------------------------------
async function basyx(method, pathname, body) {
  const url = `${basyxUrl}${pathname}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach BaSyx at ${basyxUrl} (${err.message}).\n` +
      '  Check the server is up and that --basyx points at the AAS ENVIRONMENT component, not the\n' +
      '  Web UI -- they are different ports and the UI does not serve /shells.'
    );
  }
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

/** POST, or PUT over an existing resource when --replace. Reports which it did. */
async function upsert(kind, collection, id, payload) {
  const encoded = encodeId(id);
  const single = `${collection}/${encoded}`;

  const existing = await basyx('GET', `/${single}`);
  if (existing.ok && !replace) {
    return { action: 'skipped', detail: 'already present (use --replace to overwrite)' };
  }

  if (existing.ok && replace) {
    const put = await basyx('PUT', `/${single}`, payload);
    if (!put.ok) throw new Error(`PUT /${single} -> ${put.status}: ${put.text}`);
    return { action: 'replaced' };
  }

  const post = await basyx('POST', `/${collection}`, payload);
  if (!post.ok) {
    // 409 here means it exists after all -- a race, or a GET that 404'd for another reason.
    if (post.status === 409) {
      return { action: 'skipped', detail: 'already present (409 on POST)' };
    }
    throw new Error(`POST /${collection} -> ${post.status}: ${post.text}`);
  }
  return { action: 'created' };
}

// --- main -------------------------------------------------------------------------------------
async function main() {
  const environment = filePath
    ? await environmentFromFile(filePath)
    : await environmentFromStack(deviceName);

  const shells = environment?.assetAdministrationShells ?? [];
  const submodels = environment?.submodels ?? [];

  if (shells.length === 0 && submodels.length === 0) {
    throw new Error('The environment contains no shells and no submodels; nothing to push.');
  }

  console.log(`BaSyx: ${basyxUrl}`);
  console.log(`Pushing ${submodels.length} submodel(s) and ${shells.length} shell(s)` +
              `${replace ? ' (replacing existing)' : ''}${dryRun ? ' [DRY RUN]' : ''}\n`);

  if (dryRun) {
    for (const submodel of submodels) {
      console.log(`  submodel  ${submodel.idShort ?? '(no idShort)'}\n            ${submodel.id}`);
      console.log(`            -> POST /submodels  (path id: ${encodeId(submodel.id)})`);
    }
    for (const shell of shells) {
      console.log(`  shell     ${shell.idShort ?? '(no idShort)'}\n            ${shell.id}`);
      console.log(`            -> POST /shells     (path id: ${encodeId(shell.id)})`);
    }
    return;
  }

  // SUBMODELS FIRST -- see the header. A shell whose references dangle is accepted, so the
  // wrong order produces a result that looks correct until a viewer follows a reference.
  let created = 0;
  let skipped = 0;

  for (const submodel of submodels) {
    const result = await upsert('submodel', 'submodels', submodel.id, submodel);
    console.log(`  submodel  ${(submodel.idShort ?? '').padEnd(28)} ${result.action}` +
                `${result.detail ? ` -- ${result.detail}` : ''}`);
    if (result.action === 'skipped') skipped++; else created++;
  }

  for (const shell of shells) {
    const result = await upsert('shell', 'shells', shell.id, shell);
    console.log(`  shell     ${(shell.idShort ?? '').padEnd(28)} ${result.action}` +
                `${result.detail ? ` -- ${result.detail}` : ''}`);
    if (result.action === 'skipped') skipped++; else created++;
  }

  console.log(`\n${created} written, ${skipped} skipped.`);

  for (const shell of shells) {
    console.log(`\nBrowse it:\n  ${basyxUrl}/shells/${encodeId(shell.id)}`);
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
