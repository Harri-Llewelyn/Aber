#!/usr/bin/env node
/**
 * Register the demonstrator's cell gateways and issue each one a broker credential.
 *
 * WHY THIS EXISTS. A multi-cell shopfloor needs one gateway row per cell AND one Mosquitto account
 * per gateway, because `mosquitto.acl` confines every client to `spBv1.0/+/+/%u/#` -- the topic's
 * edge-node segment is pinned to the connecting username. There is deliberately no shared
 * wildcard principal any more, so "add a cell" is: create the row, read back the id the database
 * generated, provision an account under exactly that id, record the password. Four cells is that
 * sequence four times, and every step of it is somewhere a typo becomes a gateway that silently
 * never comes online.
 *
 * WHAT IT DOES NOT DO: mint ids, or reimplement the broker half. The `sparkplug_id` is a GENERATED
 * column ('gwy' plus 21 hex characters of the row's UUID) and is read back from the database
 * rather than computed here -- deriving it in a second place is how the two drift. The credential
 * is issued by `mosquitto-provision-gateway.mjs`, which already handles both deployment targets,
 * the non-disruptive SIGHUP reload, and replacing rather than appending an existing account.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE UUIDs ARE PINNED
 *
 * A pinned UUID makes the run DETERMINISTIC and REPEATABLE: re-running against a stack that
 * already has these gateways is a no-op on the rows and a password rotation on the accounts,
 * rather than four more gateways with new ids. It is also what lets the credential exist before
 * the row does -- the same property `0002_seed_data.sql` relies on for `Virtual_Gateway_NodeRED`
 * and `validate.py` for its own gateway.
 *
 * The ids below continue that block deliberately: 10000000-… is the seeded Node-RED simulator and
 * 11000000-… is the validator's, so these start at 12000000-… and cannot collide with either.
 *
 * THEY MUST DIFFER WITHIN THE FIRST 21 HEX CHARACTERS, WHICH IS NOT WHERE YOU WOULD LOOK.
 * `sparkplug_id` is `'gwy' || substr(encode(uuid_send(id), 'hex'), 1, 21)` -- so it is derived from
 * roughly the first ten and a half BYTES of the UUID and ignores the rest entirely. Four ids that
 * differ only in their last group, the obvious way to write a numbered set, all collapse onto ONE
 * sparkplug_id and the second insert fails on a unique constraint naming a column nobody typed.
 * The distinguishing digit therefore lives in the FIRST group. `assertDistinctIds()` below refuses
 * to run rather than let this be discovered halfway through a provisioning run.
 *
 * ---------------------------------------------------------------------------------------------
 * Usage:
 *   npm run provision:gateways                    # Compose
 *   npm run provision:gateways -- --target=k8s    # Kubernetes
 *   npm run provision:gateways -- --dry-run       # show what would happen, touch nothing
 *   npm run provision:gateways -- --env-out=.env.gateways
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read from .env if present).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * The demonstrator's cells and their gateways.
 *
 * `cellName` is created if absent, because a gateway with no cell resolves to Unassigned and the
 * shopfloor map is the first thing anyone looks at. `locationScope: 'site_wide'` is for the BMS,
 * which genuinely has no single cell -- writing it into a cell would be a lie the Overview map
 * then renders as fact. See docs: location_scope does not inherit.
 */
const GATEWAYS = [
  {
    id: '12000000-0000-4000-8000-000000000001',
    name: 'GW_CNC_Machining',
    cellName: 'CNC Machining Cell',
    description: 'Machine tools publishing MTConnect 2.x semantics',
  },
  {
    id: '13000000-0000-4000-8000-000000000001',
    name: 'GW_Robotic_Assembly',
    cellName: 'Robotic Assembly Cell',
    description: 'Articulated robots publishing OPC 40010 Robotics semantics',
  },
  {
    id: '14000000-0000-4000-8000-000000000001',
    name: 'GW_AGV_Fleet',
    cellName: 'AGV Marshalling Area',
    description: 'AGV fleet controller republishing flattened state fields',
  },
  {
    id: '15000000-0000-4000-8000-000000000001',
    name: 'GW_Facility_BMS',
    // No cell: a building management system spans the site. `location_scope = 'site_wide'` is an
    // assertion an operator makes, and the CHECK constraint forbids pairing it with a cell_id.
    cellName: null,
    locationScope: 'site_wide',
    description: 'Facility BMS publishing ASHRAE 223P semantics',
  },
];

