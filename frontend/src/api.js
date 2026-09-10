import { supabase, SUPABASE_URL, SUPABASE_GATEWAY_KEY } from './lib/supabaseClient';
import { withActivityTracking } from './lib/apiActivity';
import { isUuid } from './utils/isUuid';
import { deviceSparkplugId } from './utils/sparkplugId';
import { resolveDeviceLocation, SCOPE_SITE_WIDE } from './utils/cellResolution';
import { edgeFunctionErrorMessage } from './utils/edgeFunctionError';
import { DIGITAL_THREAD_ACTIONS, ENTITY_TABLE_BY_KIND } from './constants';
import { metricNameError } from './utils/metricGroup';
import { readSetting } from './config';
import {
  MODEL_3D_EXTENSIONS,
  isAcceptedModelFile,
  modelContentType,
  modelStoragePath
} from './utils/model3d';

// A device has TWO relationships to a cell and they answer different questions.
//
//   * `devices.gateway_id -> gateways.cell_id` is the DATA PATH. It is what the Sparkplug topic
//     carries and what the Gateways page lists by.
//   * `devices.cell_id` (archived migration 0036) is an explicit LOCATION override. NULL means inherit
//     from the gateway; it is not a stored "unassigned".
//
// The effective cell is resolved by public.device_locations and merged onto each row as
// `effective_cell_id` / `location_source` / `cell_mismatch`. `cell_id` on a mapped row stays the
// raw column, so a form that round-trips a device cannot turn an inherited cell into an explicit
// one just by saving. Read `effective_cell_id` to display, `cell_id` to edit.
//
// This is deliberately not an embed. `cells?select=*,gateways(devices(...))` returns devices by
// inheritance only, so a device explicitly placed in cell B whose gateway serves cell A comes
// back under A, and no combination of embeds can express "unless the child overrides".
//
// `asset_id` is always the device UUID -- including for quarantined devices, which used to
// carry the Sparkplug name here instead. That one exception was why the UI and the
// approve-quarantine edge function both had to sniff whether an id was a UUID or a name
// before they knew which column to address.
/**
 * The IDTA Digital Nameplate template the editor and the AAS exporter both work against.
 *
 * Mirrors NAMEPLATE_TEMPLATE_ID in supabase/functions/aas-export/index.ts. The version is part of
 * the identifier -- 2.0 lives under admin-shell.io/zvei, 3.0 under admin-shell.io/idta -- so these
 * two must move together or the shell would name a different template than the form filled in.
 */
const NAMEPLATE_TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate';

/**
 * Which nameplate fields a device can answer for itself, and the OPC UA concept that answers them.
 *
 * Mirrors the exporter's resolution order: a published value WINS over a stored one, so the form
 * shows these as read-only when the device publishes them. Keyed by `device_nameplate` column so
 * the form can look up a field without a second mapping.
 */
const NAMEPLATE_PUBLISHED_BY = new Map([
  ['uri_of_the_product', 'http://opcfoundation.org/UA/Machinery/ProductInstanceUri'],
  ['manufacturer_name', 'http://opcfoundation.org/UA/Machinery/Manufacturer'],
  ['manufacturer_product_designation', 'http://opcfoundation.org/UA/Machinery/Model'],
  ['serial_number', 'http://opcfoundation.org/UA/Machinery/SerialNumber'],
  ['year_of_construction', 'http://opcfoundation.org/UA/Machinery/YearOfConstruction'],
  ['software_version', 'http://opcfoundation.org/UA/Machinery/SoftwareRevision']
]);

const mapDeviceRow = (d, gateway, location) => {
  const loc = location || resolveDeviceLocation(d, gateway);
  return {
    ...d,
    asset_id: d.id,
    asset_name: d.name,
    sparkplug_id: d.sparkplug_id ?? deviceSparkplugId(d.id),
    active_gateway_id: d.gateway_id ?? gateway?.id ?? null,
    gateway_name: gateway?.name ?? null,
    effective_cell_id: loc.effective_cell_id,
    gateway_cell_id: loc.gateway_cell_id,
    location_scope: loc.location_scope,
    location_source: loc.location_source,
    cell_mismatch: loc.cell_mismatch
  };
};

const mapGatewayRow = (g, locations) => {
  const devices = (g.devices || []).map(d => mapDeviceRow(d, g, locations?.get(d.id)));
  return {
    ...g,
    gateway_id: g.id,
    gateway_name: g.name,
    devices,
    device_count: devices.length
  };
};

// PostgREST embeds. Kept as constants so the Cells and Gateways queries stay in step.
// cell_id and location_scope are selected so that local resolution still works when the
// device_locations read fails -- see loadDeviceLocations().
const DEVICE_EMBED =
  'id, name, description, sparkplug_id, reported_identity, identity_source, status, is_quarantined, ' +
  // `shadow_of` (0060) says this device exists to RECEIVE a replay rather than to report a machine.
  // Selected because the Capture page filters on it: a shadow device is not a capture subject, and
  // without the column the filter silently matches nothing.
  'is_archived, gateway_id, cell_id, location_scope, created_at, model_3d_path, shadow_of';
const GATEWAY_EMBED =
  `id, name, description, sparkplug_id, cell_id, location_scope, access_url, status, last_heartbeat, ` +
  `deployment, is_simulated, is_shadow, is_archived, archived_at, created_at, devices(${DEVICE_EMBED})`;

/**
 * Effective cell per device, keyed by device id, read from public.device_locations.
 *
 * Non-fatal by design, exactly like the device_schemas read below it: on failure the callers
 * fall back to resolveDeviceLocation(), which is the same expression evaluated locally, so the
 * page degrades to deriving what it could not fetch rather than rendering no devices at all.
 */
async function loadDeviceLocations() {
  const { data, error } = await supabase.from('device_locations').select('*');
  if (error) return null;
  return new Map((data || []).map(row => [row.device_id, row]));
}

// PostgREST rejects '' for a UUID/foreign-key column; the UI's "unassigned" option
// submits exactly that.
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

// The UI carries a device's gateway as `active_gateway_id`; the column is `gateway_id`.
const gatewayIdFrom = (body) => emptyToNull(body.active_gateway_id ?? body.gateway_id);

/**
 * The location columns a request is actually trying to set -- `{}` when it mentions neither, so
 * a partial update cannot blank a field it never sent.
 *
 * THE PAIR IS NEVER LEFT CONTRADICTORY. devices_site_wide_has_no_cell / gateways_site_wide_has_no_cell
 * (archived migration 0036) reject a site-wide asset that also names a cell, because "it is in no
 * particular cell" and "it is in Bay 4" cannot both be true. Clearing the cell here means
 * marking something Site-Wide is one action in the UI rather than a 400 the user has to decode
 * -- the same discipline api.js already applies to semantic_id / semantic_id_type.
 */
function locationFieldsFrom(body) {
  const fields = {};
  if ('cell_id' in body) fields.cell_id = emptyToNull(body.cell_id);
  if ('location_scope' in body) {
    fields.location_scope = body.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : 'cell';
    if (fields.location_scope === SCOPE_SITE_WIDE) fields.cell_id = null;
  }
  return fields;
}

export const TELEMETRY_PAGE_SIZE = 500;
// postgres_fdw pushes WHERE clauses to TimescaleDB but not LIMIT, so an unbounded
// query materialises the whole matching range in Supabase before trimming. Cap it.
const TELEMETRY_MAX_ROWS = 5000;

/**
 * Ceiling on a single CSV export, across all selected metrics.
 *
 * Higher than TELEMETRY_MAX_ROWS because an export is a deliberate act with a progress bar in
 * front of it, not a page render -- but still bounded, for the same postgres_fdw reason: a
 * 30-day range over several metrics has no natural limit and the FDW will happily materialise
 * all of it. On reaching this the export still downloads, carrying the most recent rows and
 * saying plainly that it was truncated. Silently returning a partial file from a button
 * labelled "Export" would be the worse failure.
 */
export const TELEMETRY_EXPORT_MAX_ROWS = 50000;

/**
 * The lower time bound applied when a caller supplies none.
 *
 * WHY A FLOOR RATHER THAN A LIMIT. `public.telemetry` is a postgres_fdw projection of the
 * standalone TimescaleDB hypertable, and postgres_fdw pushes the WHERE clause down but NOT the
 * LIMIT. `.range()` is therefore applied by Supabase AFTER the remote has returned its rows, so a
 * query with no time predicate makes TimescaleDB materialise an asset's entire history and ship
 * it across the wrapper to be thrown away. `ORDER BY time DESC` is what makes it unavoidable:
 * the sort cannot begin until every row has arrived.
 *
 * No caller in the UI currently omits a window -- `/telemetry/latest` defaults to 60 minutes,
 * the Overview map and the device drawer both pass one, and the export dialog always sets
 * absolute bounds. This exists so that the NEXT caller cannot reintroduce the unbounded scan by
 * omitting an argument, which is a mistake that costs nothing to make and produces a symptom
 * (the database is slow) three layers from its cause.
 *
 * 60 minutes matches what every live caller already asks for, so the floor changes no existing
 * behaviour. A caller wanting more says so explicitly.
 */
/**
 * Rollup resolutions a caller may ask for, and the relation each maps to.
 *
 * These are continuous aggregates in TimescaleDB (see timescaledb/aggregates.sql), exposed over
 * the FDW by archived migration 0010. They exist because `postgres_fdw` pushes WHERE down but not LIMIT:
 * a trend over a month cannot be made cheap by asking for fewer rows, only by there BEING fewer
 * rows. One hour of 1s samples is 3600 raw rows or 60 one-minute buckets.
 *
 * THE CSV EXPORT DELIBERATELY DOES NOT USE THESE. An export is a record of observations, and a
 * bucket average under a column header reading "value" would be a reading no instrument produced.
 */
export const TELEMETRY_RESOLUTIONS = {
  '1m': { relation: 'telemetry_1m', bucketMinutes: 1 },
  '5m': { relation: 'telemetry_5m', bucketMinutes: 5 },
  '1h': { relation: 'telemetry_1h', bucketMinutes: 60 }
};

export const TELEMETRY_DEFAULT_WINDOW_MINUTES = 60;

/**
 * Resolve the `time >= ...` bound for one telemetry query. Exported for the test that pins the
 * "never unbounded" property; call sites go through queryTelemetry.
 *
 * An explicit `from` is honoured verbatim, including one far in the past -- the floor exists to
 * catch an ABSENT bound, not to overrule a stated one. When only `to` is given the window is
 * measured back from `to` rather than from now, so a caller asking about last Tuesday gets last
 * Tuesday's hour instead of an empty result.
 */
export function telemetryLowerBound({ minutes, fromTime, toTime } = {}) {
  if (fromTime) return fromTime;

  const window = Number.isFinite(minutes) && minutes > 0 ? minutes : TELEMETRY_DEFAULT_WINDOW_MINUTES;
  const anchor = toTime ? Date.parse(toTime) : Date.now();
  // An unparseable `to` falls back to now rather than producing an Invalid Date, which would
  // serialise as null and drop the predicate entirely -- the exact failure this guards against.
  const end = Number.isFinite(anchor) ? anchor : Date.now();

  return new Date(end - window * 60000).toISOString();
}

/**
 * `telemetry.asset_id` and `asset_config.asset_id` are keyed by the device's immutable
 * `sparkplug_id`, while the UI works in device UUIDs. Translate before querying either.
 *
 * sparkplug_id is a generated column derived from the UUID primary key, so this is a pure
 * local derivation -- no round-trip. A value that is already a wire identifier (or anything
 * else non-UUID) passes through unchanged, so the query comes back empty rather than
 * silently widening to every device.
 */
function toTelemetryKey(assetId) {
  if (!assetId) return '';
  return isUuid(assetId) ? deviceSparkplugId(assetId) : assetId;
}

/**
 * Query the `telemetry` view -- a postgres_fdw projection of the standalone
 * TimescaleDB hypertable, exposed through PostgREST (see
 * 0001_baseline_schema.sql; rationale in archive/20260101000010_telemetry_foreign_table.sql).
 */
/**
 * @param minutes  Relative window, "the last N minutes". Kept as the primary form because every
 *                 existing caller uses it and it needs no clock arithmetic at the call site.
 * @param from,to  Absolute ISO bounds, for the export dialog's custom range. `minutes` and
 *                 `from`/`to` are not combined -- an explicit bound wins, because a caller that
 *                 supplies both has contradicted itself and the narrower reading of intent is
 *                 the one they typed.
 *
 * EVERY QUERY LEAVES HERE WITH A LOWER TIME BOUND, supplied by this function if the caller gave
 * none. See TELEMETRY_DEFAULT_WINDOW_MINUTES.
 */
