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
import { hostname } from 'node:os';
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
/**
 * DEVICES ARE PRE-REGISTERED, AND THAT IS A CHOICE WITH A COST.
 *
 * An unregistered device announcing itself is auto-quarantined and its DDATA dropped until an
 * operator approves it -- the zero-touch onboarding path, and one of the better things to
 * demonstrate. Pre-registering these skips it.
 *
 * They are pre-registered anyway because the two are demonstrated separately: a floor whose every
 * device sits in the quarantine queue shows an empty shopfloor map and no telemetry, which is the
 * opposite of the steady state everything else is meant to be seen against. Onboarding is shown by
 * introducing ONE unregistered device on purpose -- the flow's "ADD YOUR OWN DEVICE" path, or any
 * well-formed id that is not in this list.
 */
/**
 * EVERY NAME BEGINS `Sim_`, AND THAT IS THE POINT OF THE NAMING.
 *
 * A demonstrator floor sits in the same tables, the same shopfloor map and the same audit trail as
 * real plant. Anyone opening the dashboard should be able to tell in one glance which is which,
 * without knowing that `gwy12…` happens to be a simulator. The prefix is the cheapest possible way
 * to make that unambiguous, and it costs nothing: `name` is a display label, and `sparkplug_id` --
 * which the ACL, the topic and the historian all key on -- is generated from the pinned UUID and
 * does not move when a row is renamed. That is precisely the property the identity scheme exists
 * to provide, so exercising it here is using the design rather than working around it.
 */
/*
 * `envKey` IS DECLARED, NOT DERIVED FROM `name`, AND THAT DISTINCTION COST A DEBUGGING SESSION.
 *
 * It used to be computed as `MQTT_` + the name uppercased. Renaming `GW_CNC_Machining` to
 * `Sim_Gateway_Cell1_Machining` therefore silently renamed its credential variable to
 * `MQTT_SIM_GATEWAY_CELL1_MACHINING_*` -- while docker-compose.yml still passed
 * `MQTT_GW_CNC_MACHINING_*` and the flow's broker node still declared that name. Provisioning
 * reported success, .env was folded in correctly, and all four gateways then failed to
 * authenticate with no CONNACK code.
 *
 * A display label is the field most likely to change and the least suitable as an identifier.
 * Same lesson as `sparkplug_id` vs `name` one layer up: the stable key and the human-readable one
 * are different fields, and deriving either from the other couples a rename to a reconfiguration.
 * These keys are therefore FROZEN -- they no longer describe the gateway's current name and are
 * not meant to.
 */