/**
 * Refuse to run if two pinned UUIDs would derive the same `sparkplug_id`.
 *
 * Mirrors the generated column exactly: 'gwy' plus the first 21 characters of the UUID's hex, so
 * everything from roughly the eleventh byte onward is invisible to it. Checked BEFORE anything is
 * written, because the alternative is what this function was written in response to: a run that
 * creates the first gateway and its cell, then fails on the second with a unique-constraint error
 * naming `idx_gateways_sparkplug_id` -- a column the caller never set -- leaving the stack half
 * provisioned.
 *
 * This duplicates the column's derivation, which is normally the thing to avoid. It is worth it
 * here because the check is against a LOCAL list and must fail before any network call; the
 * authoritative id is still always read back from the database afterwards, never this value.
 */
function assertDistinctIds() {
  const seen = new Map();
  for (const spec of GATEWAYS) {
    const derived = `gwy${spec.id.replace(/-/g, '').slice(0, 21)}`;
    if (seen.has(derived)) {
      console.error(
        `Pinned UUIDs for '${seen.get(derived)}' and '${spec.name}' both derive sparkplug_id ` +
        `${derived}.\n\n` +
        'sparkplug_id is the first 21 HEX CHARACTERS of the UUID, so ids differing only in their ' +
        'last group are identical as far as the database is concerned. Vary the FIRST group ' +
        'instead (12000000-…, 13000000-…, 14000000-…).'
      );
      process.exit(2);
    }
    seen.set(derived, spec.name);
  }
}

// --- argument parsing -------------------------------------------------------------------------
const args = process.argv.slice(2);
let target = 'compose';
let dryRun = false;
let envOut = null;

for (const arg of args) {
  if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
  else if (arg === '--dry-run') dryRun = true;
  else if (arg.startsWith('--env-out=')) envOut = arg.slice('--env-out='.length);
  else if (arg === '-h' || arg === '--help') {
    console.log('Usage: node scripts/provision-gateways.mjs [--target=compose|k8s] [--dry-run] [--env-out=FILE]');
    process.exit(0);
  } else {
    console.error(`Unknown argument '${arg}'.`);
    process.exit(2);
  }
}

if (target !== 'compose' && target !== 'k8s') {
  console.error(`Unknown --target='${target}'. Expected 'compose' or 'k8s'.`);
  process.exit(2);
}

// --- environment ------------------------------------------------------------------------------
/**
 * Read .env without a dependency. Only KEY=VALUE lines, quotes stripped -- enough for the two
 * values needed here, and it does not overwrite anything already in the environment, so an
 * explicit `SUPABASE_URL=... npm run ...` still wins.
 */
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

const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://localhost:54321').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SERVICE_KEY) {
  console.error(
    'SUPABASE_SERVICE_ROLE_KEY is not set. Gateways are created through PostgREST, and RLS grants\n' +
    'gateway writes to Administrator and Shopfloor_Manager only -- there is no anonymous path.\n' +
    'Run `npm run setup` first, or export the key.'
  );
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  // Names this script in the audit trail rather than leaving it as the generic 'service'. The
  // trigger accepts only ingestion/service/migration from this header, never 'user'.
  'X-ACS-Cymru-Actor': 'service',
};