async function queryTelemetry({ assetId, assetIds, metricName, minutes, from: fromTime, to: toTime, limit, offset, resolution } = {}) {
  const pageSize = Math.min(
    Number.isFinite(limit) && limit > 0 ? limit : TELEMETRY_PAGE_SIZE,
    TELEMETRY_MAX_ROWS
  );
  const from = Number.isFinite(offset) && offset > 0 ? offset : 0;

  // `resolution` selects a rollup instead of the raw hypertable. The time column is named
  // `bucket` there, and the value columns differ (avg/min/max/last rather than val_*), so the
  // caller gets a different row SHAPE -- documented as TelemetryBucket in docs/openapi.yaml.
  //
  // AN UNKNOWN RESOLUTION IS REFUSED, not quietly ignored. Falling back to raw would answer a
  // request for a year of hourly buckets by scanning a year of raw rows -- the exact failure this
  // exists to prevent, arrived at by a typo.
  const rollup = TELEMETRY_RESOLUTIONS[resolution];
  if (resolution && !rollup) {
    throw new Error(
      `unknown telemetry resolution '${resolution}'; expected one of ${Object.keys(TELEMETRY_RESOLUTIONS).join(', ')} (or omit it for raw)`
    );
  }
  const relation = rollup ? rollup.relation : 'telemetry';
  const timeColumn = rollup ? 'bucket' : 'time';

  const telemetryKey = toTelemetryKey(assetId);
  // Set by a tag filter, which resolves to a whole group of devices. The IN list grows with the
  // fleet, and postgres_fdw pushes the WHERE down but not the LIMIT (see
  // TELEMETRY_DEFAULT_WINDOW_MINUTES), so the Telemetry tab requires a time window whenever this
  // path is used -- the floor bounds the damage, it does not make an unwindowed fleet query wise.
  const telemetryKeys = (assetIds || []).map(toTelemetryKey).filter(Boolean);

  // An empty set means "a tag that matches no device", which must return nothing rather than
  // silently widening to the whole fleet. Checked before the query is built so no request is
  // issued at all.
  if (!telemetryKey && assetIds && telemetryKeys.length === 0) return [];

  let query = supabase.from(relation).select('*');
  if (telemetryKey) query = query.eq('asset_id', telemetryKey);
  else if (assetIds) query = query.in('asset_id', telemetryKeys);
  if (metricName) query = query.eq('metric_name', metricName);

  // Absolute bounds win over the relative window -- see the parameter note above. `to` is
  // applied on its own if that is all the caller gave; the lower bound is never left to them.
  // The floor applies to a rollup too: fewer rows per hour is not the same as few rows.
  if (toTime) query = query.lte(timeColumn, toTime);
  query = query.gte(timeColumn, telemetryLowerBound({ minutes, fromTime, toTime }));

  const { data, error } = await query
    .order(timeColumn, { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) throw error;
  return data || [];
}

/**
 * The newest sample per (asset, metric), read from `public.telemetry_latest`.
 *
 * THE COLLAPSE HAPPENS IN THE DATABASE NOW, and that is the entire point. This used to fetch a
 * window through `queryTelemetry` and keep the first row per key locally -- so the device drawer
 * pulled TWENTY-FOUR HOURS of rows for one machine to end up with about ten. `postgres_fdw`
 * pushes WHERE down but not LIMIT, so every one of those rows genuinely crossed the wrapper.
 *
 * `telemetry_latest` is a view on the TimescaleDB side, so its `DISTINCT ON` runs there against
 * the (asset_id, metric_name, time DESC) index -- verified as a SkipScan -- and only the answer
 * is transferred. The cost is bounded by how many series exist, not by how much history does.
 *
 * `minutes` IS STILL HONOURED, AS A STALENESS BOUND rather than as a scan window. Dropping it
 * would have quietly changed what the Overview map means: a machine that last reported in March
 * would reappear with a March reading presented as its current state. Same visible behaviour as
 * before, a fraction of the transfer.
 */
async function queryLatestTelemetry({ assetId, assetIds, metricName, minutes } = {}) {
  const telemetryKey = toTelemetryKey(assetId);
  const telemetryKeys = (assetIds || []).map(toTelemetryKey).filter(Boolean);

  // An empty set means "a tag that matches no device" -- return nothing rather than widening to
  // the whole fleet. Checked before the query is built, as in queryTelemetry.
  if (!telemetryKey && assetIds && telemetryKeys.length === 0) return [];

  let query = supabase.from('telemetry_latest').select('*');
  if (telemetryKey) query = query.eq('asset_id', telemetryKey);
  else if (assetIds) query = query.in('asset_id', telemetryKeys);
  if (metricName) query = query.eq('metric_name', metricName);

  const window = Number.isFinite(minutes) && minutes > 0 ? minutes : TELEMETRY_DEFAULT_WINDOW_MINUTES;
  query = query.gte('time', new Date(Date.now() - window * 60000).toISOString());

  const { data, error } = await query.limit(TELEMETRY_MAX_ROWS);
  if (error) throw error;
  return data || [];
}

const mapDigitalThreadRow = (t) => ({
  ...t,
  event_id: t.id || t.event_id,
  timestamp: t.recorded_at || t.timestamp,
  event_type: t.action || t.event_type,
  description: t.description || `Action ${t.action} on ${t.entity_type} [${t.entity_id}]`,
  metadata: t.metadata || { old_data: t.old_data, new_data: t.new_data, changed_by: t.changed_by }
});

/**
 * The 3D-model bucket. Public-read by design -- an exported AAS `File` element has to be
 * dereferenceable by a viewer holding no ACS-Cymru session, which a signed URL would not be.
 * Writes are gated by RLS to Administrator/Shopfloor_Manager (see the policies in
 * supabase/storage-policies.sql).
 *
 * RESOLVED, NOT A LITERAL. The bucket is created by scripts/storage-init.mjs from `STORAGE_BUCKET`
 * and its policies name it in supabase/storage-policies.sql, so every OTHER consumer already took
 * it from the environment. This one did not, which made the dashboard the single component a
 * rename would leave behind -- and it would present as a 404 on upload rather than as a
 * misconfiguration. The default is the same name those two default to.
 */
export const MODEL_3D_BUCKET = readSetting('VITE_MODEL_3D_BUCKET', 'asset-3d-models');

/**
 * The PRIVATE bucket holding Node-RED flow backups from physical gateway appliances.
 *
 * THE OPPOSITE OF THE BUCKET ABOVE IN EVERY RESPECT THAT MATTERS. There is no `getPublicUrl()` path
 * for it and there must never be one: a `flows.json` describes the plant's edge topology, its broker
 * addresses, its device ids and its processing logic. Reads go through a SIGNED URL minted for a
 * caller whose role the database has already checked.
 *
 * Objects live under `<sparkplug_id>/`, and that prefix is enforced by RLS rather than by this
 * client (supabase/storage-policies.sql). The paths below follow the rule; they do not implement it.
 */
export const GATEWAY_BACKUP_BUCKET = readSetting('VITE_GATEWAY_BACKUP_BUCKET', 'gateway-backups');

/**
 * Broker captures -- recorded Sparkplug traffic, for playback through `ingestion/capture.py`.
 *
 * PRIVATE, and the argument is stronger than for the bucket above rather than weaker. A flows.json
 * describes what the edge is CONFIGURED to do; a capture is a recording of what it actually said --
 * every device id that spoke in the window, every metric name, and the values.
 *
 * Objects live under `<sparkplug_id>/` of the gateway a capture plays back AS, which is never the
 * one it was recorded from: mosquitto.acl pins the topic's edge-node segment to the connecting
 * username, so playback always rewrites captured identities onto one gateway's own assets. That
 * prefix is enforced by RLS (supabase/storage-policies.sql); the paths here follow the rule and do
 * not implement it.
 */
export const CAPTURE_BUCKET = readSetting('VITE_CAPTURE_BUCKET', 'broker-captures');

/**
 * The capture-file version this stack reads.
 *
 * MIRRORS `CAPTURE_VERSION` in ingestion/capture.py, which is the authority. Duplicated rather than
 * derived because there is no import path from Python into the bundle -- and checked here so a
 * capture the tool would refuse is refused at upload instead of at playback, which is where the
 * mistake is furthest from its cause.
 */
export const CAPTURE_VERSION = 1;

/**
 * The filename a server offered in Content-Disposition, or null.
 *
 * READ FROM THE HEADER rather than composed here, because the server already decided it -- it knows
 * the gateway's name and sparkplug_id and has slugged them for a filesystem. Composing a second
 * version in the browser is how the download ends up named differently from the folder inside it.
 *
 * Deliberately narrow: only the plain `filename="..."` form, which is what this API emits. RFC 5987
 * `filename*=UTF-8''...` is not parsed, and a caller that gets null falls back to a name of its own.
 */
export function filenameFromDisposition(header) {
  const match = /filename="([^"]+)"/i.exec(header || '');
  return match ? match[1] : null;
}

/**
 * `<sparkplug_id>/capture.json` -- one path per subject, derived rather than composed.
 *
 * DETERMINISTIC SINCE 0055, AND IT USED TO CARRY A TIMESTAMP AND A SLUG. That was right while a
 * gateway could hold any number of captures; the schema now stores exactly ONE per subject, and
 * making the path a function of the subject alone is what makes an orphaned object impossible: a
 * re-record OVERWRITES this key rather than leaving the previous file behind for something to
 * sweep. It also means the path satisfies the bucket's prefix policy by construction instead of
 * because the caller assembled it correctly.
 *
 * THE SLUG WENT WITH THE TIMESTAMP, and the trap it existed for is now handled better. An operator
 * naming a capture "morning shift / line 2" would have put a `/` into the key, which storage reads
 * as a folder separator -- filing the object outside the prefix RLS checks, where the insert is
 * refused for a reason the filename does not suggest. That label is now `captures.note`, a column,
 * where a slash is simply a character.
 *
 * `sparkplugId` is the SUBJECT's -- a `gwy…` for a gateway capture and a `dev…` for a device one.
 * Captures are filed by what was recorded, not by the gateway a capture plays back as.
 */
export function capturePath(sparkplugId) {
  return `${sparkplugId}/capture.json`;
}

/**
 * The manifest for a capture uploaded through the browser.
 *
 * THE OTHER HALF OF A CONTRACT THE DAEMON WRITES. `capture_worker._manifest()` fills these same
 * fields for a recorded capture, and the two have to agree or the list shows one kind of capture
 * described and the other blank -- which reads as a broken column rather than an absent value.
 * Nothing derives one from the other, so they are kept in step by hand; the fields are named in
 * `captures.manifest`'s COMMENT, which is the authority.
 *
 * `birth_captured` IS THE ONE THAT MATTERS, and it is computed rather than trusted: an uploaded
 * file could claim anything, and the question -- does this capture contain an NBIRTH or DBIRTH --
 * is answerable from the messages themselves. False means the capture replays as
 * `unresolved_alias` against an alias-optimised gateway and drops every metric, from a file that
 * otherwise looks complete.
 *
 * Names are NOT capped here. `capped_capture_manifest()` in 0055 keeps 50 and records the true
 * count beside them, and doing it in one place is what stops the two writers disagreeing about
 * where the line is.
 */
export function captureManifest(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const names = [];
  const seen = new Set();
  const topics = new Set();
  // The identities in the file, so a playback can be set up without downloading it again. Every
  // captured device id has to be mapped onto a device of the target gateway, and the dialog builds
  // that from dropdowns.
  const edgeNodes = [];
  const devices = [];
  let birth = false;
  let usesAliases = false;

  for (const message of messages) {
    if (message?.topic) {
      topics.add(message.topic);
      // spBv1.0/<group>/<type>/<edge>[/<device>]
      const parts = String(message.topic).split('/');
      const type = parts[2];
      if (type === 'NBIRTH' || type === 'DBIRTH') birth = true;
      if (parts[3] && !edgeNodes.includes(parts[3])) edgeNodes.push(parts[3]);
      if (parts[4] && !devices.includes(parts[4])) devices.push(parts[4]);
    }
    for (const metric of message?.payload?.metrics || []) {
      // See capture_worker._manifest(): a metric with an alias and no name is the only kind that
      // a missing birth certificate actually costs anything.
      if (!metric?.name && metric?.alias !== undefined && metric?.alias !== null) usesAliases = true;
      if (metric?.name && !seen.has(metric.name)) {
        seen.add(metric.name);
        names.push(metric.name);
      }
    }
  }

  const durationMs = Number(parsed?.duration_ms) || 0;
  return {
    metric_names: names,
    topic_count: topics.size,
    observed_rate_hz: durationMs > 0
      ? Math.round((messages.length / (durationMs / 1000)) * 1000) / 1000
      : 0,
    birth_captured: birth,
    // Absent rather than false: nobody asked this file's gateway for a rebirth, so claiming either
    // way would be inventing a fact about a recording this stack did not make.
    rebirth_requested: null,
    edge_node_ids: edgeNodes,
    device_ids: devices,
    uses_aliases: usesAliases
  };
}

/** `<sparkplug_id>/<iso-timestamp>-flows.json`, sortable by name so the newest is last. */
export function gatewayBackupPath(sparkplugId, when = new Date()) {
  // Colons are legal in an S3 key but awkward in every shell and on Windows, where an operator may
  // well download one. `-` keeps the timestamp sortable and the filename portable.
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `${sparkplugId}/${stamp}-flows.json`;
}

/**
 * A signed storage URL that a NEW TAB can actually open.
 *
 * THE SIGNED URL ALONE IS NOT ENOUGH BEHIND THIS GATEWAY, and the failure names the wrong thing.
 * storage-js returns `/storage/v1/object/sign/<bucket>/<path>?token=…`, which is correct and which
 * the browser then requests with NO HEADERS -- and the API gateway in front of Supabase rejects any
 * request carrying no `apikey` before storage-api ever sees the token:
 *
 *     GET …/object/sign/broker-captures/gwy…/capture.json?token=…
 *     -> 401 {"message":"No API key found in request"}
 *
 * So every "Download" on this stack that opened a signed URL in a tab was broken -- captures and
 * gateway flow backups both -- and the message points at an API key when what is missing is a query
 * parameter. Measured, not inferred; appending the key returns 200 with the file.
 *
 * PUTTING THE ANON KEY IN A URL IS NOT A LEAK. It is in the bundle every visitor already downloads;
 * the gateway's filter is a ROUTING check rather than an authorisation one. What authorises this
 * request is the signed token, which is scoped to one object and expires in sixty seconds.
 */
function withApiKey(signedUrl) {
  if (!signedUrl) return signedUrl;
  return signedUrl + (signedUrl.includes('?') ? '&' : '?') + `apikey=${SUPABASE_GATEWAY_KEY}`;
}