const GATEWAYS = [
  {
    id: '12000000-0000-4000-8000-000000000001',
    envKey: 'MQTT_GW_CNC_MACHINING',
    name: 'Sim_Gateway_Cell1_Machining',
    cellName: 'Cell 1 — Precision Machining',
    description: 'Machine tools publishing MTConnect 2.x semantics',
    devices: [
      // TWO SCHEMAS, and 0022's header explains why this one device carries them: the class
      // schema is the MTConnect contract, and `Simulated_CNC_01_Schema` is the AAS handover
      // contract -- the only one carrying the ISO 22400 factors AND the nameplate identity
      // metrics, which is what gives the exported shell its KeyPerformanceIndicators aspect.
      {
        id: '22000000-0000-4000-8000-000000000001', name: 'Sim_CNC_Mill_01',
        schemas: ['Machining_Cell_Schema', 'Simulated_CNC_01_Schema'],
      },
      {
        id: '23000000-0000-4000-8000-000000000001', name: 'Sim_CNC_Mill_02',
        schemas: ['Machining_Cell_Schema'],
      },
      // Robotics rather than machining, which is worth a second look and is deliberate --
      // see 0022's header: the grouping is by articulated machinery, not by cell.
      {
        id: '27000000-0000-4000-8000-000000000001', name: 'Sim_Tool_Changer_01',
        schemas: ['Robotics_Cell_Schema'],
      },
    ],
  },
  {
    id: '13000000-0000-4000-8000-000000000001',
    envKey: 'MQTT_GW_ROBOTIC_ASSEMBLY',
    name: 'Sim_Gateway_Cell2_Robotics',
    cellName: 'Cell 2 — Robotic Assembly',
    description: 'Articulated robots publishing OPC 40010 Robotics and 40001-4 Energy semantics',
    devices: [
      {
        id: '24000000-0000-4000-8000-000000000001', name: 'Sim_Robot_Arm_01',
        schemas: ['Robotics_Cell_Schema'],
      },
    ],
  },
  {
    id: '14000000-0000-4000-8000-000000000001',
    // Was the AGV fleet gateway. RENAMED IN PLACE rather than replaced: the row keeps its
    // sparkplug_id, so the Mosquitto account, the ACL rule and every historical telemetry row
    // keyed on that id all remain valid. Creating a new gateway would have orphaned all three.
    envKey: 'MQTT_GW_AGV_FLEET',
    name: 'Sim_Gateway_Cell3_OEE',
    cellName: 'Cell 3 — Production KPIs',
    description: 'ISO 22400 KPI aggregation for the machining cell',
    devices: [
      {
        id: '25000000-0000-4000-8000-000000000001', name: 'Sim_Cell3_Aggregator',
        schemas: ['ISO22400_OEE_Schema'],
      },
    ],
  },
  {
    id: '15000000-0000-4000-8000-000000000001',
    envKey: 'MQTT_GW_FACILITY_BMS',
    name: 'Sim_Gateway_Site_BMS',
    // No cell: a building management system spans the site. `location_scope = 'site_wide'` is an
    // assertion an operator makes, and the CHECK constraint forbids pairing it with a cell_id.
    cellName: null,
    locationScope: 'site_wide',
    description: 'Facility BMS publishing ASHRAE 223P semantics',
    devices: [
      // Site-wide like its gateway, and stated EXPLICITLY rather than inherited: location_scope
      // does not inherit through the data path, so a device behind a site-wide gateway resolves to
      // Unassigned unless it makes the same assertion itself.
      {
        id: '26000000-0000-4000-8000-000000000001', name: 'Sim_BMS_Zone_HVAC',
        locationScope: 'site_wide',
        schemas: ['BMS_Facility_Schema'],
      },
    ],
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
  // Devices share the check because they share the derivation -- only the prefix differs, and a
  // device set numbered the obvious way collides exactly as the gateways first did.
  const all = [
    ...GATEWAYS.map((g) => ({ id: g.id, name: g.name, prefix: 'gwy' })),
    ...GATEWAYS.flatMap((g) => (g.devices || []).map((d) => ({ ...d, prefix: 'dev' }))),
  ];
  for (const spec of all) {
    const derived = `${spec.prefix}${spec.id.replace(/-/g, '').slice(0, 21)}`;
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
// DEFAULTS TO WRITING THE FILE. The passwords are not recoverable from the broker, so a run whose
// stdout scrolled away used to mean re-provisioning just to find out what it had set.
let envOut = '.env.gateways';
let rotate = false;

for (const arg of args) {
  if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--rotate') rotate = true;
  else if (arg === '--no-env-out') envOut = null;
  else if (arg.startsWith('--env-out=')) envOut = arg.slice('--env-out='.length);
  else if (arg === '-h' || arg === '--help') {
    console.log(
      'Usage: node scripts/provision-gateways.mjs [--target=compose|k8s] [--dry-run]\n' +
      '                                          [--rotate] [--env-out=FILE|--no-env-out]\n\n' +
      '  --rotate   reissue broker credentials for gateways that already exist.\n' +
      '             Without it an existing gateway keeps the password Node-RED is holding.\n' +
      '  --env-out  where to write the credentials (default .env.gateways, mode 0600).\n'
    );
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
/**
 * Bring a row's display name into line with this file, renaming rather than replacing.
 *
 * SAFE BY DESIGN, and worth saying why rather than leaving it to look risky. `sparkplug_id` is a
 * GENERATED column derived from the primary key; the broker account, the ACL rule, the topic and
 * every telemetry row are all keyed on it. `name` is a label and nothing resolves through it -- the
 * one exception, ingestion's legacy name-matching arm, is deprecation-warned and applies only to
 * devices that publish under a name instead of an id. So a rename moves what an operator reads and
 * nothing else, which is exactly the property the identity scheme was built for.
 *
 * The write is guarded on an actual difference so a re-run is silent -- an unconditional UPDATE
 * would append a digital_thread row on every provisioning run.
 */
async function renameIfNeeded(table, row, desiredName) {
  if (row.name === desiredName) return false;
  if (dryRun) {
    console.log(`    [dry-run] would rename ${table} '${row.name}' -> '${desiredName}'`);
    return false;
  }
  await rest(`/${table}?id=eq.${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: desiredName }),
  });
  console.log(`    renamed ${table}: '${row.name}' -> '${desiredName}' (sparkplug_id unchanged)`);
  row.name = desiredName;
  return true;
}

async function ensureGateway(spec) {
  const found = await rest(
    `/gateways?id=eq.${spec.id}&select=id,name,sparkplug_id,cell_id,location_scope,is_virtual,is_simulated,is_shadow`
  );
  if (found.length > 0) {
    const row = found[0];
    await renameIfNeeded('gateways', row, spec.name);

    // Reconciled on an existing row too, not only set at creation: the first four gateways were
    // provisioned with is_virtual false, and a flag that is only ever written on INSERT would
    // leave every stack provisioned before this change permanently mislabelled.
    if (row.is_virtual !== true && !dryRun) {
      await rest(`/gateways?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_virtual: true }),
      });
      console.log(`    marked ${row.name} virtual (⚡ badge)`);
      row.is_virtual = true;
    }

    // The cell is renamed through the gateway's own cell_id, so an existing deployment follows this
    // file without a second lookup by the OLD cell name -- which would fail once it had changed.
    if (spec.cellName && row.cell_id) {
      const cells = await rest(`/cells?id=eq.${row.cell_id}&select=id,name`);
      if (cells.length > 0) await renameIfNeeded('cells', cells[0], spec.cellName);
    }

    // ---------------------------------------------------------------------------------------
    // AN EXISTING GATEWAY WITH NO CELL STILL GETS ONE, and that arm is not hypothetical: it is
    // now the ORDINARY case for the first gateway. `0002_seed_data.sql` seeds
    // Sim_Gateway_Cell1_Machining so the machining CNC exists wherever the migrations run, and it
    // seeds no cells at all (Unassigned and Site-Wide are derived lanes, not rows). So this
    // function finds the gateway already present, took the early return above, and never called
    // ensureCell -- leaving Cell 1 uncreated, the gateway Unassigned, and, because the caller
    // reads `cellId` off THIS row, all three of its devices Unassigned too.
    //
    // It failed exactly that way once. The whole machining lane was missing from the shopfloor
    // map while every row was otherwise correct, which is the kind of failure that looks like a
    // rendering bug.
    //
    // Only when the row has NO cell. An operator who has deliberately moved a gateway to another
    // cell owns that decision; re-running provisioning must not drag it back.
    //
    // AND NOT WHEN THE ROW IS SYNTHETIC. `gateways_synthetic_has_no_cell` (0059) forbids pairing a
    // cell with is_simulated or is_shadow, so this arm would fail the PATCH rather than misplace
    // the row -- but it would fail on every provisioning run of a stack whose simulator has been
    // flagged, which is the ordinary state once §14 lands. A synthetic gateway resolves to the
    // Simulated or Shadow lane and has no cell to be missing.
    const synthetic = row.is_simulated || row.is_shadow;
    if (spec.cellName && !row.cell_id && !synthetic && row.location_scope !== 'site_wide' && !dryRun) {
      const cellId = await ensureCell(spec.cellName);
      if (cellId) {
        await rest(`/gateways?id=eq.${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ cell_id: cellId }),
        });
        console.log(`    placed ${row.name} in '${spec.cellName}'`);
        row.cell_id = cellId;
      }
    }

    // Likewise for a site-wide gateway that was seeded without the assertion. The CHECK constraint
    // forbids pairing `site_wide` with a cell_id, so this only applies to a row that has neither.
    if (spec.locationScope === 'site_wide' && row.location_scope !== 'site_wide'
        && !row.cell_id && !dryRun) {
      await rest(`/gateways?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ location_scope: 'site_wide' }),
      });
      console.log(`    marked ${row.name} site-wide`);
      row.location_scope = 'site_wide';
    }

    return { row, created: false };
  }

  if (dryRun) {
    console.log(`  [dry-run] would create gateway '${spec.name}' with pinned id ${spec.id}`);
    return { row: null, created: false };
  }

  const cellId = await ensureCell(spec.cellName);
  const payload = {
    id: spec.id,
    name: spec.name,
    // TRUE, AND IT IS A STATEMENT ABOUT THE ASSET RATHER THAN A DISPLAY FLAG. `is_virtual` means
    // "no physical edge appliance behind this row" -- a host-run connector, or in this case a
    // simulator. The dashboard renders it as the ⚡ badge, which is the one place an operator can
    // tell a simulated gateway from a real one at a glance without reading its name.
    //
    // It was `false`, which asserted the opposite: four simulated gateways claiming to be physical
    // hardware, sitting on the same shopfloor map as real plant with nothing distinguishing them.
    is_virtual: true,
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

// --- devices ----------------------------------------------------------------------------------
/**
 * Register a device bound to its gateway, and return the row with its generated sparkplug_id.
 *
 * BOUND AT CREATION, not left for the first DBIRTH to imply. `verify_gateway_binding()` rejects a
 * device's telemetry when it arrives via an edge node it is not bound to, so a device row with a
 * null `gateway_id` publishing through a real gateway is refused -- correctly, and confusingly, at
 * the point where telemetry silently stops rather than where the row was created.
 */
async function ensureDevice(spec, gatewayId, cellId) {
  const found = await rest(
    `/devices?id=eq.${spec.id}&select=id,name,sparkplug_id,gateway_id,cell_id,location_scope`
  );
  if (found.length > 0) {
    const row = found[0];
    await renameIfNeeded('devices', row, spec.name);

    // SAME RECONCILIATION AS THE GATEWAY, and here for the same reason: `Sim_CNC_Mill_01` is
    // seeded by 0002 with no cell, so on every stack this function finds it already present. A
    // location written only on INSERT would leave the one device the AAS suite exports sitting in
    // the Unassigned lane forever, no matter how many times provisioning was re-run.
    //
    // Guarded on the row having no location of its own, so an operator's deliberate placement
    // survives -- location is a fact about where the machine IS, and this script does not know
    // better than the person who moved it.
    if (!dryRun && !row.cell_id && row.location_scope !== 'site_wide') {
      const patch = spec.locationScope === 'site_wide'
        // The CHECK constraint forbids site_wide with a cell_id, so these two are exclusive.
        ? { location_scope: 'site_wide' }
        : cellId ? { cell_id: cellId } : null;

      if (patch) {
        await rest(`/devices?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        Object.assign(row, patch);
        console.log(
          `    placed ${row.name} ${patch.location_scope === 'site_wide' ? 'site-wide' : 'in its cell'}`
        );
      }
    }

    return { row, created: false };
  }

  if (dryRun) {
    console.log(`    [dry-run] would create device '${spec.name}' with pinned id ${spec.id}`);
    return { row: null, created: false };
  }

  const payload = {
    id: spec.id,
    name: spec.name,
    gateway_id: gatewayId,
    status: 'OFFLINE',
    // NOT quarantined: these are known assets being commissioned, and the quarantine queue is for
    // things that announced themselves unrecognised.
    is_quarantined: false,
    ...(spec.locationScope === 'site_wide'
      ? { location_scope: 'site_wide' }
      : cellId ? { cell_id: cellId } : {}),
  };

  const created = await rest('/devices', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  return { row: created[0], created: true };
}

// --- schema attachment ------------------------------------------------------------------------
/**
 * Attach a device's schemas through `device_submodels`.
 *
 * WHY THIS IS HERE AT ALL, when two migrations already do it. `0020` attaches the tri-standard
 * schema and `0022` attaches one per machine class, both guarded on the device existing -- and
 * db-init replays every migration on every boot, so a floor provisioned today has its schemas
 * tomorrow whatever this function does. That was fine while `0002_seed_data.sql` seeded the
 * devices, because the migrations then ran in an order where the guard was always satisfied.
 *
 * It is not fine now that provisioning is how the floor arrives. The gap between "provisioned" and
 * "next boot" is where a reader looks at what they just made, and a device with no schema is not
 * visibly incomplete -- it is a blank column, an AAS shell carrying its nameplate and nothing else,
 * and an unmodelled-metric check that silently never fires. Three quiet failures, all resolved by a
 * restart nobody knows to perform.
 *
 * BY NAME, NOT BY PINNED ID, which is the opposite of how everything else in this file is
 * addressed and is right here for a specific reason. The device and gateway ids must be pinned
 * because `sparkplug_id` is generated from them and IS the wire identity. A schema's id is
 * referenced by nothing outside the database, whereas `schema_name` is UNIQUE and is the key that
 * `Foo` -> `Foo_v2` versioning derives from -- so the name is the stable handle, and resolving it
 * here means an operator who has published a v2 gets told about it rather than silently re-bound
 * to v1 behind their back.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS SEED THE NAMEPLATE. 0020 seeds `Sim_CNC_Mill_01`'s IDTA
 * Digital Nameplate, and duplicating those nine values here would be a second copy to keep in
 * step for no gain: `nameplateProperty()` resolves published-value-first, and the simulator sends
 * a DBIRTH carrying the identity metrics within seconds of the flow starting. The seeded row only
 * matters where no broker is running, and there the next boot supplies it.
 */
async function ensureSubmodels(deviceRow, schemaNames) {
  if (!schemaNames || schemaNames.length === 0) return;

  const wanted = `(${schemaNames.map((n) => `"${n}"`).join(',')})`;
  const schemas = await rest(
    `/schemas?schema_name=in.${encodeURIComponent(wanted)}&select=id,schema_name,status`
  );

  const missing = schemaNames.filter((n) => !schemas.some((row) => row.schema_name === n));
  if (missing.length > 0) {
    // NOT FATAL, and not silent either. The schemas are seeded by migrations, so an absent one
    // means the chain has not finished or has been edited -- neither of which is a reason to
    // abandon a provisioning run that has already created rows and issued broker credentials.
    console.warn(
      `    schema(s) not registered, so ${deviceRow.name} is unattached to them: ${missing.join(', ')}`
    );
  }

  const existing = await rest(`/device_submodels?device_id=eq.${deviceRow.id}&select=schema_id`);
  const held = new Set(existing.map((row) => row.schema_id));

  for (const schema of schemas) {
    if (held.has(schema.id)) continue;
    // An ARCHIVED schema is still attachable and this says so rather than refusing: it is what a
    // device provisioned against v1 legitimately carries after someone publishes v2, and
    // `publish_schema_version()` is what re-points it.
    if (schema.status !== 'active') {
      console.log(`    note: ${schema.schema_name} is ${schema.status}, not active`);
    }
    // DRY RUN IS CHECKED HERE, NOT AT THE TOP, and the distinction is the whole point of the
    // function: the reads above are what make the plan accurate, and reporting "would attach"
    // for a schema the device already carries would be a plan that describes work nobody is
    // going to do. It is checked at all because ensureDevice returns a real row for an EXISTING
    // device even under --dry-run -- so without this line, a dry run would reach this POST and
    // write, which is the one thing --dry-run promises it cannot do.
    if (dryRun) {
      console.log(`    [dry-run] would attach ${schema.schema_name}`);
      continue;
    }
    await rest('/device_submodels', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceRow.id, schema_id: schema.id }),
    });
    console.log(`    attached ${schema.schema_name}`);
  }
}

// --- broker credential ------------------------------------------------------------------------
/**
 * Issue the Mosquitto account by DELEGATING to the existing script.
 *
 * The password is generated HERE and passed in, rather than letting that script generate one and
 * parsing it back out of its stdout. Same value, and this script needs it to write the .env block;
 * scraping it from human-readable output would break the first time that wording changed.
 */
/**
 * Whether the BROKER already holds an account for this gateway.
 *
 * THE ROW EXISTING AND THE ACCOUNT EXISTING ARE DIFFERENT FACTS, and this function exists because
 * they were being treated as one. `provisionCredential` used to issue a password only when it had
 * just created the gateway row -- which is right for the case it was written for (do not silently
 * rotate a working credential) and wrong for every case where the row arrives by another route.
 * `0002_seed_data.sql` now seeds the machining gateway, so on a clean stack this script finds that
 * row already present, skips its credential, and reports success. The broker has no account for it,
 * .env gets no password, and one of the four cells never connects -- while the other three do, so
 * the shopfloor map looks nearly right.
 *
 * Returns `null` when it cannot tell, which is treated as "exists" -- the safe direction, since
 * guessing wrong the other way rotates a credential nobody asked to rotate.
 */
function credentialExists(sparkplugId) {
  try {
    if (target === 'k8s') {
      const encoded = execFileSync('kubectl', [
        '-n', process.env.ACS_CYMRU_NAMESPACE || 'acs-cymru',
        'get', 'secret', process.env.MOSQUITTO_SECRET || 'mosquitto-passwords',
        '-o', 'jsonpath={.data.password_file}',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (!encoded) return null;
      return Buffer.from(encoded, 'base64').toString('utf8')
        .split('\n').some((line) => line.startsWith(`${sparkplugId}:`));
    }

    const file = execFileSync('docker', [
      'exec', process.env.MOSQUITTO_CONTAINER || 'acs-cymru_mosquitto',
      'cat', '/mosquitto/config/password_file',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return file.split('\n').some((line) => line.startsWith(`${sparkplugId}:`));
  } catch {
    // The broker may not be up yet, or kubectl may not be configured. Not knowing is not a reason
    // to reissue.
    return null;
  }
}

function provisionCredential(sparkplugId, gatewayIsNew) {
  // ---------------------------------------------------------------------------------------------
  // AN EXISTING GATEWAY KEEPS ITS PASSWORD UNLESS --rotate IS ASKED FOR.
  //
  // This defaulted the other way and it was wrong. Re-running the script -- to add a device, say --
  // silently reissued every gateway's credential, which invalidates the one Node-RED is holding.
  // Nothing fails at that moment: the rows are all correct, the script reports success, and the
  // breakage surfaces later as four brokers logging
  //
  //     Connection failed to broker: node-red-cnc@mqtt://mosquitto:1883
  //
  // with no CONNACK code and no mention of a password. The only way back is to re-provision and
  // update .env, by which point the cause is several steps behind you.
  //
  // Rotation is still available and is still what you want after a leak; it is just no longer what
  // you get by asking for something else.
  // ---------------------------------------------------------------------------------------------
  // ...BUT AN EXISTING GATEWAY WITH NO ACCOUNT STILL GETS ONE. Keeping a password the broker does
  // not have is not "keeping" anything; it is the same silent failure this guard was written to
  // prevent, reached from the other side. Only a credential that actually exists is protected.
  if (!gatewayIsNew && !rotate && credentialExists(sparkplugId) !== false) {
    console.log(
      `  credential kept (gateway already existed; pass --rotate to reissue it)`
    );
    return null;
  }

  if (!gatewayIsNew && !rotate) {
    console.log(`  the broker has no account for ${sparkplugId} -- issuing one`);
  }

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

/**
 * Record, in the platform's own audit trail, that this script issued a broker credential.
 *
 * WHY IT IS A SEPARATE RPC FROM THE ONE THE DASHBOARD CALLS. `record_gateway_credential_issued()`
 * (0041) gates on `has_role()`, which resolves through `auth.uid()` -- NULL for the service-role
 * key this script authenticates with. So every credential provisioning issued was recorded
 * nowhere, and the Access Control page reported `No platform record` for three of the five
 * gateways on a demonstrator that was publishing from all of them.
 *
 * THAT IS NOT COSMETIC. These credentials cannot be revoked by the platform in any general sense --
 * see 0043's header -- so the inventory IS the compensating control, and README.md's Accepted risks
 * section says as much by name. An inventory that under-reports is the mitigation not working.
 *
 * `rotated` MATTERS AND IS NOT DECORATION: mosquitto holds one password per username, so reissuing
 * REPLACES rather than adds. A reader counting two CREDENTIAL_ISSUED rows for one gateway as two
 * live credentials would be wrong in the opposite direction from the bug being fixed.
 *
 * The host and OS user are CLAIMED. 0062 stores them under a `claimed` key because the database
 * can verify neither, and this script is not in a position to prove anything about itself either.
 */
async function recordCredentialIssued(gatewayId, { rotated }) {
  await rest('/rpc/record_gateway_credential_issued_by_service', {
    method: 'POST',
    body: JSON.stringify({
      p_gateway_id: gatewayId,
      p_context: {
        rotated,
        os_user: process.env.USER || process.env.USERNAME || null,
        host: hostname(),
        script: 'scripts/provision-gateways.mjs',
      },
    }),
  });
}

// --- main -------------------------------------------------------------------------------------
async function main() {
  assertDistinctIds();
  console.log(`Provisioning ${GATEWAYS.length} gateway(s) against ${SUPABASE_URL} (target=${target})`);
  if (dryRun) console.log('DRY RUN -- nothing will be created or changed.\n');

  const results = [];
  const devices = [];
  // Credentials that reached the broker and not the audit trail. Reported at the end rather than
  // thrown at the moment, so one failure does not abandon a run that is issuing several.
  const unrecorded = [];
  for (const spec of GATEWAYS) {
    console.log(`\n${spec.name} -- ${spec.description}`);
    const { row, created } = await ensureGateway(spec);

    if (!row) {
      // Dry run: still walk the devices so the plan is complete rather than gateway-only.
      for (const device of spec.devices || []) await ensureDevice(device, null, null);
      continue;
    }

    console.log(`  ${created ? 'created' : 'exists'}: ${row.name} -> ${row.sparkplug_id}`);

    // The cell is resolved from the GATEWAY ROW rather than re-created, so a device joins the cell
    // its gateway actually landed in -- including when the gateway already existed and the cell
    // name in this file has since been edited.
    const cellId = row.cell_id ?? null;

    for (const device of spec.devices || []) {
      const { row: deviceRow, created: deviceCreated } =
        await ensureDevice(device, row.id, cellId);
      if (!deviceRow) continue;
      console.log(
        `    ${deviceCreated ? 'created' : 'exists'}: ${deviceRow.name} -> ${deviceRow.sparkplug_id}`
      );
      // On an EXISTING device too, not only a newly created one -- the same reasoning as the
      // is_virtual and cell reconciliation above. A stack provisioned before this function existed
      // has its schemas from the migrations; one whose operator detached a schema gets it back,
      // which is the behaviour `--rotate`-free re-running is for.
      await ensureSubmodels(deviceRow, device.schemas);
      devices.push({ name: deviceRow.name, sparkplugId: deviceRow.sparkplug_id });
    }

    const password = provisionCredential(row.sparkplug_id, created);
    // Only gateways whose credential was actually issued go into the .env block. Emitting a line
    // with a null password would overwrite a working entry with an empty one.
    if (password) {
      results.push({
        name: spec.name, envKey: spec.envKey, sparkplugId: row.sparkplug_id, password,
      });

      // AFTER THE BROKER, NOT BEFORE, and the ordering is a choice between two wrong-in-different
      // -directions failures. Recording first and then failing to provision would write a record of
      // a credential that never existed, into a table whose rows cannot be deleted. Provisioning
      // first and then failing to record leaves a live credential unrecorded -- which is the defect
      // being fixed, so it is not shrugged off: it is collected and the run exits non-zero below,
      // with the password still written out, because an operator who has the password and an error
      // can act, and one who has neither cannot.
      try {
        await recordCredentialIssued(row.id, { rotated: !created });
      } catch (err) {
        unrecorded.push({ name: spec.name, sparkplugId: row.sparkplug_id, reason: err.message });
      }
    }
  }

  if (dryRun) return;

  if (results.length === 0) {
    console.log(
      '\nNo credentials were issued -- every gateway already existed and kept the password it has.\n' +
      'Pass --rotate to reissue them (and then update .env, or Node-RED keeps using the old one).'
    );
    return;
  }

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
    ...results.flatMap((r) => [
      `# ${r.name}`,
      `${r.envKey}_USER=${r.sparkplugId}`,
      `${r.envKey}_PASSWORD=${r.password}`,
    ]),
  ].join('\n');

  console.log(`\n${block}\n`);

  if (envOut) {
    const outPath = path.isAbsolute(envOut) ? envOut : path.join(rootDir, envOut);
    fs.writeFileSync(outPath, `${block}\n`, { mode: 0o600 });
    console.log(`Written to ${outPath} (mode 0600).`);
  }

  if (devices.length > 0) {
    // The simulator's subflow instances are configured against these ids, so they are printed
    // rather than left to be looked up one device page at a time.
    console.log('Devices (Sparkplug ids the simulator publishes under):\n');
    for (const d of devices) {
      console.log(`  ${d.name.padEnd(16)} ${d.sparkplugId}`);
    }
    console.log();
  }

  console.log(
    'These passwords are NOT RECOVERABLE -- mosquitto_passwd stores only a hash. Record them now.\n' +
    'Re-running this script rotates them; it does not read them back.'
  );

  // ---------------------------------------------------------------------------------------------
  // A CREDENTIAL THAT REACHED THE BROKER AND NOT THE AUDIT TRAIL FAILS THE RUN, after the passwords
  // have been printed and written.
  //
  // The alternative -- a warning -- restores the defect this whole change closes, quietly: the
  // account works, the demonstrator comes up, and the only symptom is a page that says `No platform
  // record` for a gateway that holds one. Nobody reads a warning in a script that ended with a
  // success message and a block of credentials.
  // ---------------------------------------------------------------------------------------------
  if (unrecorded.length > 0) {
    console.error(
      `\n${unrecorded.length} credential(s) were issued at the broker and NOT recorded in the ` +
      'audit trail:\n' +
      unrecorded.map((u) => `  ${u.name} (${u.sparkplugId}): ${u.reason}`).join('\n') +
      '\n\nThe passwords above are live and usable. What is missing is the platform\'s record ' +
      'that they exist,\nwhich is what the Access Control page reports as the credential ' +
      'inventory -- and, because these\ncredentials cannot be revoked, that inventory is the ' +
      'compensating control rather than a nicety.\n\n' +
      'Check that migration 0062 has been applied (db-init replays it on every boot) and re-run.'
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