async function rest(pathname, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1${pathname}`;
  let response;
  try {
    response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  } catch (err) {
    throw new Error(
      `Cannot reach PostgREST at ${SUPABASE_URL} (${err.message}). Is the stack up? ` +
      '(docker compose up -d)'
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${pathname} -> ${response.status}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

// --- cells ------------------------------------------------------------------------------------
async function ensureCell(name) {
  if (!name) return null;
  const existing = await rest(`/cells?name=eq.${encodeURIComponent(name)}&select=id,name`);
  if (existing.length > 0) return existing[0].id;

  if (dryRun) {
    console.log(`  [dry-run] would create cell '${name}'`);
    return null;
  }
  const created = await rest('/cells', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name }),
  });
  console.log(`  created cell '${name}'`);
  return created[0].id;
}

// --- gateways ---------------------------------------------------------------------------------
/**
 * Create the gateway if absent, and return the row INCLUDING its generated sparkplug_id.
 *
 * The id is READ BACK, never constructed. It is a generated column, and the ACL plus
 * `verify_gateway_binding()` both compare the topic's edge-node segment against it exactly -- so a
 * locally-derived id that disagreed by one character would produce a gateway that authenticates
 * and whose every message is then rejected by the daemon.
 */
async function ensureGateway(spec) {
  const found = await rest(`/gateways?id=eq.${spec.id}&select=id,name,sparkplug_id,cell_id,location_scope`);
  if (found.length > 0) return { row: found[0], created: false };

  if (dryRun) {
    console.log(`  [dry-run] would create gateway '${spec.name}' with pinned id ${spec.id}`);
    return { row: null, created: false };
  }

  const cellId = await ensureCell(spec.cellName);
  const payload = {
    id: spec.id,
    name: spec.name,
    is_virtual: false,
    ...(spec.locationScope === 'site_wide'
      // The CHECK constraint forbids site_wide with a populated cell_id, so this must not send one.
      ? { location_scope: 'site_wide' }
      : { cell_id: cellId }),
  };

  const created = await rest('/gateways', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  return { row: created[0], created: true };
}

// --- broker credential ------------------------------------------------------------------------
/**
 * Issue the Mosquitto account by DELEGATING to the existing script.
 *
 * The password is generated HERE and passed in, rather than letting that script generate one and
 * parsing it back out of its stdout. Same value, and this script needs it to write the .env block;
 * scraping it from human-readable output would break the first time that wording changed.
 */
function provisionCredential(sparkplugId) {
  const password = randomBytes(24).toString('base64url');
  if (dryRun) {
    console.log(`  [dry-run] would provision broker credential for ${sparkplugId}`);
    return null;
  }
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'mosquitto-provision-gateway.mjs'),
      `--target=${target}`,
      sparkplugId,
      password,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );
  return password;
}

// --- main -------------------------------------------------------------------------------------
async function main() {
  assertDistinctIds();
  console.log(`Provisioning ${GATEWAYS.length} gateway(s) against ${SUPABASE_URL} (target=${target})`);
  if (dryRun) console.log('DRY RUN -- nothing will be created or changed.\n');

  const results = [];
  for (const spec of GATEWAYS) {
    console.log(`\n${spec.name} -- ${spec.description}`);
    const { row, created } = await ensureGateway(spec);
    if (!row) continue;

    console.log(`  ${created ? 'created' : 'exists'}: ${row.name} -> ${row.sparkplug_id}`);
    const password = provisionCredential(row.sparkplug_id);
    results.push({ name: spec.name, sparkplugId: row.sparkplug_id, password });
  }

  if (dryRun || results.length === 0) return;

  // ---------------------------------------------------------------------------------------------
  // The .env block. Printed to stdout AND optionally written, because the passwords are not
  // recoverable -- mosquitto_passwd stores a hash and nothing else does.
  // ---------------------------------------------------------------------------------------------
  const block = [
    '# ---------------------------------------------------------------------------',
    `# Demonstrator cell gateways -- generated by scripts/provision-gateways.mjs`,
    `# ${new Date().toISOString()}`,
    '#',
    '# Each account may publish ONLY beneath spBv1.0/+/+/<its own id>/# -- mosquitto.acl pins the',
    '# topic\'s edge-node segment to the connecting username. These are not interchangeable.',
    '# ---------------------------------------------------------------------------',
    ...results.flatMap((r) => {
      const key = r.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      return [
        `# ${r.name}`,
        `MQTT_${key}_USER=${r.sparkplugId}`,
        `MQTT_${key}_PASSWORD=${r.password}`,
      ];
    }),
  ].join('\n');

  console.log(`\n${block}\n`);

  if (envOut) {
    const outPath = path.isAbsolute(envOut) ? envOut : path.join(rootDir, envOut);
    fs.writeFileSync(outPath, `${block}\n`, { mode: 0o600 });
    console.log(`Written to ${outPath} (mode 0600).`);
  }

  console.log(
    'These passwords are NOT RECOVERABLE -- mosquitto_passwd stores only a hash. Record them now.\n' +
    'Re-running this script rotates them; it does not read them back.'
  );
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