/** The public URL for a stored model path. Composed, never stored -- see archived migration 0035. */
export function model3dPublicUrl(path) {
  if (!path) return null;
  return supabase.storage.from(MODEL_3D_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * The same object, asked for as a DOWNLOAD rather than a navigation.
 *
 * THE `download` HTML ATTRIBUTE CANNOT DO THIS, and that is the whole reason this function exists
 * rather than a one-word change on an anchor. The bucket is served from the storage origin and the
 * dashboard from its own, so `<a download>` is CROSS-ORIGIN -- browsers ignore the attribute
 * entirely in that case and navigate instead. What actually happened next depended on the file
 * type: a .glb the browser cannot render downloads anyway, and a .gltf (which is JSON) renders in
 * the tab. So the control would have worked for some models and silently not for others.
 *
 * `?download=` makes storage send `Content-Disposition: attachment`, which is a server-side
 * instruction and therefore origin-independent. Passing the filename also names the saved file
 * after the model instead of after its storage key.
 */
export function model3dDownloadUrl(path) {
  if (!path) return null;
  const name = path.split('/').pop() || 'model';
  return supabase.storage.from(MODEL_3D_BUCKET).getPublicUrl(path, { download: name }).data
    .publicUrl;
}

/**
 * The API surface itself. Exported below as `api`, wrapped so that every call through it is
 * counted by lib/apiActivity -- which is what lights the top bar's activity line. Declared
 * separately only because the wrapper has to be applied to the finished object; nothing should
 * import `apiMethods` directly, or its calls will not be counted.
 */
const apiMethods = {
  /**
   * Upload a 3D model for a device and record its path on the row.
   *
   * TWO WRITES, AND THE ORDER MATTERS. The object goes up first, then `model_3d_path` is set: a
   * row pointing at an object that does not exist would export a shell with a dead `File` URL,
   * whereas an object with no row pointing at it is merely unreferenced. If the second write
   * fails the upload is rolled back, so the failure does not silently leave the bucket holding
   * an orphan that nothing will ever clean up.
   *
   * `upsert: true` makes replacing a model overwrite rather than accumulate -- the path is derived
   * from the filename, so re-uploading the same file would otherwise be a no-op that left the old
   * bytes in place.
   */
  uploadDeviceModel: async (deviceId, file) => {
    if (!isAcceptedModelFile(file?.name)) {
      throw new Error(`Unsupported format. Accepted: ${MODEL_3D_EXTENSIONS.join(', ')}`);
    }

    const path = modelStoragePath(deviceId, file.name);
    const { error: uploadError } = await supabase.storage
      .from(MODEL_3D_BUCKET)
      .upload(path, file, { upsert: true, contentType: modelContentType(file.name) });

    if (uploadError) {
      // RLS rejections arrive as a generic row-level-security message, which tells an operator
      // nothing actionable. Name the actual cause.
      if (/row-level security|Unauthorized/i.test(uploadError.message || '')) {
        throw new Error('You do not have permission to upload a 3D model for this device.');
      }
      throw new Error(uploadError.message || 'Upload failed');
    }

    const { data, error } = await supabase
      .from('devices')
      .update({ model_3d_path: path })
      .eq('id', deviceId)
      .select();

    if (error) {
      await supabase.storage.from(MODEL_3D_BUCKET).remove([path]);
      throw new Error(error.message || 'Could not attach the model to the device');
    }

    return { path, device: data?.[0] ?? null };
  },

  /**
   * Detach a device's 3D model.
   *
   * The row is cleared BEFORE the object is deleted -- the reverse of upload, and for the same
   * reason read the other way round. Clearing first means the worst case is an orphaned object;
   * deleting first would leave the row briefly pointing at nothing, and an export in that window
   * would publish a broken link. A failure to delete the object is therefore not fatal: the
   * device is already detached, which is what the operator asked for.
   */
  removeDeviceModel: async (deviceId, path) => {
    const { error } = await supabase
      .from('devices')
      .update({ model_3d_path: null })
      .eq('id', deviceId);

    if (error) {
      if (/row-level security/i.test(error.message || '')) {
        throw new Error('You do not have permission to change this device.');
      }
      throw new Error(error.message || 'Could not detach the model');
    }

    if (path) await supabase.storage.from(MODEL_3D_BUCKET).remove([path]);
  },

  // ===============================================================================================
  // Physical gateway enrolment and flow backups
  // ===============================================================================================

  /**
   * Download the bootstrap bundle for a physical gateway.
   *
   * A RAW fetch(), NOT supabase.functions.invoke(), and this is not a preference. invoke() decodes
   * any response that is neither JSON nor octet-stream as TEXT, which silently corrupts a ZIP -- the
   * archive arrives the right approximate size and fails to open. Identical constraint to the AASX
   * path below; see the note there.
   *
   * Returns the blob plus the metadata that rides in headers, because a binary body has nowhere to
   * carry the token expiry the modal counts down.
   */
  downloadGatewayBundle: async (gatewayId, { ttlMinutes } = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gateway-bundle`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        // The CALLER's token: gateway-bundle mints the enrolment token as them, through a SECURITY
        // DEFINER RPC that checks has_role() itself. The anon key alone would be refused.
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ gateway_id: gatewayId, ...(ttlMinutes ? { ttl_minutes: ttlMinutes } : {}) })
    });

    if (!res.ok) {
      // The function reports failures as JSON even on this path, so the real reason survives -- a
      // 403 for an Operator, a 400 for a host-run gateway, a 503 for an unconfigured deployment.
      let message = `Bundle generation failed (${res.status})`;
      try { message = (await res.json())?.error || message; } catch { /* non-JSON body */ }
      throw new Error(message);
    }

    return {
      blob: await res.blob(),
      filename: filenameFromDisposition(res.headers.get('Content-Disposition')),
      expiresAt: res.headers.get('X-ACS-Token-Expires-At'),
      bundleVersion: res.headers.get('X-ACS-Bundle-Version'),
      sparkplugId: res.headers.get('X-ACS-Sparkplug-Id')
    };
  },

  /**
   * The machine identities that can reach this stack.
   *
   * THROUGH AN RPC, because neither table this needs is reachable from a browser and both are
   * unreachable on purpose: `auth.users` is GoTrue's and is not served by PostgREST at all, and
   * `public.user_roles` is in check-docs-drift's NOT_PUBLISHED list -- "read server-side by the two
   * userinfo functions, never by a client". `list_machine_principals()` (0080) returns four columns
   * and no secret, which is the narrow alternative to granting the browser the two tables that
   * decide who is who.
   *
   * IT REPLACED `list_service_principals()` (0042) UNDER A NEW NAME, and the rename is load-bearing
   * rather than cosmetic: its second column went from the ROLE a machine borrowed to the PERMISSIONS
   * it holds in its own right, and 0001 re-declares its own copy of every function on each boot with
   * CREATE OR REPLACE -- which cannot change a return type. Same name, different columns, and the
   * chain aborts at file one on the SECOND boot.
   *
   * ADMINISTRATOR ONLY at the database, so a Shopfloor_Manager reaching this gets a raise rather
   * than an empty list -- which the caller surfaces rather than rendering as "no service accounts".
   */
  listServicePrincipals: async () => {
    const { data, error } = await supabase.rpc('list_machine_principals');
    if (error) throw new Error(error.message || 'Could not list machine principals');
    return data || [];
  },

  /**
   * The cold telemetry catalogue — every chunk that has been claimed for archival (`0068`).
   *
   * READ FROM THE HISTORIAN, over the FDW, through a SECURITY DEFINER function. The manifest lives
   * beside the chunks it describes, so this is the only path a browser has to it.
   *
   * AN EMPTY LIST IS AMBIGUOUS HERE AND THE PAGE MUST NOT RESOLVE IT SILENTLY. `cold_storage_rows()`
   * gates on Administrator / Shopfloor_Manager / Auditor in its body rather than at the grant, so an
   * Operator gets zero rows rather than an error — exactly as every RLS-protected read on this
   * schema behaves. "Nothing archived" and "not yours to see" therefore look identical from here,
   * which is why the page says which it is from the session's role rather than guessing.
   */
  listColdStorage: async () => {
    const { data, error } = await supabase.rpc('cold_storage_rows');
    if (error) throw new Error(error.message || 'Could not read the cold storage catalogue');
    return data || [];
  },

  /**
   * Every TOKEN_MINTED row, grouped by the principal it was signed for.
   *
   * NOT "THE LATEST PER PRINCIPAL", which is what a naive inventory would fetch. A re-mint does not
   * invalidate the previous token -- PostgREST validates the signature and consults no table -- so
   * two mints a week apart are two live credentials. Reading only the newer one would report half
   * of what is outstanding. tokenStatus() counts the unexpired ones; this hands it all of them.
   *
   * BOUNDED, because `digital_thread` is append-only and cannot be pruned. Only TOKEN_MINTED rows
   * are selected, and only the columns the status derivation reads.
   */
  listServiceTokens: async () => {
    const { data, error } = await supabase
      .from('digital_thread')
      .select('entity_id,recorded_at,new_data')
      .eq('action', 'TOKEN_MINTED')
      .eq('entity_type', 'service_principals')
      .order('recorded_at', { ascending: false });

    if (error) throw new Error(error.message || 'Could not read token history');

    const byPrincipal = new Map();
    for (const row of data || []) {
      if (!byPrincipal.has(row.entity_id)) byPrincipal.set(row.entity_id, []);
      byPrincipal.get(row.entity_id).push({
        issued_at: row.new_data?.issued_at || row.recorded_at,
        expires_at: row.new_data?.expires_at || null,
        jti: row.new_data?.jti || null,
      });
    }
    return byPrincipal;
  },

  /**
   * The jtis `auth_pre_request()` is currently refusing (0074), as a Set.
   *
   * SEPARATE FROM listServiceTokens(), because the two answer different questions and have
   * different authority. That one reads `digital_thread`, needs the audit lane, and is the
   * permanent history -- every mint ever. This reads `revoked_service_tokens`, needs Administrator
   * or Auditor, and is OPERATIONAL: rows are pruned once the token they name has expired, because
   * the signature check refuses it from then on.
   *
   * SO AN EMPTY SET IS NOT "NOTHING WAS EVER REVOKED". It is "nothing is currently being refused",
   * which is also what a caller who cannot read the table gets -- RLS returns no rows rather than
   * an error. `tokenStatus()` defaults to an empty set for exactly that reason: a Shopfloor_Manager
   * sees the pre-0074 reading rather than a page that claims every token is live.
   *
   * FAILURE IS SWALLOWED TO AN EMPTY SET, matching listServiceTokens(). The section is
   * supplementary; a principal list that renders is worth more than one blanked by a refusal on
   * the newest of the three reads behind it.
   */
  listRevokedServiceTokens: async () => {
    const { data, error } = await supabase
      .from('revoked_service_tokens')
      .select('jti,revoked_at,revoked_by,expires_at');

    if (error) return new Set();
    return new Set((data || []).map(r => r.jti).filter(Boolean));
  },

  /**
   * The service principals `auth_pre_request()` is refusing by subject (0076), keyed by id.
   *
   * A MAP RATHER THAN A SET, unlike the token denylist, because the row carries facts the page
   * shows: when it was withdrawn and why. A token's denylist row has nothing a reader wants that
   * the mint row does not already carry.
   *
   * NOT SELF-PRUNING, so an empty map really does mean "none revoked" -- where the token equivalent
   * only means "none currently being refused". Same swallow-to-empty on a refusal, for the same
   * reason: an Auditor can read this and a Shopfloor_Manager cannot, and the identities are worth
   * more than a section blanked by the newest of four reads.
   */
  listRevokedServicePrincipals: async () => {
    const { data, error } = await supabase
      .from('revoked_service_principals')
      .select('principal_id,revoked_at,revoked_by,reason');

    if (error) return new Map();
    return new Map((data || []).map(r => [r.principal_id, r]));
  },

  /**
   * Withdraw a whole identity: every token naming it is refused, including ones issued later.
   *
   * IT CASCADES, and the caller must say so. The RPC also denylists each outstanding token
   * individually -- redundant for PostgREST, and what makes reinstatement safe, since lifting the
   * principal flag then does not hand those credentials back.
   */
  revokeServicePrincipal: async (principalId, reason) => {
    const { data, error } = await supabase.rpc('revoke_service_principal', {
      p_principal_id: principalId,
      p_reason: reason || null,
    });
    if (error) throw new Error(error.message);
    return data;
  },

  /**
   * Lift the flag. RESTORES THE IDENTITY, NOT ITS CREDENTIALS -- the tokens revoked alongside it
   * stay revoked, because revoke_service_token() has no inverse. A new token must be minted.
   */
  reinstateServicePrincipal: async (principalId) => {
    const { data, error } = await supabase.rpc('reinstate_service_principal', {
      p_principal_id: principalId,
    });
    if (error) throw new Error(error.message);
    return data;
  },

  /**
   * Create a machine identity that cannot sign in.
   *
   * THROUGH THE RPC, AS THE CALLER. `create_machine_principal()` (0080) is SECURITY DEFINER and
   * checks has_role() itself -- it writes to `auth.users`, which no browser-facing role can reach
   * and which nothing else in this application writes to except archived migration 0034.
   *
   * IT TAKES PERMISSIONS, NOT A ROLE, and replaced `create_service_principal()` (0044) under a new
   * name for the reason listServicePrincipals() records: the return type moved, and a return type
   * cannot move under the same name on a chain that replays. The identity it makes holds grants of
   * its own, so widening `Operator` no longer widens it.
   *
   * The database refuses anything outside `telemetry:read`, `quarantine:view` and
   * `digital_thread:read` -- an allow-list, so a permission added later is refused here until
   * somebody decides otherwise.
   */
  createServicePrincipal: async (permissions, note) => {
    const { data, error } = await supabase.rpc('create_machine_principal', {
      p_permissions: Array.isArray(permissions) ? permissions : [permissions],
      p_note: note || null,
    });
    if (error) throw new Error(error.message || 'Could not create the machine principal');
    return Array.isArray(data) ? data[0] : data;
  },

  /**
   * Every gateway with what the platform knows about its broker credential.
   *
   * TWO READS, NOT A JOIN, and the second is the interesting one. `gateway_status` carries
   * `enrolled_at` and `credential_revoked_at`, which is the whole story for a REMOTE gateway. A
   * virtual one has neither by construction -- enrolment refuses it -- so its only record is the
   * CREDENTIAL_ISSUED row 0041 writes, which lives in `digital_thread`.
   *
   * PostgREST cannot join those: `digital_thread.entity_id` carries no foreign key, deliberately,
   * so an audit row survives the purge of the thing it describes. So they are fetched separately
   * and reduced here.
   *
   * BOUNDED, because `digital_thread` is append-only and grows forever. Only CREDENTIAL_ISSUED rows
   * are selected and only the newest per gateway is kept -- re-minting appends rather than
   * replaces, and the page is asking "when was the credential this gateway is using issued", which
   * is the last one.
   */
  listGatewayCredentials: async () => {
    const [gatewaysRes, issuedRes] = await Promise.all([
      supabase
        .from('gateway_status')
        // `is_shadow` so the credential dialog can tell an operator where the password actually
        // goes: a playback gateway has no Node-RED broker node, so the .env pairing it would
        // otherwise print is advice that cannot be followed.
        .select('id,name,sparkplug_id,deployment,is_shadow,is_archived,status,enrolled_at,credential_revoked_at,live_status')
        .order('name'),
      supabase
        .from('digital_thread')
        .select('entity_id,recorded_at,changed_by')
        .eq('action', 'CREDENTIAL_ISSUED')
        .eq('entity_type', 'gateways')
        .order('recorded_at', { ascending: false })
    ]);

    if (gatewaysRes.error) throw new Error(gatewaysRes.error.message || 'Could not read gateways');

    // AN AUDIT READ THAT FAILS IS NOT FATAL. `digital_thread:read` is a separate permission, and a
    // caller without it should still see the gateway inventory -- with every host-run gateway
    // reading `No platform record`, which is exactly what that state means from where they stand.
    const issuedBy = new Map();
    if (!issuedRes.error) {
      for (const row of issuedRes.data || []) {
        if (!issuedBy.has(row.entity_id)) issuedBy.set(row.entity_id, row.recorded_at);
      }
    }

    return (gatewaysRes.data || []).map(g => ({ ...g, issued_at: issuedBy.get(g.id) || null }));
  },

  /**
   * Mint a HOST-RUN gateway's broker credential and get it back once.
   *
   * `supabase.functions.invoke()` WOULD work here -- the response is JSON, so the decoding trap
   * above does not apply -- and it is deliberately not used anyway, so both gateway-credential
   * paths read the same way and the difference between them is the endpoint rather than the
   * client. The error handling below is the part that matters, and it is identical.
   *
   * THE PASSWORD IS RETURNED ONCE AND IS NOT RECOVERABLE. mosquitto_passwd stores a hash and
   * nothing in this stack keeps a copy, so a caller that drops this value has to mint again --
   * which replaces the account and invalidates whatever is holding the previous one.
   */
  mintGatewayCredential: async (gatewayId) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gateway-credential`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        // The CALLER's token. authorize_virtual_gateway_credential() is SECURITY DEFINER and
        // checks has_role() itself, and the audit row is attributed to auth.uid() -- so the anon
        // key alone would be refused, and would have nobody to attribute the mint to if it were not.
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ gateway_id: gatewayId })
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      // `details` carries the RPC's own message -- "gateway X is a physical gateway; use an
      // enrolment bundle", "gateway X is archived" -- which is the sentence an operator can act on.
      // `error` alone would flatten all of them to "Cannot mint a credential".
      throw new Error(body?.details || body?.error || `Could not mint a credential (${res.status})`);
    }

    return body;
  },

  /**
   * Sign a long-lived token for a service principal and get it back ONCE.
   *
   * SAME SHAPE AS mintGatewayCredential ABOVE, and for the same reasons: a raw fetch rather than
   * `functions.invoke()` so both minting paths read alike, the CALLER's token rather than the anon
   * key, and `details` preferred over `error` because the database's own sentence is the one an
   * operator can act on ("... can sign in, so it is a person's account").
   *
   * WHAT COMES BACK IS UNRECOVERABLE. Nothing stores the token -- the signature is reproducible
   * only from JWT_SECRET, which lives in the edge runtime and nowhere a browser can reach -- so a
   * caller that drops this value must mint again. Unlike a broker credential, minting again does
   * NOT replace the previous one: both are valid until they expire or are revoked, which is why
   * the modal says so and why revoking is a separate act.
   *
   * @param {string} principalId the service principal to sign for
   * @param {number} [days] TTL, bounded by service_token_max_days() at both tiers
   */
  mintServiceToken: async (principalId, days) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/mint-service-token`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        // The CALLER's token, and here it is load-bearing twice over: the function resolves the
        // caller's role from it, and record_service_token_issued() re-checks that same id before
        // it will write an attributed row. The anon key would fail both.
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(days ? { principal_id: principalId, days } : { principal_id: principalId })
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      throw new Error(body?.details || body?.error || `Could not mint a token (${res.status})`);
    }

    return body;
  },

  /**
   * Withdraw a minted token, so PostgREST refuses it from the next request onward.
   *
   * NOT A COMPLETE REVOCATION, AND THE CALLER MUST SAY SO. `auth_pre_request()` is a PostgREST
   * hook (0074); storage, realtime, the edge runtime and Studio each verify the JWT signature for
   * themselves and consult no denylist, so a withdrawn token still satisfies those four until it
   * expires. The RPC records the same scope on its audit row.
   */
  revokeServiceToken: async (jti) => {
    const { data, error } = await supabase.rpc('revoke_service_token', { p_jti: jti });
    if (error) throw new Error(error.message);
    return data;
  },

  /**
   * Flow backups for one gateway, newest first.
   *
   * Storage `list()` is scoped to the gateway's own prefix, which is where RLS confines writes
   * anyway. A caller without read authority gets an EMPTY LIST rather than an error -- storage-api
   * applies the SELECT policy and simply returns nothing -- so the UI must decide what to show from
   * the caller's role, not from the length of this array.
   */
  listGatewayBackups: async (sparkplugId) => {
    const { data, error } = await supabase.storage
      .from(GATEWAY_BACKUP_BUCKET)
      .list(sparkplugId, { limit: 100, sortBy: { column: 'name', order: 'desc' } });

    if (error) throw new Error(error.message || 'Could not list backups');
    return (data || [])
      // `.emptyFolderPlaceholder` is a zero-byte object storage-api creates for an empty prefix.
      .filter(o => o.name && !o.name.startsWith('.'))
      .map(o => ({
        name: o.name,
        path: `${sparkplugId}/${o.name}`,
        size: o.metadata?.size ?? null,
        createdAt: o.created_at || o.updated_at || null
      }));
  },

  /**
   * Upload a `flows.json` backup.
   *
   * VALIDATED AS A NODE-RED FLOW BEFORE IT IS SENT, not merely by extension. The bucket accepts
   * `application/json` and a few fallbacks because browsers report a hand-picked .json
   * inconsistently, so the extension is close to no check at all -- and a backup that turns out not
   * to be a flow is discovered at RESTORE time, which is the worst moment for it.
   */
  uploadGatewayBackup: async (sparkplugId, file) => {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`"${file.name}" is not valid JSON. Export it from Node-RED with menu → Export → all flows.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('A Node-RED flow export is a JSON array of nodes. This file is not one.');
    }
    // THE CREDENTIAL FILE IS REFUSED OUTRIGHT. flows_cred.json is encrypted with a secret that lives
    // only in the appliance's .env, so a copy here would be either useless or dangerous -- and it is
    // an easy mistake to make, both files sitting side by side in /data.
    if (parsed.length && parsed.every(n => typeof n === 'object' && n && !n.type)) {
      throw new Error('That looks like flows_cred.json, not flows.json. Credential files are never backed up.');
    }

    const path = gatewayBackupPath(sparkplugId);
    const { error } = await supabase.storage
      .from(GATEWAY_BACKUP_BUCKET)
      // upsert FALSE: the path carries a timestamp, so every upload is a new version and an
      // accidental double-click cannot overwrite the previous one.
      .upload(path, file, { upsert: false, contentType: 'application/json' });

    if (error) {
      if (/row-level security|Unauthorized/i.test(error.message || '')) {
        throw new Error('You do not have permission to upload a backup for this gateway.');
      }
      throw new Error(error.message || 'Upload failed');
    }
    return { path };
  },

  /**
   * Propose a flow for a gateway: a branch and a pull request, never a deploy.
   *
   * THE DIFFERENCE FROM uploadGatewayBackup ABOVE IS THE WHOLE POINT. That one puts a copy in a
   * private bucket, where it is a backup and nothing else -- no diff, no history, no review. This
   * sends the same file to the gateway's own repository, where an open pull request IS "pending
   * approval" and a merge IS "approved". Both exist for now: roadmap 9 sequences the bucket's
   * removal, and until something PULLS these repositories a commit is not yet a backup an appliance
   * can be rebuilt from.
   *
   * THE SAME SHAPE CHECKS RUN HERE AND AGAIN IN THE FUNCTION. Not redundancy: this one keeps a
   * mistake from costing a round trip, and the function's is the boundary. `flows_cred.json` is the
   * one that matters -- a bucket object can be deleted, and a commit is forever.
   *
   * A raw fetch with the CALLER's token, the same shape as mintGatewayCredential: the function
   * resolves the caller's role and attributes the proposal to them by name, so the anon key alone
   * would be refused and would have nobody to name if it were not.
   */
  proposeGatewayFlow: async (gatewayId, file) => {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`"${file.name}" is not valid JSON. Export it from Node-RED with menu → Export → all flows.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('A Node-RED flow export is a JSON array of nodes. This file is not one.');
    }
    if (parsed.length && parsed.every(n => typeof n === 'object' && n && !n.type)) {
      throw new Error('That looks like flows_cred.json, not flows.json. Credential files are never committed.');
    }

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/propose-gateway-flow`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ gateway_id: gatewayId, flow: parsed })
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      // `details` carries the sentence somebody can act on -- "this deployment has no forge",
      // "repositories are created when an appliance enrols with a deploy key" -- where `error`
      // alone would flatten every one of them into "the forge refused".
      throw new Error(body?.details || body?.error || `Could not propose this flow (${res.status})`);
    }

    return body?.pull_request ?? null;
  },

  /**
   * A short-lived signed URL for one backup.
   *
   * SIGNED, because the bucket is private -- there is no public URL to compose. 60 seconds is long
   * enough for the browser to follow the link and short enough that a URL pasted into a ticket is
   * dead before anyone reads it.
   */
  gatewayBackupUrl: async (path) => {
    const { data, error } = await supabase.storage
      .from(GATEWAY_BACKUP_BUCKET)
      // Same two fixes as captureUrl: the gateway refuses a headerless request without an apikey,
      // and a flows.json renders in the tab rather than saving without `download`.
      .createSignedUrl(path, 60, { download: path.split('/').pop() || 'flows.json' });
    if (error) throw new Error(error.message || 'Could not create a download link');
    return withApiKey(data.signedUrl);
  },

  deleteGatewayBackup: async (path) => {
    const { error } = await supabase.storage.from(GATEWAY_BACKUP_BUCKET).remove([path]);
    if (error) {
      if (/row-level security|Unauthorized/i.test(error.message || '')) {
        throw new Error('You do not have permission to delete backups.');
      }
      throw new Error(error.message || 'Delete failed');
    }
  },

  /**
   * Every stored capture, with the subject it was recorded from.
   *
   * READ FROM THE TABLE, NOT FROM STORAGE, and that is the change 0055 makes. Listing the bucket
   * returned objects: a name, a size and a timestamp, and nothing about what is IN one. The table
   * carries the note, the message count and the manifest -- including `birth_captured`, which is
   * the field that decides whether a capture will replay at all on an alias-optimised gateway.
   *
   * It also fixes an ambiguity the old shape could not: storage-api returns an EMPTY ARRAY to an
   * unauthorised caller rather than an error, so an empty listing could not be told from a denial.
   * PostgREST applies RLS the same way, but the page no longer infers permission from length --
   * `canManage` comes from the session's role.
   */
  listCaptures: async () => {
    const { data, error } = await supabase
      .from('captures')
      .select('*, gateways(name, sparkplug_id, is_simulated), devices(name, sparkplug_id)')
      .order('recorded_at', { ascending: false });
    if (error) throw new Error(error.message || 'Could not list captures');
    return data || [];
  },

  /**
   * The capture that is queued or running, or null.
   *
   * AT MOST ONE EXISTS, enforced by a partial unique index rather than by this query's LIMIT: two
   * browser tabs cannot race a database constraint. `maybeSingle()` is what makes "none" an
   * ordinary answer instead of an error, which is the state this returns almost every time.
   */
  activeCaptureJob: async () => {
    const { data, error } = await supabase
      .from('capture_jobs')
      .select('*, gateways(name, sparkplug_id), devices(name, sparkplug_id)')
      .in('status', ['PENDING', 'RECORDING'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Could not read capture jobs');
    return data || null;
  },

  /** The last few finished jobs, so a failure is visible after its card has gone. */
  recentCaptureJobs: async (limit = 5) => {
    const { data, error } = await supabase
      .from('capture_jobs')
      .select('*, gateways(name, sparkplug_id), devices(name, sparkplug_id)')
      .in('status', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .order('finished_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message || 'Could not read capture jobs');
    return data || [];
  },

  /**
   * Queue a recording. Returns the job id.
   *
   * `replace` IS THE MODAL, EXPRESSED AS AN ARGUMENT. The gate refuses when a capture of the
   * subject already exists unless this is true, so the confirmation is a precondition in the
   * database rather than a convention of this client -- an API caller that never saw the dialog is
   * refused too. The refusal names the capture it is protecting, note included, which is why the
   * message is surfaced verbatim rather than replaced with something friendlier.
   */
  startCapture: async ({ subjectKind, subjectId, note, seconds, replace = false }) => {
    const { data, error } = await supabase.rpc('start_capture_job', {
      p_subject_kind: subjectKind,
      p_subject_id: subjectId,
      p_note: note || null,
      p_max_seconds: seconds,
      p_replace: replace
    });
    if (error) {
      if (/insufficient_privilege|only .* may/i.test(error.message || '')) {
        throw new Error('Recording the broker requires Administrator or Shopfloor Manager.');
      }
      throw new Error(error.message || 'Could not start the capture');
    }
    return data;
  },

  /**
   * Ask a running capture to finish now.
   *
   * A COLUMN, NOT A CALL, on the other side: the daemon observes `stop_requested` on its next
   * message, flushes and completes. Returns false when the job had already finished, which is not
   * an error -- a capture can complete between the click and this request, and showing a failure
   * for something that did exactly what was asked would be wrong.
   */
  stopCapture: async (jobId) => {
    const { data, error } = await supabase.rpc('request_capture_stop', { p_job_id: jobId });
    if (error) throw new Error(error.message || 'Could not stop the capture');
    return data === true;
  },

  /**
   * Upload a capture recorded elsewhere -- by `capture.py record`, or downloaded from another stack.
   *
   * VALIDATED AS A CAPTURE BEFORE IT IS SENT, not merely as JSON. The bucket accepts a handful of
   * JSON-ish MIME types because browsers report a hand-picked .json inconsistently, so the type is
   * close to no check at all -- and a file that turns out not to be a capture is discovered when
   * somebody tries to PLAY it, which is both the worst moment and the one furthest from the
   * mistake.
   *
   * TWO STEPS, IN THIS ORDER, AND THE ORDER MATTERS. The object goes up first and the row is
   * written second: a row pointing at bytes that are not there offers a capture the list can show
   * and nothing can download, which is worse than an object no row references -- the path is
   * deterministic, so the next upload for that subject overwrites the stray one.
   *
   * THE MANIFEST IS BUILT HERE because this file is already being parsed to validate it. Without
   * that, every uploaded capture would show blank beside every recorded one and the column would
   * read as broken rather than absent.
   */
  uploadCapture: async ({ subjectKind, subjectId, sparkplugId, file, note, replace = false }) => {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`"${file.name}" is not valid JSON. Record one with: python ingestion/capture.py record --out <file>`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('A capture is a JSON object. This file is not one.');
    }
    if (parsed.acs_capture_version === undefined) {
      // The likeliest wrong file in this dialog by a distance, since both are JSON and both are
      // things an engineer downloads from this same application.
      if (Array.isArray(parsed)) {
        throw new Error('That looks like a Node-RED flow export, not a capture.');
      }
      throw new Error('That file carries no acs_capture_version, so it is not a broker capture.');
    }
    if (parsed.acs_capture_version !== CAPTURE_VERSION) {
      throw new Error(
        `That capture is version ${parsed.acs_capture_version} and this stack reads version ${CAPTURE_VERSION}. ` +
        'capture.py refuses a version it does not know rather than guessing at the difference.'
      );
    }
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      throw new Error('That capture contains no messages, so there would be nothing to play back.');
    }

    const path = capturePath(sparkplugId);
    const { error } = await supabase.storage
      .from(CAPTURE_BUCKET)
      // upsert TRUE, where this used to be false. The path no longer carries a timestamp, so the
      // one capture a subject holds lives at one key and replacing it IS an overwrite. The
      // confirmation that authorises it happens before this call, not here.
      .upload(path, file, { upsert: true, contentType: 'application/json' });

    if (error) {
      if (/row-level security|Unauthorized/i.test(error.message || '')) {
        throw new Error('You do not have permission to upload a capture for this subject.');
      }
      if (/exceeded the maximum allowed size|Payload too large/i.test(error.message || '')) {
        throw new Error('That capture is over the bucket limit. Record a shorter window.');
      }
      throw new Error(error.message || 'Upload failed');
    }

    const manifest = captureManifest(parsed);
    const { data: captureId, error: rpcError } = await supabase.rpc('register_uploaded_capture', {
      p_subject_kind: subjectKind,
      p_subject_id: subjectId,
      p_storage_path: path,
      p_size_bytes: file.size,
      p_message_count: parsed.messages.length,
      p_manifest: manifest,
      p_note: note || null,
      p_replace: replace
    });
    if (rpcError) throw new Error(rpcError.message || 'The file uploaded but could not be recorded');

    // THE MANIFEST COMES BACK, so a caller that goes straight on to publish this capture has the
    // device ids it needs to build a mapping. The alternative is re-reading the list and hunting
    // for the row that just appeared, which races the refresh that put it there.
    return { id: captureId, path, messages: parsed.messages.length, manifest };
  },

  /**
   * Ask an edge node to republish its birth certificate.
   *
   * THE PAGE DOES NOT SEND IT. A browser cannot publish MQTT, so this writes a row and the
   * ingestion daemon -- which holds the only broker account permitted to write an NCMD -- picks it
   * up within a few seconds. The answer arrives as an `NBIRTH` on the wire, not as a response here.
   *
   * THIS IS THE ONLY COMMAND THIS STACK SENDS. Sparkplug's NCMD channel can also write metric
   * VALUES, which is actuation; that is not reachable from the dashboard and 0058 has a self-check
   * asserting the table it writes has not grown a way to carry one.
   */
  requestRebirth: async (gatewayId) => {
    const { data, error } = await supabase.rpc('request_gateway_rebirth', {
      p_gateway_id: gatewayId
    });
    if (error) {
      if (/insufficient_privilege|requires Administrator/i.test(error.message || '')) {
        throw new Error('Requesting a rebirth requires Administrator or Shopfloor Manager.');
      }
      throw new Error(error.message || 'Could not request a rebirth');
    }
    return data;
  },

  /**
   * Gateways a capture may be published onto, with their devices and their credential state.
   *
   * SIMULATED ONLY, because `start_playback_job()` refuses anything else -- offering a real gateway
   * in this dropdown would be offering a click that is always refused, and the refusal is the last
   * line of defence rather than a validation message.
   *
   * `gateway_has_broker_credential` IS A COMPUTED FIELD, not a second request. PostgREST exposes a
   * function taking the table's row type as a selectable column, so the gate's own predicate is
   * what the dialog displays -- rather than a second implementation of "does this look ready",
   * which is how a UI ends up disagreeing with the check it is describing.
   */
  playbackTargets: async () => {
    const { data, error } = await supabase
      .from('gateways')
      // `status` and `last_heartbeat` are read to warn about a target something ELSE is already
      // publishing as -- see StartPlaybackModal. Not to refuse one: a playback target is
      // legitimately OFFLINE, because nothing publishes as it until a playback runs.
      .select('id, name, sparkplug_id, sparkplug_group, is_archived, status, last_heartbeat, gateway_has_broker_credential, devices(id, name, sparkplug_id, is_archived, shadow_of)')
      // `is_shadow`, NOT `is_simulated` (archived migration 0060). A simulator is marked simulated and holds
      // a credential and would pass every tier -- and Node-RED is publishing as it at the same
      // time. Two publishers share one Sparkplug `seq` counter, the daemon reads the interleaving
      // as message loss, and it asks the live node for a rebirth in the middle of the playback.
      // The database refuses that now; offering it here would only make the refusal a surprise.
      .eq('is_shadow', true)
      .eq('is_archived', false)
      .order('name');
    if (error) throw new Error(error.message || 'Could not list playback targets');
    return (data || []).map(g => ({
      ...g,
      devices: (g.devices || []).filter(d => !d.is_archived)
    }));
  },

  /**
   * Find or create one replay lane per device in a capture, and return the map to publish under.
   *
   * A WRITE, AND DELIBERATELY NOT AUTOMATIC. It creates directory rows, so it hangs off an explicit
   * click rather than off opening a dialog or changing a dropdown — a device appearing in the
   * Devices table because someone browsed a modal is the kind of surprise that makes people stop
   * trusting the table.
   *
   * Idempotent: a lane is keyed on (playback gateway, original device) and reused, so replaying the
   * same capture three times puts three replays on one lane rather than creating three. That is
   * what lets a chart comparing a machine with its replay hold still between runs.
   */
  ensureShadowLanes: async (captureId) => {
    const { data, error } = await supabase.rpc('ensure_shadow_devices', { p_capture_id: captureId });
    if (error) throw new Error(error.message || 'Could not prepare replay lanes');
    return data || {};
  },

  /**
   * What the playback worker can actually publish as, and when it last said so.
   *
   * THE THIRD FACT THE DIALOG NEEDS, and the only one the database cannot derive. A target can be
   * `is_simulated` and hold a platform-issued credential and still be unreachable, because the
   * password is minted in a browser and pasted into the worker's environment by hand — two acts,
   * and nothing until now noticed when only the first had happened.
   *
   * Returns null when nothing has ever reported, which the caller treats the same as stale: in
   * both cases the honest thing to say is that the worker is not running.
   */
  playbackWorkerStatus: async () => {
    const { data, error } = await supabase
      .from('playback_worker_status')
      .select('held_edge_nodes, reported_at')
      .maybeSingle();
    if (error) throw new Error(error.message || 'Could not read the playback worker status');
    return data || null;
  },

  activePlaybackJob: async () => {
    const { data, error } = await supabase
      .from('playback_jobs')
      .select('*, gateways(name, sparkplug_id), captures(note, subject_sparkplug_id)')
      .in('status', ['PENDING', 'RUNNING'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Could not read playback jobs');
    return data || null;
  },

  recentPlaybackJobs: async (limit = 4) => {
    const { data, error } = await supabase
      .from('playback_jobs')
      .select('*, gateways(name, sparkplug_id)')
      .in('status', ['COMPLETED', 'FAILED', 'CANCELLED'])
      .order('finished_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message || 'Could not read playback jobs');
    return data || [];
  },

  /**
   * Queue a playback. Returns the job id.
   *
   * EVERY REFUSAL COMES BACK VERBATIM. The gate names what it objected to -- a target that is not
   * simulated, one with no broker credential, a device mapped onto another gateway's device, a
   * playback already running onto that edge node -- and each of those is a different thing for the
   * operator to do next. Flattening them to "could not start playback" would throw that away.
   */
  startPlayback: async ({ captureId, targetGatewayId, deviceMap, speed }) => {
    const { data, error } = await supabase.rpc('start_playback_job', {
      p_capture_id: captureId,
      p_target_gateway_id: targetGatewayId,
      p_device_map: deviceMap || {},
      p_speed: speed
    });
    if (error) {
      if (/insufficient_privilege|requires Administrator/i.test(error.message || '')) {
        throw new Error('Publishing a capture requires Administrator or Shopfloor Manager.');
      }
      throw new Error(error.message || 'Could not start the playback');
    }
    return data;
  },

  stopPlayback: async (jobId) => {
    const { data, error } = await supabase.rpc('request_playback_stop', { p_job_id: jobId });
    if (error) throw new Error(error.message || 'Could not stop the playback');
    return data === true;
  },

  /**
   * A short-lived signed URL. Signed because the bucket is private -- there is no public URL.
   *
   * `download` NAMES THE SAVED FILE AND FORCES AN ATTACHMENT. A capture is JSON, so without it the
   * browser renders the file in the tab instead of saving it -- which for a 50 MiB recording is a
   * tab that hangs rather than a download. The name is the subject's own, so a folder of captures
   * from four gateways is not four files called `capture.json`.
   */
  captureUrl: async (path) => {
    const filename = `${(path.split('/')[0] || 'capture')}.capture.json`;
    const { data, error } = await supabase.storage
      .from(CAPTURE_BUCKET).createSignedUrl(path, 60, { download: filename });
    if (error) throw new Error(error.message || 'Could not create a download link');
    return withApiKey(data.signedUrl);
  },

  /**
   * Remove a capture: the row and the object.
   *
   * THE ROW GOES FIRST, which is the opposite of the upload order and for the same reason. If the
   * object delete then fails, what is left is bytes nothing references -- invisible, and overwritten
   * by the next capture of that subject. Deleting the object first and failing on the row would
   * leave the list offering a capture that cannot be downloaded.
   */
  deleteCapture: async (capture) => {
    const { error } = await supabase.from('captures').delete().eq('id', capture.id);
    if (error) {
      if (/row-level security|Unauthorized|denied/i.test(error.message || '')) {
        throw new Error('You do not have permission to delete captures.');
      }
      throw new Error(error.message || 'Delete failed');
    }
    const { error: objectError } = await supabase.storage
      .from(CAPTURE_BUCKET).remove([capture.storage_path]);
    if (objectError) {
      throw new Error(
        `The capture was removed from the list, but its file could not be deleted: ` +
        `${objectError.message}. It will be overwritten by the next capture of this subject.`
      );
    }
  },

  get: async (path, options = {}) => {
    const entityDigitalThreadMatch = path.match(/\/api\/v1\/(cells|gateways|devices|assets)\/([^/]+)\/digital-thread/);
    if (entityDigitalThreadMatch) {
      const rawEntityType = entityDigitalThreadMatch[1];
      const entityId = entityDigitalThreadMatch[2];
      const SINGULAR_MAP = { cells: 'cell', gateways: 'gateway', devices: 'device', assets: 'device' };
      const singularType = SINGULAR_MAP[rawEntityType] || rawEntityType.replace(/s$/, '');

      /**
       * The entity types that belong to THIS entity's history as well as their own.
       *
       * `device_nameplate` rows are keyed by the DEVICE id -- an approved nameplate change is a
       * thing that happened to that machine, and filing it only under a table name would leave the
       * device's own timeline silent about it. This is the one place the union is expressed, so a
       * reader opening a device sees what was asserted about it beside what was configured on it.
       */
      const ALSO_ABOUT = { device: ['device_nameplate'], devices: ['device_nameplate'] };
      const alsoAbout = new Set(ALSO_ABOUT[singularType] || []);

      let query = supabase.from('digital_thread').select('*').eq('entity_id', entityId);
      const { data, error } = await query.order('recorded_at', { ascending: false });
      if (error) throw error;

      const filtered = (data || []).filter(t => {
        if (!t.entity_type) return true;
        const et = t.entity_type.toLowerCase();
        return et === singularType || et === rawEntityType || et === `${singularType}s`
          || alsoAbout.has(et);
      });

      return filtered.map(mapDigitalThreadRow);
    }

    if (path.startsWith('/api/v1/archives')) {
      const [cellsRes, gatewaysRes, devicesRes] = await Promise.all([
        supabase.from('cells').select('*').eq('is_archived', true),
        supabase.from('gateways').select('*').eq('is_archived', true),
        supabase.from('devices').select('*').eq('is_archived', true)
      ]);

      if (cellsRes.error) throw cellsRes.error;
      if (gatewaysRes.error) throw gatewaysRes.error;
      if (devicesRes.error) throw devicesRes.error;

      const cells = (cellsRes.data || []).map(c => ({
        entity_id: c.id,
        name: c.name,
        entity_type: 'cell',
        archived_at: c.archived_at,
        auto_delete_at: c.auto_delete_at
      }));

      const gateways = (gatewaysRes.data || []).map(g => ({
        entity_id: g.id,
        name: g.name,
        entity_type: 'gateway',
        archived_at: g.archived_at,
        auto_delete_at: g.auto_delete_at,
        // WHAT ARCHIVING TOOK, so the restore dialog can say it as a fact rather than a hedge.
        // `revoke_credential_on_decommission()` (0038, repredicated by 0063) rotates a gateway's
        // broker credential to a password nobody records when it is archived -- and restoring
        // flips `is_archived` back and nothing else, so the account does not come back with it.
        // Free to carry: the select above is already `*`.
        credential_revoked_at: g.credential_revoked_at
      }));

      const devices = (devicesRes.data || []).map(d => ({
        entity_id: d.id,
        name: d.name,
        entity_type: 'device',
        archived_at: d.archived_at,
        auto_delete_at: d.auto_delete_at
      }));

      const combined = [...cells, ...gateways, ...devices];
      combined.sort((a, b) => new Date(b.archived_at || 0) - new Date(a.archived_at || 0));
      return combined;
    }

    if (path.startsWith('/api/v1/cells')) {
      // Nested embed so each cell arrives with its gateways, and each gateway with its
      // devices, in one round trip.
      //
      // A cell's GATEWAYS come from the embed -- that relationship is a plain foreign key. Its
      // DEVICES are NOT returned here at all: membership is the resolved effective cell, which
      // no embed can express (a device explicitly placed here whose gateway serves another cell
      // would be missing, and one placed elsewhere wrongly included). Fetching every device
      // here to bucket them server-side worked, but every caller of this endpoint already loads
      // the device list for its own purposes, so it read the same table twice per refresh --
      // and Overview polls at 3s. Callers group what they already hold with
      // groupDevicesByCell() from utils/cellResolution.js instead.
      //
      // `devices`/`device_count` are omitted rather than returned empty, so a consumer that
      // still expects them fails visibly instead of quietly rendering an empty cell.
      const { data, error } = await supabase
        .from('cells')
        .select(`*, gateways(${GATEWAY_EMBED})`)
        .order('created_at', { ascending: false });
      if (error) throw error;

      return (data || []).map(c => {
        // No locations map: every embedded device carries its own cell_id and location_scope,
        // and its gateway is the row it is embedded under, so local resolution is exact here.
        const gateways = (c.gateways || []).map(g => mapGatewayRow(g));
        return {
          ...c,
          cell_id: c.id,
          cell_name: c.name,
          access_url: c.grafana_url,
          gateways,
          gateway_count: gateways.length
        };
      });
    }

    if (path.startsWith('/api/v1/gateways')) {
      const [{ data, error }, locations] = await Promise.all([
        supabase.from('gateways').select(`*, devices(${DEVICE_EMBED})`).order('created_at', { ascending: false }),
        loadDeviceLocations()
      ]);
      if (error) throw error;
      // A gateway lists the devices it SERVES -- the data path -- which is the embed and is
      // unaffected by location overrides. The locations only decorate each device with where it
      // resolved to, so the page can show that a device it serves sits in another cell.
      return (data || []).map(g => mapGatewayRow(g, locations));
    }

    /**
     * Latest value per metric for ONE device -- what the Devices page's telemetry drawer shows.
     *
     * Checked before the /config route below and before the collection route, because both
     * would otherwise match this path first.
     *
     * Scoped to a single asset, unlike the fleet-wide /telemetry/latest above, so the bounded
     * page it reads is spent entirely on this device: a shared fleet query with limit 1000
     * would silently omit metrics from a busy shopfloor. The window is generous by default
     * (24h) because the drawer's job is to say what a metric last read, and a machine that
     * reports hourly should not appear to have no data.
     */
    if (path.match(/\/api\/v1\/devices\/(.+)\/telemetry\/latest/)) {
      const match = path.match(/\/api\/v1\/devices\/(.+)\/telemetry\/latest/);
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '1440', 10);
      return queryLatestTelemetry({ assetId: match[1], minutes });
    }

    /**
     * Everything the nameplate editor needs, in one round trip: the template's element list, the
     * stored row, and what the device publishes for itself.
     *
     * THE THIRD PART IS THE POINT. The AAS exporter prefers a device-published value over a stored
     * one (archived migration 0011), so a form that did not show which fields the device already answers
     * would let an operator type a serial number, save it, and never see it in the export -- with
     * nothing on screen explaining why. The join is on `semantic_id`, exactly as the exporter does
     * it, because a device may call its serial number anything.
     */
    if (path.match(/\/api\/v1\/devices\/(.+)\/nameplate/)) {
      const deviceId = path.match(/\/api\/v1\/devices\/(.+)\/nameplate/)[1];
      const [{ data: stored }, { data: template, error: templateError }, { data: catalog }] =
        await Promise.all([
          supabase.from('device_nameplate').select('*').eq('device_id', deviceId),
          supabase.from('idta_submodel_templates')
            .select('id_short, semantic_id, semantic_id_type, description, is_mandatory, ordinal')
            .eq('template_id', NAMEPLATE_TEMPLATE_ID)
            .order('ordinal', { ascending: true }),
          supabase.from('metric_catalog').select('name, semantic_id').not('semantic_id', 'is', null)
        ]);
      if (templateError) throw templateError;

      const bySemanticId = new Map();
      for (const metric of catalog || []) {
        if (!bySemanticId.has(metric.semantic_id)) bySemanticId.set(metric.semantic_id, metric.name);
      }
      const wanted = [...NAMEPLATE_PUBLISHED_BY.values()]
        .map(id => bySemanticId.get(id)).filter(Boolean);

      let published = {};
      if (wanted.length > 0) {
        const { data: config } = await supabase
          .from('asset_config')
          .select('metric_name, val_string, val_double, val_bool')
          .eq('asset_id', toTelemetryKey(deviceId))
          .in('metric_name', wanted);
        const valueOf = row =>
          row.val_string ?? (row.val_double ?? (row.val_bool === null ? null : String(row.val_bool)));
        const byMetricName = new Map((config || []).map(row => [row.metric_name, valueOf(row)]));
        published = Object.fromEntries(
          [...NAMEPLATE_PUBLISHED_BY.entries()]
            .map(([field, semanticId]) => [field, byMetricName.get(bySemanticId.get(semanticId))])
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
        );
      }

      return { stored: stored?.[0] || null, template: template || [], published };
    }

    if (path.match(/\/api\/v1\/devices\/(.+)\/config/)) {
      const match = path.match(/\/api\/v1\/devices\/(.+)\/config/);
      // asset_config is keyed by the device's sparkplug_id, written by the ingestion daemon
      // on DBIRTH; the UI passes a device UUID.
      const { data, error } = await supabase
        .from('asset_config')
        .select('*')
        .eq('asset_id', toTelemetryKey(match[1]))
        .order('metric_name', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/devices') || path.startsWith('/api/v1/assets')) {
      // Embed the serving gateway so each device carries its resolved gateway name, and read
      // device_locations for the effective cell. The gateway's own cell is still selected: it is
      // what the local fallback resolves from, and what tells the UI that an explicit cell
      // disagrees with the data path.
      const [{ data, error }, locations] = await Promise.all([
        supabase
          .from('devices')
          // `is_simulated` and `is_shadow` are selected for the FALLBACK path, not for the happy
          // one: device_locations already resolves the lanes server-side, but when that read fails
          // resolveDeviceLocation() re-derives locally, and without these two every simulated
          // device would degrade to Unassigned -- the exact misreport this embed exists to avoid
          // for cell_id.
          .select('*, gateways(id, name, cell_id, location_scope, is_simulated, is_shadow, status, is_archived)')
          .order('created_at', { ascending: false }),
        loadDeviceLocations()
      ]);
      if (error) throw error;

      // The schemas attached through device_submodels (archived migration 0034), one AAS Submodel each.
      // Read from the `device_schemas` view so the fallback to the legacy 1:1 devices.schema_id is
      // applied once, in SQL, rather than being re-derived by every caller. A failure here is
      // non-fatal: schemasForDevice() falls back to schema_id, so the page degrades to
      // single-submodel behaviour instead of rendering no devices at all.
      const { data: links } = await supabase.from('device_schemas').select('device_id, schema_id');
      const schemasByDevice = new Map();
      for (const link of links || []) {
        if (!schemasByDevice.has(link.device_id)) schemasByDevice.set(link.device_id, []);
        schemasByDevice.get(link.device_id).push(link.schema_id);
      }

      // No `cell_id:` override here. It used to be set to the gateway's cell AFTER the spread,
      // which -- now that devices have a cell_id of their own -- would silently discard the
      // column it is named after. The resolved value is `effective_cell_id`; `cell_id` is the
      // device's own explicit override, or null meaning inherit.
      return (data || []).map(d => ({
        ...mapDeviceRow(d, d.gateways, locations?.get(d.id)),
        submodel_schema_ids: schemasByDevice.get(d.id) || []
      }));
    }

    if (path.includes('/digital-thread')) {
      // Every one of these parameters was previously parsed by the caller, appended to the path,
      // and then dropped on the floor here -- the Digital Thread tab's entity dropdown, search box
      // and row limit all had no effect at all. They are honoured now.
      const url = new URL(path, window.location.origin);
      const entityType = url.searchParams.get('entity_type');
      const search = (url.searchParams.get('entity_id') || '').trim();
      const entityIds = url.searchParams.has('entity_ids')
        ? url.searchParams.get('entity_ids').split(',').filter(Boolean)
        : undefined;
      // INSERT / UPDATE / DELETE. Filtered in SQL rather than client-side because the row limit
      // is applied by the database: filtering after the fact would page through 200 mixed rows
      // and then show whatever fraction of them happened to be deletions.
      const action = (url.searchParams.get('action') || '').trim().toUpperCase();
      const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
      // The timeline's range control, for the same reason the action filter is a SQL predicate
      // and for one more besides. `limit` is applied by the database to rows ordered NEWEST
      // FIRST, so a window filtered client-side would first take the newest 200 rows overall and
      // only then discard everything outside the range -- which means "Last 30 Days" could
      // legitimately show FEWER events than "Last 24 Hours", having spent its whole budget on
      // rows it went on to throw away. Pushed down, the limit is spent inside the window.
      const since = (url.searchParams.get('since') || '').trim();
      const until = (url.searchParams.get('until') || '').trim();

      // THE KEYSET CURSOR (0077): where the reader got to, not how far in they are. Both halves or
      // neither -- `recorded_at` is not unique, because log_digital_thread_event() stamps one
      // transaction's rows with one `now()` and a batch relocation of six devices is deliberately
      // one transaction (0033). A cursor of "older than T" would skip the other five rows of that
      // batch and a cursor of "T or older" would repeat the first one forever, so the id is what
      // makes the position exact. Sent as a pair or not at all; the RPC ignores a half-cursor and
      // this refuses to send one.
      const beforeRecordedAt = (url.searchParams.get('before_recorded_at') || '').trim();
      const beforeId = (url.searchParams.get('before_id') || '').trim();
      const hasCursor = beforeRecordedAt !== '' && beforeId !== '';

      // A tag that matches no device must return nothing rather than everything.
      if (entityIds && entityIds.length === 0) return [];

      // THE DELETED-ASSET FILTER HAS TO BE A PREDICATE, NOT A POST-FILTER, WHICH IS WHY THIS IS AN
      // RPC. Every other filter on this page is already pushed down for the reason `namedEntityIds`
      // states: the limit is applied by the database, so filtering afterwards pages through 200
      // mixed rows and shows whichever fraction survived. Hiding purged assets was the one filter
      // still applied in the browser, and it produced exactly that failure -- four assets listed on
      // a stack of twenty-six, and a Gateways section that rendered empty on four healthy gateways,
      // because the window had been spent on rows that were then discarded.
      //
      // It cannot be expressed as a PostgREST filter: "still exists" is an anti-join against three
      // tables. `digital_thread_page()` (archived migration 0039) does it in one statement and returns the
      // purged COUNT alongside the page -- the count drives the control that reveals them, so
      // deriving it from the page would have made the button vanish exactly when it was needed.
      const includePurged = url.searchParams.get('include_purged') === 'true';

      if (action && !Object.prototype.hasOwnProperty.call(DIGITAL_THREAD_ACTIONS, action)) {
        // An action the client does not know about. Refusing beats widening: returning every row
        // for an unrecognised filter is how a caller ends up believing it has seen a filtered set.
        return [];
      }

      const { data, error } = await supabase.rpc('digital_thread_page', {
        p_limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        p_include_purged: includePurged,
        // Normalised to the stored form. The trigger writes TG_TABLE_NAME -- 'cells' / 'gateways' /
        // 'devices' -- and the UI has always offered 'CELL' / 'GATEWAY' / 'DEVICE'.
        //
        // THIS MAP WAS WRITTEN OUT HERE WITH FOUR ENTRIES AND IS NOW READ FROM `constants.js`
        // (#141), because the warning the old comment carried came true. It said an entry missing
        // from the map "falls through unchanged and matches no row at all, which reads as 'no
        // events' rather than as a broken filter" -- and when 0070 added `user_roles`, `schemas`
        // and `system_settings` to the audit trigger, three kinds arrived that this map did not
        // know. Sharing one table with the dropdown that offers them is what makes that
        // unrepeatable: a kind cannot now be offered without also being resolvable.
        //
        // The fallback stays. A kind this build does not recognise is passed through rather than
        // nulled, because searching for it and finding nothing is a better answer than silently
        // widening to every row.
        p_entity_type: entityType
          ? (ENTITY_TABLE_BY_KIND[entityType.toUpperCase()] || entityType)
          : null,
        p_action: action || null,
        p_entity_ids: entityIds && entityIds.length ? entityIds : null,
        p_since: since || null,
        p_until: until || null,
        // OMITTED ENTIRELY WHEN THERE IS NO CURSOR, rather than sent as null, and that is a
        // compatibility decision rather than a stylistic one. PostgREST resolves an RPC by the
        // names it is given, so naming these two against a database that has not applied 0077
        // fails outright:
        //
        //   ERROR: function public.digital_thread_page(p_limit => integer,
        //          p_before_recorded_at => timestamptz, p_before_id => integer) does not exist
        //
        // -- measured, not inferred. That would take the whole Digital Thread page down on a stack
        // whose migrations have not replayed yet, which is a worse failure than the one this change
        // exists to fix. Omitted, the call matches the seven-argument form, the page renders
        // unpaged, and `truncated` still tells the reader the view is cut off.
        ...(hasCursor
          ? { p_before_recorded_at: beforeRecordedAt, p_before_id: Number(beforeId) }
          : {}),
      });
      if (error) throw error;

      const payload = data || {};
      let rows = (payload.events || []).map(mapDigitalThreadRow);

      // Substring match, applied after mapping so it searches the rendered description rather
      // than the raw columns -- that is what the field's placeholder promises.
      if (search) {
        const needle = search.toLowerCase();
        rows = rows.filter(r =>
          String(r.entity_id || '').toLowerCase().includes(needle) ||
          String(r.description || '').toLowerCase().includes(needle)
        );
      }

      // THE ARRAY IS STILL THE RETURN VALUE, with the two page-level facts attached to it.
      //
      // `api.get(path)` resolves to the RESOURCE everywhere else in this file, and one path
      // resolving to a wrapper object would be a contract every caller and every test mock has to
      // know about -- 97 of them found out at once when it was tried. Attaching the extras keeps
      // `.length`, `.map` and destructuring working, and lets a mock return a bare array and
      // simply have no opinion about deleted assets, which is the right default for a fixture.
      rows.purgedAssets = Number(payload.purged_assets || 0);
      rows.truncated = Boolean(payload.truncated);
      // NULL IS THE ONLY END-OF-DATA SIGNAL, and it comes from the server rather than being
      // inferred here. `rows` has already been through the description search above, so its length
      // says nothing about whether the database had more to give -- a page can filter down to
      // nothing and still sit in the middle of the thread. Deriving "the end" from `rows.length`
      // would stop the walk on the first page whose text nobody matched.
      rows.nextCursor = payload.next_cursor || null;
      return rows;
    }

    if (path.startsWith('/api/v1/quarantine')) {
      // The gateway's cell and scope are selected, not just its name: mapDeviceRow resolves the
      // device's location from them, and an embed that omitted them would report every
      // quarantined device as unassigned even when the edge node it arrived on has a cell. That
      // is what the approval modal has to show to be worth showing at all.
      const { data, error } = await supabase
        .from('devices')
        .select('*, gateways(id, name, cell_id, location_scope, is_simulated, is_shadow)')
        .eq('is_quarantined', true);
      if (error) throw error;

      // asset_config is keyed by sparkplug_id, which is derivable from the UUID we already have.
      const keys = (data || []).map(d => d.sparkplug_id || deviceSparkplugId(d.id)).filter(Boolean);
      let metricsByKey = new Map();
      if (keys.length > 0) {
        const { data: configRows, error: configError } = await supabase
          .from('asset_config')
          .select('asset_id, metric_name')
          .in('asset_id', keys);
        if (configError) throw configError;
        metricsByKey = (configRows || []).reduce((map, row) => {
          const list = map.get(row.asset_id) || [];
          list.push(row.metric_name);
          map.set(row.asset_id, list);
          return map;
        }, new Map());
      }

      return (data || []).map(d => {
        const sparkplugId = d.sparkplug_id || deviceSparkplugId(d.id);
        const reportedMetrics = metricsByKey.get(sparkplugId) || [];
        return {
          ...mapDeviceRow(d, d.gateways),
          quarantine_id: d.id,
          discovered_at: d.created_at,
          gateway_id: d.gateway_id || null,
          gateway_name: d.gateways?.name || null,
          // The id this device actually published under -- the only way a *malformed* one is
          // visible, since sparkplug_id is derived from the row's own UUID and so never equals
          // what a misconfigured gateway sent.
          reported_identity: d.reported_identity || null,
          quarantine_reason: d.quarantine_reason || null,
          reported_metrics: reportedMetrics,
          birth_payload: JSON.stringify(reportedMetrics)
        };
      });
    }

    if (path.startsWith('/api/v1/links')) {
      const url = new URL(path, window.location.origin);
      const entityType = url.searchParams.get('entity_type');
      const entityId = url.searchParams.get('entity_id');
      let query = supabase.from('links').select('*');
      if (entityType) query = query.eq('entity_type', entityType);
      if (entityId) query = query.eq('entity_id', entityId);
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(d => ({ ...d, id: d.id }));
    }

    if (path.startsWith('/api/v1/mtconnect-vocabulary')) {
      // Reference data (generated; seeded by 0002_seed_data.sql), read-only to the app. Returned
      // flat and bucketed by the caller -- it is ~600 short rows, fetched once per Schemas visit.
      const { data, error } = await supabase
        .from('mtconnect_vocabulary')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      // semantic_id is the concept-level local IRI added by archived migration 0032 -- distinct from the
      // observation-level id a catalog metric carries, which is built from the whole metric name.
      return (data || []).map(v => ({
        kind: v.kind, name: v.name, category: v.category, semantic_id: v.semantic_id ?? null
      }));
    }

    if (path.startsWith('/api/v1/iso22400-vocabulary')) {
      // Reference data (seeded by 0002_seed_data.sql), read-only to the app -- there is no write
      // policy on the table, so a POST here would fail at the database regardless.
      const { data, error } = await supabase
        .from('iso22400_vocabulary')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(k => ({
        name: k.name,
        kpi_id: k.kpi_id,
        description: k.description,
        category: k.category,
        unit: k.unit,
        formula: k.formula,
        semantic_id: k.semantic_id
      }));
    }

    if (path.startsWith('/api/v1/ashrae223-vocabulary')) {
      // Reference data (archived migration 0013), generated from the open223 ontology. Ordered by the
      // hierarchy the panel sections on, then by label -- the panel re-sorts, but arriving grouped
      // keeps a 640-row payload cheap to render on first paint.
      const { data, error } = await supabase
        .from('ashrae223_vocabulary')
        .select('*')
        .order('subclass_of', { ascending: true, nullsFirst: true })
        .order('label', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/opcua-vocabulary')) {
      // Reference data (seeded by 0002_seed_data.sql). Ordered by spec then name so the panel's
      // sections arrive already grouped. `node_id` is a browse path, not a numeric NodeId.
      const { data, error } = await supabase
        .from('opcua_vocabulary')
        .select('*')
        .order('companion_spec', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(p => ({
        name: p.name,
        companion_spec: p.companion_spec,
        node_id: p.node_id,
        description: p.description,
        datatype: p.datatype,
        unit: p.unit,
        semantic_id: p.semantic_id
      }));
    }

    // Checked before /metric-catalog: startsWith on the shorter path would otherwise not match,
    // but keeping the more specific route first makes the ordering intent explicit.
    if (path.startsWith('/api/v1/metric-groups')) {
      const { data, error } = await supabase.from('metric_groups').select('*').order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(g => ({
        group_uuid: g.id,
        name: g.name,
        description: g.description,
        // 'MTConnect' / 'ISO 22400' / null for a local group. Drives the picker's grouping, so
        // 126 component types don't arrive as one undifferentiated list.
        standard: g.standard ?? null,
        created_at: g.created_at
      }));
    }

    if (path.startsWith('/api/v1/metric-catalog')) {
      const { data, error } = await supabase.from('metric_catalog').select('*').order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(m => ({
        metric_uuid: m.id,
        name: m.name,
        // Generated column: the first dotted segment of the name, NULL when there isn't one.
        // See utils/metricGroup.js, which mirrors the derivation.
        metric_group: m.metric_group ?? null,
        datatype: m.datatype,
        // MTConnect facets. `standard` is provenance: 'MTConnect' for a standard data item type,
        // null for a local extension, which the standard itself permits.
        category: m.category ?? null,
        units: m.units ?? null,
        sub_type: m.sub_type ?? null,
        standard: m.standard ?? null,
        // AAS (IEC 63278) semanticId -- see 0001_baseline_schema.sql. NULL means unmapped, which is a
        // legitimate state: MTConnect publishes no per-type identifier, so those stay NULL.
        semantic_id: m.semantic_id ?? null,
        semantic_id_type: m.semantic_id_type ?? null,
        description: m.description,
        deprecated: m.deprecated,
        superseded_by: m.superseded_by,
        created_at: m.created_at
      }));
    }

    if (path.startsWith('/api/v1/schemas')) {
      const { data, error } = await supabase.from('schemas').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(s => ({
        schema_uuid: s.id,
        schema_name: s.schema_name,
        description: s.description,
        schema_definition: s.schema_definition,
        semantic_id: s.semantic_id ?? null,
        semantic_id_type: s.semantic_id_type ?? null,
        // Versioning (archived migration 0037). Defaulted here as well as in the column, so a client
        // pointed at a database that has not replayed 0037 renders v1/Active rather than
        // `vundefined · ` -- and so `isSchemaEditable()` fails closed on a row it cannot read a
        // status from, rather than opening an editor over a schema devices are attached to.
        version: s.version ?? 1,
        status: s.status ?? 'active',
        parent_schema_id: s.parent_schema_id ?? null,
        change_description: s.change_description ?? null,
        created_at: s.created_at
      }));
    }

    /*
     * The runtime configuration plane (archived migration 0031).
     *
     * ORDERED BY CATEGORY THEN LABEL, so the settings page groups without sorting client-side and
     * two administrators looking at the same install see the same order. `key` is deliberately not
     * the sort: `ui.digital_thread_lane_limit` sorting next to `ui.digital_thread_poll_seconds` is
     * a coincidence of naming, not a grouping anyone chose.
     */
    if (path.startsWith('/api/v1/settings')) {
      const { data, error } = await supabase
        .from('system_settings')
        .select('id,key,value,value_type,category,label,description,fallback_source,min_value,max_value,updated_at,updated_by')
        .order('category', { ascending: true })
        .order('label', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/directory')) {
      const { data, error } = await supabase.from('directory_services').select('*').order('service_name', { ascending: true });
      if (error) throw error;
      return (data || []).map(s => ({
        service_uuid: s.id,
        service_name: s.service_name,
        service_type: s.service_type,
        endpoint_url: s.endpoint_url,
        // Where the service can be reached FROM (0084). Passed through rather than defaulted here:
        // a row that predates the column reads UNKNOWN, and the Directory page says so in words
        // instead of guessing on its behalf.
        exposure: s.exposure,
        status: s.status,
        last_heartbeat: s.last_heartbeat
      }));
    }

    if (path.startsWith('/api/v1/stats')) {
      const [qRes, docRes] = await Promise.all([
        supabase.from('devices').select('id', { count: 'exact', head: true }).eq('is_quarantined', true),
        supabase.from('links').select('id', { count: 'exact', head: true })
      ]);
      return {
        quarantine_pending: qRes.count || 0,
        links_attached: docRes.count || 0
      };
    }

    // Latest value per (device, metric) inside a bounded recent window. Used by the
    // Overview map, which only needs current state -- not the full history the
    // export dialog pages through.
    if (path.startsWith('/api/v1/telemetry/latest')) {
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '60', 10);
      return queryLatestTelemetry({ minutes });
    }

    if (path.startsWith('/api/v1/telemetry')) {
      const url = new URL(path, window.location.origin);
      // asset_ids (plural) is how a tag filter asks for a whole group of devices at once. Absent
      // means "no device restriction"; present but empty means "a tag nobody matches".
      const assetIds = url.searchParams.has('asset_ids')
        ? url.searchParams.get('asset_ids').split(',').filter(Boolean)
        : undefined;
      return queryTelemetry({
        assetId: url.searchParams.get('asset_id'),
        assetIds,
        metricName: url.searchParams.get('metric_name'),
        minutes: Number.parseInt(url.searchParams.get('minutes') || '', 10),
        // Absolute bounds, used by the CSV export's custom range. Null when absent, so the
        // relative `minutes` form still applies for every other caller.
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: Number.parseInt(url.searchParams.get('limit') || '', 10),
        offset: Number.parseInt(url.searchParams.get('offset') || '', 10),
        // `?resolution=1m|5m|1h` reads a rollup instead of raw. Absent means raw, which is what
        // the CSV export wants; see TELEMETRY_RESOLUTIONS.
        resolution: url.searchParams.get('resolution') || undefined
      });
    }

    /**
     * The approvals queue (0086, 0088), with each proposal's target resolved beside it.
     *
     * THE WHOLE QUEUE IN ONE CALL, and the caps are what make that honest rather than lazy:
     * `proposals.max_open_per_person` bounds the open set per person and a partial unique index
     * bounds it per asset, so this is tens of rows on a plant with hundreds of machines. Filtering
     * happens in the component because every filter it offers -- mine, open, decided -- is a
     * question about rows it already holds.
     *
     * RLS DECIDES WHAT COMES BACK, not a parameter. A proposer reads their own; an Administrator or
     * Shopfloor_Manager reads the queue. Asking for `?mine=true` would be a second place that
     * question is answered, and the database's answer is the one that counts.
     *
     * THE TARGETS ARE FETCHED SEPARATELY, and there is no embed that could replace it: `entity_id`
     * addresses `devices`, `device_nameplate` or `schemas` depending on `entity_type`, and
     * PostgREST cannot join on a column whose table varies per row. Three queries keyed by the ids
     * actually referenced, rather than one per proposal.
     */
    if (path === '/api/v1/proposals') {
      const { data, error } = await supabase
        .from('change_proposals')
        .select('*')
        .order('proposed_at', { ascending: false });
      if (error) throw error;

      const rows = data || [];
      if (rows.length === 0) return [];

      const deviceIds = [...new Set(rows
        .filter(r => r.entity_type === 'devices' || r.entity_type === 'device_nameplate')
        .map(r => r.entity_id))];
      const schemaIds = [...new Set(rows
        .filter(r => r.entity_type === 'schemas')
        .map(r => r.entity_id))];

      const [devicesRes, nameplatesRes, schemasRes] = await Promise.all([
        deviceIds.length
          ? supabase.from('devices')
              .select('id,name,description,asset_type,connection_method,cell_id,location_scope,model_3d_path,is_archived')
              .in('id', deviceIds)
          : Promise.resolve({ data: [] }),
        deviceIds.length
          ? supabase.from('device_nameplate').select('*').in('device_id', deviceIds)
          : Promise.resolve({ data: [] }),
        schemaIds.length
          ? supabase.from('schemas').select('id,schema_name,version,status,parent_schema_id')
              .in('id', schemaIds)
          : Promise.resolve({ data: [] })
      ]);

      const devices = new Map((devicesRes.data || []).map(d => [d.id, d]));
      const nameplates = new Map((nameplatesRes.data || []).map(n => [n.device_id, n]));
      const schemas = new Map((schemasRes.data || []).map(s => [s.id, s]));

      return rows.map(r => {
        // `current` is what the patch would change FROM, so the page can show a diff rather than
        // only what was asked for. A nameplate with no row yet is `{}` and not an error: the row is
        // created by whoever first asserts something about the asset.
        let current = null;
        let targetLabel = r.entity_id;
        let targetMissing = false;

        if (r.entity_type === 'devices') {
          const d = devices.get(r.entity_id);
          current = d || null;
          targetLabel = d?.name || r.entity_id;
          targetMissing = !d;
        } else if (r.entity_type === 'device_nameplate') {
          const d = devices.get(r.entity_id);
          current = nameplates.get(r.entity_id) || {};
          targetLabel = d?.name || r.entity_id;
          targetMissing = !d;
        } else if (r.entity_type === 'schemas') {
          const sc = schemas.get(r.entity_id);
          current = sc || null;
          targetLabel = sc ? `${sc.schema_name} v${sc.version}` : r.entity_id;
          targetMissing = !sc;
        }

        return { ...r, target_label: targetLabel, target_missing: targetMissing, current };
      });
    }

    /**
     * Which keys a lane admits, asked of the DATABASE rather than mirrored here.
     *
     * `proposable_columns()` is the only place that answer exists -- the validation trigger and the
     * apply path both read it -- so a copy in this file would be a second list to keep in step, and
     * the failure would be a form offering a field every proposal is then refused for. It is
     * granted to `authenticated` precisely so the form can ask.
     */
    if (/^\/api\/v1\/proposals\/allowed-keys\/[^/]+$/.test(path)) {
      const entityType = decodeURIComponent(path.split('/')[5]);
      const { data, error } = await supabase.rpc('proposable_columns', { p_entity_type: entityType });
      if (error) throw error;
      return data || [];
    }

    /** The draft schemas a publication can be proposed for. Drafts only -- nothing else is publishable. */
    if (path === '/api/v1/proposals/publishable-schemas') {
      const { data, error } = await supabase
        .from('schemas')
        .select('id,schema_name,version,status,parent_schema_id')
        .eq('status', 'draft')
        .order('schema_name');
      if (error) throw error;
      return data || [];
    }

    throw new Error('Unhandled API path: ' + path);
  },

  post: async (path, body, options = {}) => {
    /**
     * File a proposal. A plain INSERT, deliberately: `0086` gives `Operator` an INSERT policy on
     * this one table, and routing it through an RPC would put the grant somewhere the RLS policy
     * is not -- which is the shape the caps are written to survive rather than to depend on.
     *
     * THE ERRORS ARE NOT FLATTENED. A unique violation is the per-asset cap and a check violation
     * is the per-person one; they need different repairs -- open the proposal you already have, or
     * decide one of the others -- so the codes ride back for the component to tell apart.
     */
    if (path === '/api/v1/proposals') {
      const { data, error } = await supabase
        .from('change_proposals')
        .insert({
          entity_type: body.entity_type,
          entity_id: body.entity_id,
          patch: body.patch,
          rationale: emptyToNull(body.rationale)
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    if (/^\/api\/v1\/proposals\/[^/]+\/(approve|reject|withdraw)$/.test(path)) {
      const parts = path.split('/');
      const proposalId = parts[4];
      const action = parts[5];

      // THREE RPCs, NOT ONE WITH A MODE. Each re-checks authority server-side for itself and they
      // do not admit the same people: rejecting is gated exactly as approving is, and withdrawing
      // is the proposer's own act and nobody else's.
      const rpc = { approve: 'approve_proposal', reject: 'reject_proposal', withdraw: 'withdraw_proposal' }[action];
      const args = action === 'reject'
        ? { p_proposal_id: proposalId, p_reason: body?.reason }
        : { p_proposal_id: proposalId };

      const { data, error } = await supabase.rpc(rpc, args);
      if (error) throw error;
      return data;
    }

    if (path.includes('/archive')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;
      const now = new Date().toISOString();
      const days = body?.auto_delete_days;
      const auto_delete_at = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

      let query = supabase
        .from(table)
        .update({ is_archived: true, archived_at: now, auto_delete_at });
      query = query.eq('id', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/restore')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;

      let query = supabase
        .from(table)
        .update({ is_archived: false, archived_at: null, auto_delete_at: null });
      query = query.eq('id', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/quarantine/') && path.endsWith('/reject')) {
      const parts = path.split('/');
      const id = parts[4];
      let query = supabase.from('devices').delete();
      query = query.eq('id', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path === '/api/v1/cells') {
      const { data, error } = await supabase.from('cells').insert({
        name: body.cell_name,
        grafana_url: body.access_url,
        // Omitted rather than defaulted here when the caller sends nothing: the column's own
        // NOT NULL DEFAULT 'Factory' is the single place that value lives, and repeating it in
        // the client is how the two eventually disagree.
        ...(body.icon ? { icon: body.icon } : {})
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/gateways') {
      const { data, error } = await supabase.from('gateways').insert({
        name: body.gateway_name,
        description: emptyToNull(body.description),
        access_url: body.access_url,
        // 'remote' when the caller says nothing, matching the create form's own default: the
        // case that needs an appliance is the one an operator must opt OUT of, or a gateway can be
        // created that quietly never gets hardware.
        deployment: body.deployment === 'host' ? 'host' : 'remote',
        // Defaulted rather than omitted so a gateway created for playback can be flagged in one
        // step. The column is NOT NULL DEFAULT false (0052), so `false` here and an absent key
        // reach the same row -- being explicit is for the reader, not the database.
        is_simulated: !!body.is_simulated,
        status: body.status || 'OFFLINE',
        ...locationFieldsFrom(body)
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/devices') {
      const { data, error } = await supabase.from('devices').insert({
        name: body.asset_name,
        description: emptyToNull(body.description),
        gateway_id: gatewayIdFrom(body),
        asset_type: emptyToNull(body.asset_type),
        connection_method: emptyToNull(body.connection_method),
        schema_id: emptyToNull(body.schema_id),
        status: body.status || 'ONLINE',
        // Omitted entirely when the caller sends nothing: cell_id has no column default, and
        // that is load-bearing. NULL means "inherit from the gateway", so writing an explicit
        // value here on behalf of a caller who did not choose one would make inheritance
        // unreachable for every device this form creates.
        ...locationFieldsFrom(body)
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/links') {
      const { data, error } = await supabase.from('links').insert({
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        display_name: body.display_name,
        url: body.url,
        link_tag: body.link_tag || 'other'
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/metric-groups') {
      // `standard` records which vocabulary a group came from. It was dropped here, so every
      // group created through the Add Metric form landed with standard = NULL and filed under
      // "Local" -- invisible while the picker merely bucketed groups, but wrong the moment it
      // FILTERS by standard: a group you had just created under MTConnect would vanish from the
      // MTConnect list. Empty string is the Custom standard, which is stored as NULL by design
      // (see STANDARDS.CUSTOM in utils/standards.js), so emptyToNull is the correct mapping.
      const { data, error } = await supabase.from('metric_groups').insert({
        name: body.name,
        description: emptyToNull(body.description),
        standard: emptyToNull(body.standard)
      }).select().single();
      if (error) throw error;
      return {
        group_uuid: data.id,
        name: data.name,
        description: data.description,
        standard: data.standard ?? null
      };
    }

    if (path === '/api/v1/metric-catalog') {
      // THE LAST CHECK BEFORE SOMETHING PERMANENT. `metric_catalog.name` is immutable, so a
      // non-conforming name cannot be corrected -- only deprecated and superseded. The Add Metric
      // form already refuses one (SchemasTab gates its submit on isValidMetricName), and
      // `metric_catalog_name_format` in archived migration 0007 refuses it at the database. This closes the
      // gap between them: any OTHER caller of this route would otherwise reach the constraint and
      // get a raw PostgREST 400 quoting a regex, where metricNameError() states the problem in a
      // sentence naming the offending character.
      //
      // Deliberately the same mirrored expression, not a second one -- see utils/metricGroup.js.
      const nameError = metricNameError(body.name)
      if (nameError) throw new Error(nameError)

      const { data, error } = await supabase.from('metric_catalog').insert({
        name: (body.name || '').trim(),
        datatype: body.datatype,
        category: emptyToNull(body.category),
        units: emptyToNull(body.units),
        sub_type: emptyToNull(body.sub_type),
        standard: emptyToNull(body.standard),
        semantic_id: emptyToNull(body.semantic_id),
        // Only meaningful alongside an id. Sent as NULL when the id is blank so the pair cannot
        // end up half-populated, which would export as a Reference with a type and no value.
        semantic_id_type: emptyToNull(body.semantic_id) ? emptyToNull(body.semantic_id_type) : null,
        description: body.description || null
      }).select();
      if (error) throw error;
      const item = data?.[0] || {};
      return { metric_uuid: item.id || '', ...item };
    }

    if (path.includes('/metric-catalog/') && path.endsWith('/deprecate')) {
      const parts = path.split('/');
      const id = parts[4];
      const { data, error } = await supabase.from('metric_catalog').update({
        deprecated: true,
        superseded_by: emptyToNull(body?.superseded_by)
      }).eq('id', id).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/schemas/validate') {
      const { schema_uuid, payload } = body;
      const { data, error } = await supabase.from('schemas').select('*').eq('id', schema_uuid);
      if (error || !data || data.length === 0) {
        return { valid: false, error: 'Target schema definition not found' };
      }
      const schemaDef = data[0].schema_definition;
      if (schemaDef?.required && Array.isArray(schemaDef.required)) {
        for (const req of schemaDef.required) {
          if (payload[req] === undefined || payload[req] === null) {
            return { valid: false, error: `Missing required field: ${req}` };
          }
        }
      }
      return { valid: true, message: 'Payload strictly conforms to target JSON schema' };
    }

    // Versioning (archived migration 0037). Both of these are RPCs rather than table writes, and that is
    // the point: `version` is computed from the parent and `publish` has to repoint every device
    // and archive the predecessor in one transaction. A client that could do either through
    // PostgREST could renumber history or leave a fleet half-rebound, so the database refuses
    // both -- `enforce_schema_version_provenance()` rejects a directly-inserted version, and
    // `prevent_active_schema_mutation()` rejects a directly-flipped status.
    if (/^\/api\/v1\/schemas\/[^/]+\/versions$/.test(path)) {
      const parentId = path.split('/')[4];
      const { data, error } = await supabase.rpc('fork_schema', {
        parent_schema_id: parentId,
        // Optional by design. Sent as null rather than '' so the column records "not given"
        // instead of an empty string that reads as a description nobody wrote.
        change_description: emptyToNull(body?.change_description)
      });
      if (error) throw error;
      return { schema_uuid: data?.id || '', ...(data || {}) };
    }

    /**
     * Discard a draft, returning the lineage to the state before the fork.
     *
     * THROUGH THE RPC, NOT A DELETE. `schemas_delete_privileged` has admitted an Administrator
     * since the baseline, and a plain DELETE is exactly the mistake `0091` exists to prevent:
     * `devices.schema_id` is ON DELETE SET NULL and `device_submodels.schema_id` is ON DELETE
     * CASCADE, so deleting an ACTIVE schema silently detaches every device bound to it. The
     * function refuses anything that is not a draft and reports what the cascade removed.
     */
    if (/^\/api\/v1\/schemas\/[^/]+\/discard$/.test(path)) {
      const draftId = path.split('/')[4];
      const { data, error } = await supabase.rpc('discard_schema_draft', {
        p_schema_id: draftId
      });
      if (error) throw error;
      return {
        discarded_schema_name: data?.discarded_schema_name || '',
        version: data?.version ?? null,
        parent_schema_id: data?.parent_schema_id ?? null,
        // Counted before the delete, because the CASCADE reports nothing -- and a draft attached
        // to a machine to try it out is a real state, so this is not always zero.
        devices_detached: data?.devices_detached ?? 0
      };
    }

    if (/^\/api\/v1\/schemas\/[^/]+\/publish$/.test(path)) {
      const draftId = path.split('/')[4];
      const { data, error } = await supabase.rpc('publish_schema_version', {
        draft_schema_id: draftId
      });
      if (error) throw error;
      // The counts ride back beside the row: publishing rebinds devices, and an operator who is
      // not told how many has no way to know whether it did what they expected.
      return {
        schema_uuid: data?.schema?.id || '',
        ...(data?.schema || {}),
        archived_schema_id: data?.archived_schema_id ?? null,
        archived_schema_name: data?.archived_schema_name ?? null,
        devices_rebound: data?.devices_rebound ?? 0
      };
    }

    if (path === '/api/v1/schemas') {
      const { data, error } = await supabase.from('schemas').insert({
        schema_name: body.schema_name,
        description: body.description,
        schema_definition: body.schema_definition,
        semantic_id: emptyToNull(body.semantic_id),
        semantic_id_type: emptyToNull(body.semantic_id) ? emptyToNull(body.semantic_id_type) : null,
        // A newly built schema is v1 and in force immediately -- `version` and `status` are left
        // to their column defaults rather than sent, because sending them is exactly what the
        // provenance trigger refuses. The wording is stated here as well as in 0037's backfill so
        // a schema created today reads the same as one created before versioning existed.
        change_description: emptyToNull(body.change_description) || 'Initial release'
      }).select();
      if (error) throw error;
      const item = data?.[0] || {};
      return { schema_uuid: item.id || '', ...item };
    }

    if (path.startsWith('/api/v1/devices/aas-export')) {
      // The whole document is composed server-side: the shell needs
      // the service role to read asset_config and the full metric_catalog, and composing it in the
      // browser would mean shipping that read surface to every client.
      //
      // AASX is fetched directly rather than through functions.invoke(): supabase-js decodes any
      // response that is not JSON or octet-stream as *text*, and an AASX package is a ZIP -- text
      // decoding silently corrupts it. The JSON path keeps using invoke() for its error handling.
      if (body?.format === 'aasx') {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${SUPABASE_URL}/functions/v1/aas-export?format=aasx`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_GATEWAY_KEY,
            Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ device_id: body.device_id })
        });

        if (!res.ok) {
          // The function reports failures as JSON even on the AASX path, so the real message is
          // recoverable rather than being swallowed as an opaque status.
          let message = `AAS export failed (${res.status})`;
          try { message = (await res.json())?.error || message; } catch { /* non-JSON body */ }
          throw new Error(message);
        }

        // Counts ride in a header because a binary body has nowhere to carry them.
        let stats = {};
        try { stats = JSON.parse(res.headers.get('X-AAS-Stats') || '{}'); } catch { /* absent */ }
        return { blob: await res.blob(), stats, format: 'aasx' };
      }

      const { data, error } = await supabase.functions.invoke('aas-export', { body });
      if (error) {
        throw new Error(await edgeFunctionErrorMessage(error, 'AAS export failed'));
      }
      return data;
    }

    throw new Error('Unhandled API path: ' + path);
  },

  put: async (path, body, options = {}) => {
    /**
     * Edit an open proposal -- the patch and the rationale, which are the only two columns the
     * transition guard lets a proposer move.
     *
     * THIS IS WHAT MAKES THE PER-ASSET CAP LIVABLE. Told "you already have an open proposal on this
     * device", a person has to be able to open that one and add to it; without this the constraint
     * reads as a wall and people route around it by proposing against a neighbouring asset, or stop
     * proposing. The database refuses anything else this could try to write, so the narrow shape
     * here agrees with the guard rather than being trusted in place of it.
     */
    if (/^\/api\/v1\/proposals\/[^/]+$/.test(path)) {
      const proposalId = path.split('/')[4];
      const { data, error } = await supabase
        .from('change_proposals')
        .update({ patch: body.patch, rationale: emptyToNull(body.rationale) })
        .eq('id', proposalId)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    if (path.includes('/archive')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;
      const now = new Date().toISOString();
      const days = body?.auto_delete_days;
      const auto_delete_at = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

      let query = supabase
        .from(table)
        .update({ is_archived: true, archived_at: now, auto_delete_at });
      query = query.eq('id', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/restore')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;

      let query = supabase
        .from(table)
        .update({ is_archived: false, archived_at: null, auto_delete_at: null });
      query = query.eq('id', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.startsWith('/api/v1/links/')) {
      const id = path.split('/')[4];
      const { data, error } = await supabase.from('links').update({
        display_name: body.display_name,
        url: body.url,
        link_tag: body.link_tag || 'other',
        updated_at: new Date().toISOString()
      }).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    const parts = path.split('/');
    const id = parts[parts.length - 1];

    // Editing a DRAFT version's metric set. There is deliberately no status guard here beyond
    // sending only the editable keys: `prevent_active_schema_mutation()` (archived migration 0037) is what
    // refuses this write against an active or archived row, and duplicating that decision
    // client-side would be a second source of truth that could disagree with the first. The UI
    // does not offer the editor for a non-draft; the database is what makes that hold.
    if (path.startsWith('/api/v1/schemas/')) {
      const patch = {};
      if ('schema_definition' in body) patch.schema_definition = body.schema_definition;
      if ('description' in body) patch.description = body.description;
      if ('change_description' in body) patch.change_description = emptyToNull(body.change_description);

      const { data, error } = await supabase.from('schemas').update(patch).eq('id', id).select();
      if (error) throw error;
      // RLS filters a forbidden update to zero rows instead of erroring, so an empty result is a
      // permission failure rather than a success with nothing to report. Saying so beats returning
      // `undefined` and letting the caller render a blank success toast.
      if (!data?.length) {
        throw new Error('Schema not updated — it may have been published, or you may not have permission to edit it.');
      }
      return data[0];
    }

    if (path.startsWith('/api/v1/cells/')) {
      const { data, error } = await supabase.from('cells').update({
        name: body.cell_name,
        grafana_url: body.access_url,
        ...(body.icon ? { icon: body.icon } : {})
      }).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    if (path.startsWith('/api/v1/gateways/')) {
      // Only the keys the caller actually sent are written, so a partial update cannot
      // blank out a field it never mentioned.
      const patch = {
        name: body.gateway_name,
        access_url: body.access_url
      };
      if ('deployment' in body) patch.deployment = body.deployment === 'host' ? 'host' : 'remote';
      // Separate from deployment and not derived from it: an appliance out on the plant network
      // replaying a capture is remote and simulated at once. Folding them would make that gateway
      // unrepresentable -- which is why 0064 added a column beside is_simulated rather than an enum
      // over both.
      if ('is_simulated' in body) patch.is_simulated = !!body.is_simulated;
      // See the devices patch: emptyToNull so clearing the field stores NULL, not ''.
      if ('description' in body) patch.description = emptyToNull(body.description);
      // Same pairing rule as devices: marking a gateway Site-Wide clears its cell rather than
      // letting the CHECK reject the write. `deployment` is NOT what decides this -- it says where
      // the connector runs, site-wide is an operator's assertion about where the assets are, and
      // conflating them would relocate assets on a checkbox.
      Object.assign(patch, locationFieldsFrom(body));

      const { data, error } = await supabase.from('gateways').update(patch).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    /**
     * Upsert a device's nameplate. An empty field clears the column rather than being skipped:
     * blanking a wrong serial number has to be expressible, and a PATCH that ignored empties
     * would make the form unable to undo its own mistakes.
     *
     * The row is DELETED when every field comes back empty, because "no nameplate data" is
     * modelled as no row -- archived migration 0011's exporter rule is that a submodel with nothing in it
     * is omitted, and a row of nulls would leave the device looking edited rather than untouched.
     */
    if (path.match(/\/api\/v1\/devices\/(.+)\/nameplate/)) {
      const deviceId = path.match(/\/api\/v1\/devices\/(.+)\/nameplate/)[1];
      const fields = [
        'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
        'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
        'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
      ];
      const patch = Object.fromEntries(fields.map(f => [f, emptyToNull(body[f])]));

      if (fields.every(f => patch[f] === null)) {
        const { error } = await supabase.from('device_nameplate').delete().eq('device_id', deviceId);
        if (error) throw error;
        return null;
      }

      const { data: session } = await supabase.auth.getSession();
      const { data, error } = await supabase
        .from('device_nameplate')
        .upsert({
          device_id: deviceId,
          ...patch,
          updated_at: new Date().toISOString(),
          updated_by: session?.session?.user?.id ?? null
        }, { onConflict: 'device_id' })
        .select();
      if (error) throw error;
      return data?.[0] || null;
    }

    if (path.startsWith('/api/v1/devices/')) {
      // Renaming is safe: `name` is a display label, and telemetry, birth parameters and the
      // MQTT topic are all keyed by the immutable sparkplug_id, so nothing needs re-keying.
      //
      // gateway_id is written from whichever key the caller supplied. The UI models a
      // device's gateway as `active_gateway_id`; reading only `gateway_id` here meant
      // every reassignment silently updated nothing.
      const patch = {
        name: body.asset_name,
        status: body.status,
        is_quarantined: body.is_quarantined
      };
      if ('asset_type' in body) patch.asset_type = emptyToNull(body.asset_type);
      // emptyToNull, so clearing the field in the form stores NULL rather than ''. Absent and empty
      // are the same thing to every reader of a description, and two representations of one state is
      // how a `WHERE description IS NULL` starts missing rows.
      if ('description' in body) patch.description = emptyToNull(body.description);
      if ('connection_method' in body) patch.connection_method = emptyToNull(body.connection_method);
      if ('schema_id' in body) patch.schema_id = emptyToNull(body.schema_id);
      // Not emptyToNull: the column is NOT NULL with a default of 'audit' (0050), so writing NULL
      // would be rejected by the database rather than read as "leave it alone". An absent key is
      // how the caller says that, and the CHECK constraint refuses anything outside the two
      // values -- a typo here fails loudly instead of silently reading as 'not enforce'.
      if ('conformance_policy' in body) patch.conformance_policy = body.conformance_policy;
      if ('active_gateway_id' in body || 'gateway_id' in body) {
        patch.gateway_id = gatewayIdFrom(body);
      }
      // Reassigning a gateway deliberately does NOT touch cell_id. An explicit location is the
      // operator's answer about where the machine is; moving which connector reaches it is a
      // data-path change and must not silently relocate the asset.
      Object.assign(patch, locationFieldsFrom(body));
      const { data, error } = await supabase.from('devices').update(patch).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    throw new Error('Unhandled API path: ' + path);
  },

  /*
   * Change one setting's value.
   *
   * PATCH SEMANTICS THROUGH supabase-js `.update()`, not PUT: PostgREST's PUT requires the whole
   * row and a primary-key match, and this caller may only write ONE column -- `value` is the only
   * one `authenticated` holds a grant on (0031). Sending anything else is a 42501, which is the
   * database refusing rather than this adapter being clever.
   *
   * `.select()` IS NOT OPTIONAL HERE. RLS makes a non-Administrator's update affect zero rows
   * WITHOUT ERRORING -- the row is simply invisible to the UPDATE policy -- so a caller that only
   * checked `error` would report success on a write that did nothing. Returning the row lets the
   * page tell "saved" from "silently not saved".
   */
  /*
   * Apply a whole rearrangement at once.
   *
   * AN RPC, NOT N CALLS TO api.put, and the difference is the audit trail rather than the request
   * count. Device writes go through PostgREST per row, so firing six updates from here -- however
   * carefully sequenced -- is six transactions and therefore six `causation_id`s: six unrelated
   * rows in the Digital Thread describing one decision an operator made once. `relocate_devices`
   * (0033) does the whole batch in one transaction, so the trigger stamps one causation across
   * all of them and the drawer's "Same transaction" control has something true to show.
   *
   * It also means there is no half-applied batch. Six sequential PUTs can fail on the fourth and
   * leave three machines moved with no record the other three were ever meant to be -- which is
   * worse than the immediate per-drop writes this replaced, not better.
   *
   * `location_scope` is sent on EVERY move, never omitted. The RPC refuses a move without one
   * rather than defaulting to 'cell', because defaulting would let an omission here silently
   * clear `site_wide` off an asset an operator deliberately asserted has no single cell.
   */
  relocateDevices: async (moves) => {
    const payload = (moves || []).map(m => ({
      device_id: m.device_id,
      cell_id: m.cell_id || null,
      location_scope: m.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : 'cell'
    }));
    if (payload.length === 0) throw new Error('No moves to apply.');
    const { data, error } = await supabase.rpc('relocate_devices', { p_moves: payload });
    if (error) throw error;
    return {
      causation_id: data?.causation_id ?? null,
      requested: data?.requested ?? payload.length,
      applied: data?.applied ?? 0,
      unchanged: data?.unchanged ?? 0,
      devices: data?.devices ?? []
    };
  },

  patchSetting: async (key, value) => {
    const { data, error } = await supabase
      .from('system_settings')
      .update({ value })
      .eq('key', key)
      .select('key,value,updated_at,updated_by');
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error(
        'That setting was not updated. Changing settings requires the Administrator role.'
      );
    }
    return data[0];
  },

  /**
   * Which kind of thing a UUID names, and what it is called.
   *
   * THE SEARCH BAR'S THIRD ANSWER. Pages and cards are matched against a static index; an asset id
   * cannot be, because the ids are the operator's data and there are thousands of them. Pasting a
   * UUID is how somebody arrives from a Grafana alert, a Sparkplug topic, a log line or a colleague's
   * message -- with an identifier and no idea which of four pages it belongs on.
   *
   * FOUR TABLES BECAUSE FOUR PAGES CAN FOCUS ONE ROW. Every table in this schema has a uuid primary
   * key, but only `cells`, `gateways`, `devices` and `schemas` have a page that can be opened TO one
   * -- so resolving, say, a `digital_thread` event id would produce a result with nowhere to send it.
   *
   * ALL FOUR ARE ASKED AT ONCE, AND A LIST COMES BACK. A sequential probe returning on the first
   * hit would read as a deliberate precedence and is not one -- so on the vanishingly unlikely day
   * two tables answer, the caller is handed both rows and shows both, rather than being told a
   * confident wrong answer by whichever table happened to be asked first.
   *
   * A MISS AND A REFUSAL BOTH COME BACK EMPTY, DELIBERATELY. RLS returns no rows rather than an
   * error, so "no such device" and "not a device you may see" are indistinguishable from here and
   * the palette must not claim to know which. Guessing would tell an Operator that an id they are
   * not cleared for does not exist -- which is a disclosure in the other direction, and wrong.
   */
  resolveId: async (uuid) => {
    if (!isUuid(uuid)) return [];

    // `maybeSingle` rather than `single`: a primary-key lookup that matches nothing is the EXPECTED
    // case here (three of the four always miss), and `single` reports that as an error.
    // The name column is named per table -- `schemas` calls it `schema_name` -- so it is a parameter
    // rather than assumed. A select of `*` would avoid the question and hand the palette a device's
    // whole nameplate to render a single line with.
    const probe = (table, kind, nameColumn) =>
      supabase.from(table).select(`id, ${nameColumn}`).eq('id', uuid).maybeSingle()
        .then(({ data, error }) => (error || !data ? null : { kind, id: data.id, name: data[nameColumn] }));

    return (await Promise.all([
      probe('devices', 'device', 'name'),
      probe('gateways', 'gateway', 'name'),
      probe('cells', 'cell', 'name'),
      probe('schemas', 'schema', 'schema_name')
    ])).filter(Boolean);
  },

  /**
   * The four asset kinds, matched by NAME.
   *
   * THE COMPANION TO `resolveId`, and deliberately a separate call rather than a mode of it. An id
   * lookup is an equality probe on a primary key that hits at most one row in one of four tables; a
   * name search is a pattern over four tables that can hit many. They fail differently too -- a
   * missing id means "nothing has that id", a missing name means "nothing is called that yet" --
   * and collapsing them would make one message do for both.
   *
   * `ilike` WITH THE TERM ESCAPED. `%` and `_` are wildcards in LIKE, so a device called `100%_OK`
   * typed verbatim would otherwise match far more than itself -- and, worse, a bare `%` would match
   * the entire estate and read as the search being broken.
   *
   * CAPPED PER KIND, NOT OVERALL. A plant with four hundred devices and three cells would otherwise
   * return four hundred devices and no cells at all, which is the shape that makes people conclude
   * the search cannot find cells. Ten of each is enough to recognise the one you meant, and the
   * page-level box is where an exhaustive list belongs.
   *
   * RLS DECIDES WHAT COMES BACK, as everywhere else. Nothing here filters by role.
   */
  searchAssets: async (term) => {
    const needle = String(term || '').trim();
    if (needle.length < 2) return [];

    const escaped = needle.replace(/([%_\\])/g, '\\$1');
    const probe = (table, kind, nameColumn) =>
      supabase
        .from(table)
        .select(`id, ${nameColumn}`)
        .ilike(nameColumn, `%${escaped}%`)
        .limit(10)
        .then(({ data, error }) => (error ? [] : (data || []).map(r => ({
          kind, id: r.id, name: r[nameColumn]
        }))));

    const found = await Promise.all([
      probe('devices', 'device', 'name'),
      probe('gateways', 'gateway', 'name'),
      probe('cells', 'cell', 'name'),
      probe('schemas', 'schema', 'schema_name')
    ]);

    // AN EXACT MATCH FIRST, then alphabetical. Somebody who typed a full name wants that row, and
    // it would otherwise sit wherever its table happened to fall among the four.
    const lowered = needle.toLowerCase();
    return found.flat().sort((a, b) => {
      const aExact = String(a.name || '').toLowerCase() === lowered;
      const bExact = String(b.name || '').toLowerCase() === lowered;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  },

  delete: async (path, options = {}) => {
    if (path.startsWith('/api/v1/links/')) {
      const id = path.split('/')[4];
      const { error } = await supabase.from('links').delete().eq('id', id);
      if (error) throw error;
      return true;
    }

    const parts = path.split('/');
    const id = parts[parts.length - 1];

    if (path.startsWith('/api/v1/cells/')) {
      const { error } = await supabase.from('cells').delete().eq('id', id);
      if (error) throw error;
      return true;
    }

    if (path.startsWith('/api/v1/gateways/')) {
      const { error } = await supabase.from('gateways').delete().eq('id', id);
      if (error) throw error;
      return true;
    }

    if (path.startsWith('/api/v1/devices/')) {
      const { error } = await supabase.from('devices').delete().eq('id', id);
      if (error) throw error;
      return true;
    }

    throw new Error('Unhandled API path: ' + path);
  }
};

export const api = withActivityTracking(apiMethods);
