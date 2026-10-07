import { supabase, SUPABASE_URL, SUPABASE_GATEWAY_KEY } from './lib/supabaseClient';
import { withActivityTracking } from './lib/apiActivity';
import { isUuid } from './utils/isUuid';
import { deviceSparkplugId } from './utils/sparkplugId';
import { resolveDeviceLocation, normaliseScope, SCOPE_CELL, SCOPE_AREA_WIDE } from './utils/cellResolution';
import { isSvgFile, readSvgPlan, decodeSvgBytes, areaPlanPath, AREA_PLAN_MAX_BYTES } from './utils/areaPlans';
import { edgeFunctionErrorMessage, withReference } from './utils/edgeFunctionError';
import { AUDIT_TRAIL_ACTIONS, ENTITY_TABLE_BY_KIND } from './constants';
import { metricNameError } from './utils/metricGroup';
import { readSetting } from './config';
import { BACKUP_OFFSITE_SETTING_KEYS } from './utils/backupOffsite';
import {
  MODEL_3D_EXTENSIONS,
  isAcceptedModelFile,
  modelContentType,
  modelStoragePath
} from './utils/model3d';

// A device has two relationships to a cell: `devices.gateway_id -> gateways.cell_id` is the data
// path, and `devices.cell_id` is an explicit location override (NULL means inherit). The effective
// cell is resolved by public.device_locations and merged onto each row as `effective_cell_id` /
// `location_source` / `cell_mismatch`; `cell_id` stays the raw column. Read `effective_cell_id`
// to display, `cell_id` to edit. No embed can express "unless the child overrides".
// `asset_id` is always the device UUID, including for quarantined devices.
/**
 * The IDTA Digital Nameplate template the editor and the AAS exporter both work against.
 * Mirrors NAMEPLATE_TEMPLATE_ID in supabase/functions/aas-export/index.ts; the version is part
 * of the identifier, so the two must move together.
 */
const NAMEPLATE_TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate';

/**
 * Which nameplate fields a device can answer for itself, and the OPC UA concept that answers them.
 * Mirrors the exporter's resolution order (a published value wins over a stored one). Keyed by
 * `device_nameplate` column.
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
    cell_mismatch: loc.cell_mismatch,
    explicit_area_id: loc.explicit_area_id,
    effective_area_id: loc.effective_area_id
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
  'is_archived, gateway_id, cell_id, area_id, location_scope, created_at, model_3d_path, shadow_of';
const GATEWAY_EMBED =
  `id, name, description, sparkplug_id, cell_id, area_id, location_scope, access_url, status, last_heartbeat, ` +
  // `enrolled_at`, `forge_repository_at` and `forge_archived_at` decide what
  // GatewayRepositoryPanel renders: whether the gateway has enrolled, whether enrolment got as far
  // as creating its repository, and whether the sweep has since put that repository into the
  // forge's archive. The gateways query selects `*` and carries them either way; an embed names
  // its columns, so a gateway read through one would otherwise arrive with all three undefined and
  // read as never enrolled.
  `enrolled_at, forge_repository_at, forge_archived_at, ` +
  `deployment, is_simulated, is_shadow, is_archived, archived_at, created_at, devices(${DEVICE_EMBED})`;

/**
 * Effective cell per device, keyed by device id, read from public.device_locations.
 * Non-fatal: on failure the callers fall back to resolveDeviceLocation(), the same expression
 * evaluated locally.
 */
async function loadDeviceLocations() {
  const { data, error } = await supabase.from('device_locations').select('*');
  if (error) return null;
  return new Map((data || []).map(row => [row.device_id, row]));
}

// PostgREST rejects '' for a UUID/foreign-key column; the UI's "unassigned" option
// submits exactly that.
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

/**
 * `semantic_id` and `semantic_id_type` as every write stores them: the id trimmed, and the type NULL
 * whenever the id is, so the pair is never half-populated. A type with no id would export as an AAS
 * Reference with no key.
 */
const semanticIdPair = (body) => {
  const semanticId = emptyToNull(String(body?.semantic_id ?? '').trim());
  return {
    semantic_id: semanticId,
    semantic_id_type: semanticId ? emptyToNull(body?.semantic_id_type) : null
  };
};

// The UI carries a device's gateway as `active_gateway_id`; the column is `gateway_id`.
const gatewayIdFrom = (body) => emptyToNull(body.active_gateway_id ?? body.gateway_id);

/**
 * The location columns a request is actually trying to set; `{}` when it mentions none, so a
 * partial update cannot blank a field it never sent. The scope decides the other two, as the CHECK
 * constraints do: a wide scope clears the cell, and only area-wide keeps an area.
 */
function locationFieldsFrom(body) {
  const fields = {};
  if ('cell_id' in body) fields.cell_id = emptyToNull(body.cell_id);
  if ('area_id' in body) fields.area_id = emptyToNull(body.area_id);
  if ('location_scope' in body) {
    fields.location_scope = normaliseScope(body.location_scope);
    if (fields.location_scope !== SCOPE_CELL) fields.cell_id = null;
    if (fields.location_scope !== SCOPE_AREA_WIDE) fields.area_id = null;
  }
  return fields;
}

// A place on an area plan is a fraction 0..1 or nothing; the form submits '' or null for nothing.
const planCoordFrom = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

export const TELEMETRY_PAGE_SIZE = 500;
// postgres_fdw ships a LIMIT to TimescaleDB only below about 6,300 rows; past that every matching
// row crosses the wrapper before it is trimmed. Stay under it.
const TELEMETRY_MAX_ROWS = 5000;

/**
 * Ceiling on a single CSV export, across all selected metrics. Higher than TELEMETRY_MAX_ROWS
 * because an export is a deliberate act with a progress bar, but still bounded. On reaching it the
 * export downloads the most recent rows and says it was truncated.
 */
export const TELEMETRY_EXPORT_MAX_ROWS = 50000;

/**
 * Rollup resolutions a caller may ask for, and the relation each maps to.
 *
 * Continuous aggregates in TimescaleDB (timescaledb/aggregates.sql), exposed over the FDW. A
 * trend over a month is made cheap by there being fewer rows, not by asking for fewer.
 *
 * The CSV export defaults to raw and may ask for these. A bucket average is not a reading any
 * instrument produced, so a rollup is never substituted for raw silently; past the raw retention
 * window it is the only thing that still answers.
 */
const TELEMETRY_RESOLUTIONS = {
  '1m': { relation: 'telemetry_1m', bucketMinutes: 1 },
  '5m': { relation: 'telemetry_5m', bucketMinutes: 5 },
  '1h': { relation: 'telemetry_1h', bucketMinutes: 60 }
};

/**
 * The relation each resolution reads, keyed as `telemetry_horizons` names them. Exported for the
 * test that checks the export dialog's resolution list against it; the app does not read it.
 */
export const TELEMETRY_RESOLUTION_RELATIONS = Object.freeze({
  raw: 'telemetry',
  ...Object.fromEntries(Object.entries(TELEMETRY_RESOLUTIONS).map(([k, v]) => [k, v.relation]))
});

/**
 * The lower time bound applied when a caller supplies none.
 *
 * `public.telemetry` is a postgres_fdw projection and a LIMIT ships only below about 6,300 rows, so
 * a query with no time predicate can drag an asset's entire history across the wrapper before
 * `.range()` applies. Every live caller already passes a window; this exists so the next caller
 * cannot reintroduce the unbounded scan by omitting an argument.
 */
export const TELEMETRY_DEFAULT_WINDOW_MINUTES = 60;

/**
 * Resolve the `time >= ...` bound for one telemetry query. Exported for the test that pins the
 * "never unbounded" property; call sites go through queryTelemetry.
 *
 * An explicit `from` is honoured verbatim. When only `to` is given the window is measured back
 * from `to`, not from now.
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
 * `sparkplug_id`; the UI works in device UUIDs. A pure local derivation. A non-UUID value passes
 * through unchanged, so the query comes back empty rather than widening to every device.
 */
function toTelemetryKey(assetId) {
  if (!assetId) return '';
  return isUuid(assetId) ? deviceSparkplugId(assetId) : assetId;
}

/**
 * Query the `telemetry` view, a postgres_fdw projection of the TimescaleDB hypertable exposed
 * through PostgREST.
 *
 * @param minutes  Relative window, "the last N minutes"; the primary form.
 * @param from,to  Absolute ISO bounds, for the export dialog. An explicit bound wins over
 *                 `minutes`.
 *
 * Every query leaves here with a lower time bound; see TELEMETRY_DEFAULT_WINDOW_MINUTES.
 */
async function queryTelemetry({ assetId, metricName, minutes, from: fromTime, to: toTime, limit, offset, resolution } = {}) {
  const pageSize = Math.min(
    Number.isFinite(limit) && limit > 0 ? limit : TELEMETRY_PAGE_SIZE,
    TELEMETRY_MAX_ROWS
  );
  const from = Number.isFinite(offset) && offset > 0 ? offset : 0;

  // `resolution` selects a rollup instead of the raw hypertable; the row shape differs (bucket,
  // avg/min/max/last), documented as TelemetryBucket in docs/openapi.yaml. An unknown resolution
  // is refused, not ignored: falling back to raw would scan what the rollup exists to avoid.
  const rollup = TELEMETRY_RESOLUTIONS[resolution];
  if (resolution && !rollup) {
    throw new Error(
      `unknown telemetry resolution '${resolution}'; expected one of ${Object.keys(TELEMETRY_RESOLUTIONS).join(', ')} (or omit it for raw)`
    );
  }
  const relation = rollup ? rollup.relation : 'telemetry';
  const timeColumn = rollup ? 'bucket' : 'time';

  const telemetryKey = toTelemetryKey(assetId);

  let query = supabase.from(relation).select('*');
  if (telemetryKey) query = query.eq('asset_id', telemetryKey);
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
 * The collapse happens in the database: the view's `DISTINCT ON` runs on the TimescaleDB side
 * against the (asset_id, metric_name, time DESC) index and only the answer crosses the FDW, so
 * the cost is bounded by how many series exist. `minutes` is honoured as a staleness bound, so a
 * machine that last reported in March does not reappear with a March reading as current state.
 */
async function queryLatestTelemetry({ assetId, minutes } = {}) {
  const telemetryKey = toTelemetryKey(assetId);

  let query = supabase.from('telemetry_latest').select('*');
  if (telemetryKey) query = query.eq('asset_id', telemetryKey);

  const window = Number.isFinite(minutes) && minutes > 0 ? minutes : TELEMETRY_DEFAULT_WINDOW_MINUTES;
  query = query.gte('time', new Date(Date.now() - window * 60000).toISOString());

  const { data, error } = await query.limit(TELEMETRY_MAX_ROWS);
  if (error) throw error;
  return data || [];
}

/**
 * The oldest timestamp each telemetry resolution holds, as `{ telemetry: Date|null, ... }`.
 *
 * WHAT IS HELD, NOT WHAT THE POLICY PROMISES. `public.telemetry_horizons` reads min() from each
 * relation on the TimescaleDB side; a stack installed three weeks ago reports three weeks of raw
 * however `timescaledb.retention.retainFor` is set. A null means that relation is empty, which the
 * caller must not read as "does not reach that far": an empty stack covers nothing at any
 * resolution, and offering to switch would return nothing either.
 *
 * NEVER THROWS. This decorates the export dialog; a stack whose historian is unreachable must
 * still be able to attempt an export and get the real error from the export itself, rather than a
 * dialog that refuses to open.
 */
async function queryTelemetryHorizons() {
  try {
    const { data, error } = await supabase.from('telemetry_horizons').select('*');
    if (error) throw error;
    const out = {};
    for (const row of data || []) {
      const at = row?.oldest ? new Date(row.oldest) : null;
      out[row.relation] = at && !Number.isNaN(at.getTime()) ? at : null;
    }
    return out;
  } catch {
    return {};
  }
}

const mapAuditTrailRow = (t) => ({
  ...t,
  event_id: t.id || t.event_id,
  timestamp: t.recorded_at || t.timestamp,
  event_type: t.action || t.event_type,
  description: t.description || `Action ${t.action} on ${t.entity_type} [${t.entity_id}]`,
  metadata: t.metadata || { old_data: t.old_data, new_data: t.new_data, changed_by: t.changed_by }
});

/**
 * The 3D-model bucket. Public-read by design: an exported AAS `File` element must be
 * dereferenceable by a viewer with no session. Writes are gated by RLS
 * (supabase/storage-policies.sql). Resolved from the environment, as storage-init.mjs and the
 * policies resolve it; the default is the same name.
 */
const MODEL_3D_BUCKET = readSetting('VITE_MODEL_3D_BUCKET', 'asset-3d-models');

/**
 * Broker captures: recorded Sparkplug traffic, for playback through `ingestion/capture.py`.
 *
 * Private: a capture is a recording of every device id, metric name and value that spoke in the
 * window. Objects live under `<sparkplug_id>/` of the subject that was recorded; the prefix is
 * enforced by RLS (supabase/storage-policies.sql), and the paths here follow the rule.
 */
const CAPTURE_BUCKET = readSetting('VITE_CAPTURE_BUCKET', 'broker-captures');

/**
 * Area plans. Private, and the name is fixed: scripts/storage-init.mjs and
 * supabase/storage-policies.sql name it too. Objects live under `<area_id>/`, which the write
 * policy confines to an area that exists.
 */
const AREA_PLAN_BUCKET = 'area-plans';

/**
 * Object URLs for downloaded plans, by path. A plan is fetched once per session through the
 * authenticated client and handed to an <img> as a blob URL, so no signed URL expires under a
 * wall display and the SVG never becomes part of the page.
 */
const areaPlanUrls = new Map();

/** The blob URL for a stored plan, downloading it on first use. Null with no path. */
export async function loadAreaPlanUrl(path) {
  if (!path) return null;
  if (areaPlanUrls.has(path)) return areaPlanUrls.get(path);
  const { data, error } = await supabase.storage.from(AREA_PLAN_BUCKET).download(path);
  if (error) throw new Error(error.message || 'Could not load the area plan');
  const blob = data.type === 'image/svg+xml' ? data : new Blob([data], { type: 'image/svg+xml' });
  const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
  areaPlanUrls.set(path, url);
  return url;
}

/**
 * The capture-file version this stack reads. Mirrors `CAPTURE_VERSION` in ingestion/capture.py,
 * which is the authority; checked at upload so a file the tool would refuse is refused here.
 */
export const CAPTURE_VERSION = 1;

/**
 * The filename a server offered in Content-Disposition, or null.
 *
 * Read from the header rather than composed here, so the download is named the same as the
 * folder inside it. Only the plain `filename="..."` form is parsed; a null falls back to a name
 * of the caller's own.
 */
function filenameFromDisposition(header) {
  const match = /filename="([^"]+)"/i.exec(header || '');
  return match ? match[1] : null;
}

/**
 * `<sparkplug_id>/capture.json`: one path per subject, derived rather than composed.
 *
 * The schema stores exactly one capture per subject, so a re-record overwrites this key and no
 * orphan is left, and the path satisfies the bucket's prefix policy by construction. A label
 * goes in `captures.note`, where a slash is just a character. `sparkplugId` is the subject's
 * (`gwy…` or `dev…`), not the gateway a capture plays back as.
 */
export function capturePath(sparkplugId) {
  return `${sparkplugId}/capture.json`;
}

/**
 * The manifest for a capture uploaded through the browser.
 *
 * The other half of a contract `capture_worker._manifest()` writes; the fields are named in
 * `captures.manifest`'s COMMENT, which is the authority. `birth_captured` is computed from the
 * messages, not trusted: false means the capture replays as `unresolved_alias` on an
 * alias-optimised gateway. Names are capped by `capped_capture_manifest()` in the database, not
 * here.
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

/**
 * A signed storage URL that a new tab can actually open.
 *
 * The browser requests a signed URL with no headers, and the gateway rejects any request with no
 * `apikey` before storage-api sees the token (401 "No API key found in request"). Putting the
 * anon key in the URL is not a leak: it is in the bundle every visitor downloads, and what
 * authorises the request is the signed token, scoped to one object for sixty seconds.
 */
function withApiKey(signedUrl) {
  if (!signedUrl) return signedUrl;
  return signedUrl + (signedUrl.includes('?') ? '&' : '?') + `apikey=${SUPABASE_GATEWAY_KEY}`;
}

/** The public URL for a stored model path. Composed, never stored -- see archived migration 20260101000035_asset_3d_models.sql. */
export function model3dPublicUrl(path) {
  if (!path) return null;
  return supabase.storage.from(MODEL_3D_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * The same object, asked for as a download rather than a navigation.
 *
 * The bucket is served from the storage origin and the dashboard from its own, so `<a download>`
 * is cross-origin and browsers ignore the attribute. `?download=` makes storage send
 * `Content-Disposition: attachment`, and the filename names the saved file after the model.
 */
export function model3dDownloadUrl(path) {
  if (!path) return null;
  const name = path.split('/').pop() || 'model';
  return supabase.storage.from(MODEL_3D_BUCKET).getPublicUrl(path, { download: name }).data
    .publicUrl;
}

/**
 * The API surface itself. Exported below as `api`, wrapped so that every call through it is
 * counted by lib/apiActivity. Nothing should import `apiMethods` directly.
 */
const apiMethods = {
  /**
   * Upload a 3D model for a device and record its path on the row.
   *
   * The object goes up first, then `model_3d_path` is set: a row pointing at a missing object
   * would export a dead `File` URL. If the second write fails the upload is rolled back.
   * `upsert: true` so replacing a model overwrites rather than no-ops on the same filename.
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
   * The row is cleared before the object is deleted, the reverse of upload: the worst case is an
   * orphaned object rather than an export publishing a broken link. A failed delete is not fatal.
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
  // Remote gateway enrolment
  // ===============================================================================================

  /**
   * Download the bootstrap bundle for a Remote gateway.
   *
   * A raw fetch(), not supabase.functions.invoke(): invoke() decodes any response that is neither
   * JSON nor octet-stream as text, which silently corrupts a ZIP. Returns the blob plus the
   * metadata that rides in headers.
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
      // The status and the details ride on the error: a 503 names the variable to set, and the
      // modal shows that instead of a retry that cannot succeed.
      let message = `Bundle generation failed (${res.status})`;
      let details = null;
      let body = null;
      try {
        body = await res.json();
        message = body?.error || message;
        details = body?.details || null;
      } catch { /* non-JSON body */ }
      const error = new Error(withReference(message, body));
      error.status = res.status;
      error.details = details;
      throw error;
    }

    return {
      blob: await res.blob(),
      filename: filenameFromDisposition(res.headers.get('Content-Disposition')),
      expiresAt: res.headers.get('X-Aber-Token-Expires-At'),
      bundleVersion: res.headers.get('X-Aber-Bundle-Version'),
      sparkplugId: res.headers.get('X-Aber-Sparkplug-Id')
    };
  },

  /**
   * The one-liner: mints the enrolment token the way downloadGatewayBundle does and answers
   * JSON naming the command to paste, its expiry, the pin and the installer's address. A 503
   * names why this deployment cannot serve it (plain HTTP, no root mounted), and the caller
   * falls back to the bundle.
   */
  installCommand: async (gatewayId, { ttlMinutes } = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gateway-bundle`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ gateway_id: gatewayId, format: 'command', ...(ttlMinutes ? { ttl_minutes: ttlMinutes } : {}) })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(withReference(body?.error || `The install command could not be minted (${res.status})`, body));
      error.status = res.status;
      error.details = body?.details || null;
      throw error;
    }
    return {
      command: body.command,
      expiresAt: body.expires_at,
      sparkplugId: body.sparkplug_id,
      bundleVersion: body.bundle_version,
      caPin: body.ca_pin || null,
      caUrl: body.ca_url || null,
      installUrl: body.install_url
    };
  },

  /**
   * Whether this deployment can enrol an appliance: `{ ready, addresses }`, where each address is
   * `{ variable, value, problem }`. gateway-bundle's GET; it mints nothing and any signed-in user
   * may ask. The Gateways page asks before offering a remote gateway, so the answer arrives
   * before a row exists rather than as a refusal after.
   */
  enrolmentReadiness: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gateway-bundle`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`
      }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(withReference(`Could not read enrolment readiness (${res.status})`, body));
    }
    return res.json();
  },

  /**
   * The machine identities that can reach this stack.
   *
   * Through `list_machine_principals()`, because `auth.users` is not served by PostgREST and
   * `public.user_roles` is not published to clients. Its second column is the permissions a
   * machine holds in its own right. Administrator only at the database, so a Shopfloor_Manager
   * gets a raise rather than an empty list, which the caller surfaces.
   */
  listServicePrincipals: async () => {
    const { data, error } = await supabase.rpc('list_machine_principals');
    if (error) throw new Error(error.message || 'Could not list machine principals');
    // The name and purpose an Administrator gave each one (0125), merged onto the RPC row. A
    // separate read rather than a wider RPC: a changed return type cannot ship under the same
    // function name on a chain that replays. Tolerated to nothing, so a principal whose name
    // cannot be read is still listed, as "Undocumented principal".
    const names = await api.listMachinePrincipalNames().catch(() => new Map());
    return (data || []).map(p => ({ ...p, ...(names.get(p.principal_id) || {}) }));
  },

  /**
   * Principal id -> `{ name, purpose, created_by, created_at }` from `machine_principals` (0125).
   *
   * Administrator and Auditor at the database, matching `list_user_accounts()`: a name here labels
   * audit-trail rows both roles may read. Empty for anybody else.
   */
  listMachinePrincipalNames: async () => {
    const { data, error } = await supabase
      .from('machine_principals')
      .select('principal_id, name, purpose, created_by, created_at');
    if (error) throw new Error(error.message || 'Could not read machine principal names');
    return new Map((data || []).map(r => [r.principal_id, r]));
  },

  /**
   * The people who can reach this stack, as `{ user_id, email }`.
   *
   * Through `list_user_accounts()` (0116) for the reason `listServicePrincipals()` goes through an
   * RPC: `auth.users` is not served by PostgREST. Administrator and Auditor only, matching the
   * policy on the audit_trail rows these names label -- so a caller who may not ask is REFUSED
   * rather than given an empty list, and the caller must treat a rejection as "not allowed to
   * know" rather than as "nobody is registered".
   */
  listUserAccounts: async () => {
    const { data, error } = await supabase.rpc('list_user_accounts');
    if (error) throw new Error(error.message || 'Could not list user accounts');
    return data || [];
  },

  /**
   * Every person, for the People tab: `{ user_id, email, role, status, sign_in_blocked,
   * role_on_restore, invited_at, last_sign_in_at, created_at }` from `list_people()` (0166).
   * Administrator only; anybody else is refused.
   */
  listPeople: async () => {
    const { data, error } = await supabase.rpc('list_people');
    if (error) throw new Error(error.message || 'Could not list people');
    return data || [];
  },

  /**
   * Give a person one of the four roles. The database refuses your own role, a person whose access
   * is removed, and the last Administrator who can sign in, and its sentence is the error.
   */
  setPersonRole: async (userId, role) => {
    const { data, error } = await supabase.rpc('set_person_role', { p_user_id: userId, p_role: role });
    if (error) throw new Error(error.message || 'Could not change the role');
    return data;
  },

  /**
   * Add a person, remove their access or restore it, through manage-people: GoTrue's admin API
   * needs the secret key. `add` returns `password` only when the site has no mail relay; it is
   * shown once and kept nowhere. `details` is preferred over `error`, as for the other functions.
   */
  managePeople: async (body) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-people`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        // The CALLER's token: the function checks the role from it, and every database act it
        // makes runs and is recorded as the caller.
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    let result = null;
    try { result = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      throw new Error(withReference(result?.details || result?.error || `The request failed (${res.status})`, result));
    }
    return result;
  },

  addPerson: (email, role) => api.managePeople({ action: 'add', email, role }),
  removePersonAccess: (userId) => api.managePeople({ action: 'remove', user_id: userId }),
  restorePersonAccess: (userId) => api.managePeople({ action: 'restore', user_id: userId }),

  /**
   * The cold telemetry catalogue: every chunk that has been claimed for archival.
   *
   * Read from the historian over the FDW through a SECURITY DEFINER function. `cold_storage_rows()`
   * gates on role in its body, so an Operator gets zero rows rather than an error; the page says
   * which from the session's role rather than guessing.
   */
  listColdStorage: async () => {
    const { data, error } = await supabase.rpc('cold_storage_rows');
    if (error) throw new Error(error.message || 'Could not read the cold storage catalogue');
    return data || [];
  },

  /**
   * How far the cold archive has fallen behind (`0133`): when the unexported span begins, and how
   * far past `archive.tier_after_days` that has run.
   *
   * ONE ROW, ALWAYS, so a null return means the call failed rather than that nothing is behind.
   * The catalogue above cannot answer this: it lists what HAS been exported, and a stalled
   * archiver's symptom is the absence of rows nobody notices.
   */
  coldArchiveBacklog: async () => {
    const { data, error } = await supabase.rpc('cold_archive_backlog');
    if (error) throw new Error(error.message || 'Could not read the cold archive backlog');
    return Array.isArray(data) ? (data[0] || null) : (data || null);
  },

  /**
   * How long raw telemetry is kept, and whether the archiver last reported archiving on (0138).
   * Null when the historian could not be read, which is not the same as "kept indefinitely".
   */
  rawTelemetryWindow: async () => {
    const { data, error } = await supabase.rpc('raw_telemetry_window');
    if (error) throw new Error(error.message || 'Could not read the raw telemetry window');
    return Array.isArray(data) ? (data[0] || null) : (data || null);
  },

  /**
   * Whether an S3 credential is in the vault (`0134`). Never what it is — nothing reads it back to
   * a browser, so this is the only question a page can ask about it.
   *
   * False for a caller who is not an Administrator, which reads as "not configured" and is correct
   * for somebody who cannot configure it.
   */
  archiveCredentialIsSet: async () => {
    const { data, error } = await supabase.rpc('archive_credential_is_set');
    if (error) throw new Error(error.message || 'Could not check the cold archive credential');
    return data === true;
  },

  /**
   * Put the S3 secret key in the vault. Administrator only, enforced in the function rather than
   * here: a check in the browser is a suggestion.
   *
   * WRITE-ONLY. There is no counterpart that reads it back, which is why the page shows "set" or
   * "not set" and never a masked value it would have to have fetched to mask.
   */
  setArchiveCredential: async (secret) => {
    const { error } = await supabase.rpc('set_archive_credential', { p_secret: secret });
    if (error) {
      // PostgREST maps the function's insufficient_privilege to 403; anything else is a fault.
      throw new Error(error.code === '42501'
        ? 'Only an Administrator can set the archive credential'
        : (error.message || 'Could not set the archive credential'));
    }
    return true;
  },

  /**
   * Every TOKEN_MINTED row, grouped by the principal it was signed for.
   *
   * All of them, not the latest per principal: a re-mint does not invalidate the previous token,
   * so two mints are two live credentials. tokenStatus() counts the unexpired ones. Only
   * TOKEN_MINTED rows and only the columns the status derivation reads, since `audit_trail`
   * cannot be pruned.
   */
  listServiceTokens: async () => {
    const { data, error } = await supabase
      .from('audit_trail')
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
   * One audit row by id, read from `audit_trail` as the reads beside it are, so its policies
   * decide; null when the row is absent or hidden from the caller.
   *
   * An approval's row (PROPOSAL_APPLIED, `change_proposals.applied_trail_id`) carries no
   * `old_data`: the values it replaced are on the UPDATE the target's own trigger wrote in the
   * same transaction. For that row `replaced` is that UPDATE's `old_data`, or null where it
   * cannot be read.
   */
  getAuditTrailRow: async (id) => {
    const { data, error } = await supabase
      .from('audit_trail')
      .select('id,entity_type,entity_id,action,old_data,new_data,recorded_at,causation_id')
      .eq('id', id)
      .limit(1);
    const row = !error && data?.[0];
    if (!row) return null;
    if (row.action !== 'PROPOSAL_APPLIED' || row.causation_id == null) return row;

    const { data: change, error: changeError } = await supabase
      .from('audit_trail')
      .select('old_data')
      .eq('causation_id', row.causation_id)
      .eq('entity_type', row.entity_type)
      .eq('entity_id', row.entity_id)
      .eq('action', 'UPDATE')
      // A nameplate approval can INSERT the row before it UPDATEs it; the UPDATE is the later one.
      .order('id', { ascending: false })
      .limit(1);
    return { ...row, replaced: (!changeError && change?.[0]?.old_data) || null };
  },

  /**
   * The jtis `auth_pre_request()` is currently refusing, as a Set.
   *
   * Separate from listServiceTokens(): that is the permanent history, this reads
   * `revoked_service_tokens`, which is pruned once a token has expired. An empty set means
   * "nothing is currently being refused", which is also what a caller who cannot read the table
   * gets. Failure is swallowed to an empty set so the principal list still renders.
   */
  listRevokedServiceTokens: async () => {
    const { data, error } = await supabase
      .from('revoked_service_tokens')
      .select('jti,revoked_at,revoked_by,expires_at');

    if (error) return new Set();
    return new Set((data || []).map(r => r.jti).filter(Boolean));
  },

  /**
   * The service principals `auth_pre_request()` is refusing by subject, keyed by id.
   *
   * A Map, because the row carries when it was withdrawn and why. Not self-pruning, so an empty
   * map really does mean none revoked. Same swallow-to-empty on a refusal.
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
   * It cascades, and the RPC also denylists each outstanding token individually, which is what
   * makes reinstatement safe.
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
   * Lift the flag. Restores the identity, not its credentials: revoke_service_token() has no
   * inverse, so a new token must be minted.
   */
  reinstateServicePrincipal: async (principalId) => {
    const { data, error } = await supabase.rpc('reinstate_service_principal', {
      p_principal_id: principalId,
    });
    if (error) throw new Error(error.message);
    return data;
  },

  /**
   * Create a machine identity that cannot sign in, with the name the page will list it by.
   *
   * Through `create_machine_principal()` (0125, 0146), which is SECURITY DEFINER and checks
   * has_role() itself. It takes permissions from an allow-list, not a role, so widening `Operator`
   * does not widen the identity. Machines propose, people decide: three reads (`telemetry:read`,
   * `quarantine:view`, `audit_trail:read`) and three writes (`archive:manage`,
   * `proposal:create`, `schema:manage`). Anything else is refused, and the message thrown gives
   * the reason. No token is issued here: the identity reaches nothing until `mintServiceToken()`
   * signs one, which the page offers next.
   *
   * @returns {{ principal_id: string, permissions: string[] }} 0080's shape; the name is the
   *          caller's own argument
   */
  createServicePrincipal: async (name, permissions, purpose) => {
    const { data, error } = await supabase.rpc('create_machine_principal', {
      p_name: name,
      p_permissions: Array.isArray(permissions) ? permissions : [permissions],
      p_purpose: purpose || null,
    });
    if (error) throw new Error(error.message || 'Could not create the machine principal');
    return Array.isArray(data) ? data[0] : data;
  },

  /**
   * Rename a principal created from the page, or change its purpose (0126).
   *
   * Through `describe_machine_principal()`, Administrator only and the one write path to
   * `machine_principals` after creation. Refuses a pinned identity, which has no row. Resolves to
   * the audit row id, or null when nothing changed.
   */
  describeServicePrincipal: async (principalId, name, purpose) => {
    const { data, error } = await supabase.rpc('describe_machine_principal', {
      p_principal_id: principalId,
      p_name: name,
      p_purpose: purpose || null,
    });
    if (error) throw new Error(error.message || 'Could not describe the machine principal');
    return data;
  },

  /**
   * Every gateway with what the platform knows about its broker credential.
   *
   * Two reads, not a join: `gateway_status` carries `enrolled_at` and `credential_revoked_at`
   * for a remote gateway; a host-run one has only the CREDENTIAL_ISSUED row in `audit_trail`,
   * whose `entity_id` carries no foreign key by design. Only CREDENTIAL_ISSUED rows are selected
   * and only the newest per gateway is kept.
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
        .from('audit_trail')
        .select('entity_id,recorded_at,changed_by')
        .eq('action', 'CREDENTIAL_ISSUED')
        .eq('entity_type', 'gateways')
        .order('recorded_at', { ascending: false })
    ]);

    if (gatewaysRes.error) throw new Error(gatewaysRes.error.message || 'Could not read gateways');

    // AN AUDIT READ THAT FAILS IS NOT FATAL. `audit_trail:read` is a separate permission, and a
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
   * What the broker holds, read live: every account with its roles and whether it is disabled,
   * and every role with its rules. Administrator only, through broker-inventory. A refusal or an
   * unreachable broker throws, so the page says the column was not read rather than drawing it
   * empty.
   */
  listBrokerInventory: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/broker-inventory`, {
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
      },
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }

    if (!res.ok) {
      throw new Error(withReference(body?.details || body?.error || `Could not read the broker (${res.status})`, body));
    }

    return body;
  },

  /**
   * Mint a host-run gateway's broker credential and get it back once.
   *
   * A raw fetch so both gateway-credential paths read the same way. The password is returned once
   * and is not recoverable: mosquitto_passwd stores a hash, and minting again replaces the account.
   */
  /**
   * The kept copy of a Host or Simulated gateway's broker credential (0164). Administrator only, and
   * every call is a CREDENTIAL_SHOWN row in the Audit Trail. The error carries the RPC's own sentence
   * ("no copy ... is kept; issue a new one ..."), which is the one an operator can act on.
   */
  showGatewayCredential: async (gatewayId) => {
    const { data, error } = await supabase.rpc('show_gateway_credential', { p_gateway_id: gatewayId });
    if (error) throw new Error(error.message || 'Could not show the credential');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.password) throw new Error('No copy of this credential is kept; issue a new one.');
    return row;
  },

  mintGatewayCredential: async (gatewayId) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gateway-credential`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_GATEWAY_KEY,
        // The CALLER's token. authorize_host_gateway_credential() is SECURITY DEFINER and
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
      // `details` carries the RPC's own message -- "gateway X is a Remote gateway; use an
      // enrolment bundle", "gateway X is archived" -- which is the sentence an operator can act on.
      // `error` alone would flatten all of them to "Cannot mint a credential".
      throw new Error(withReference(body?.details || body?.error || `Could not mint a credential (${res.status})`, body));
    }

    return body;
  },

  /**
   * Sign a long-lived token for a service principal and get it back once.
   *
   * Same shape as mintGatewayCredential: a raw fetch, the caller's token, and `details` preferred
   * over `error` because the database's own sentence is the one an operator can act on. Nothing
   * stores the token. Unlike a broker credential, minting again does not replace the previous one.
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
      throw new Error(withReference(body?.details || body?.error || `Could not mint a token (${res.status})`, body));
    }

    return body;
  },

  /**
   * Withdraw a minted token, so PostgREST refuses it from the next request onward.
   *
   * Not a complete revocation: storage, realtime, the edge runtime and Studio verify the signature
   * themselves and consult no denylist, so a withdrawn token satisfies those until it expires.
   */
  revokeServiceToken: async (jti) => {
    const { data, error } = await supabase.rpc('revoke_service_token', { p_jti: jti });
    if (error) throw new Error(error.message);
    return data;
  },

  // -------------------------------------------------------------------------------------------
  // Backups (0101). Administrator only on both tables and every RPC; the bytes never come here.
  // -------------------------------------------------------------------------------------------

  /**
   * One page of finished backup runs (`backup_jobs`), newest first. Each carries the backup it
   * produced as `backup`, null for a failed or cancelled run and for one the retention window has
   * pruned. `total` is every run matching `statuses`, not only the page returned.
   */
  listBackupRuns: async ({ statuses = ['COMPLETED', 'FAILED', 'CANCELLED'], limit = 30 } = {}) => {
    const { data, error, count } = await supabase
      .from('backup_jobs')
      .select('*, backups(*)', { count: 'exact' })
      .in('status', statuses)
      .order('finished_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message || 'Could not list backup runs');
    // Embedded through backups.job_id, which is not unique, so PostgREST returns an array.
    const rows = (data || []).map(({ backups, ...job }) => ({
      ...job, backup: (Array.isArray(backups) ? backups[0] : backups) || null
    }));
    return { runs: rows, total: count ?? rows.length };
  },

  /**
   * What the Backups page's current-state line needs, whatever the list's filter and page:
   * the first job ever recorded, the latest completed one, and the latest that completed or failed.
   */
  backupRunSummary: async () => {
    const columns = 'id, status, created_at, started_at, finished_at';
    const [first, success, outcome] = await Promise.all([
      supabase.from('backup_jobs').select(columns)
        .order('created_at', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('backup_jobs').select(columns).eq('status', 'COMPLETED')
        .order('finished_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('backup_jobs').select(columns).in('status', ['COMPLETED', 'FAILED'])
        .order('finished_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    const error = first.error || success.error || outcome.error;
    if (error) throw new Error(error.message || 'Could not read backup jobs');
    return {
      firstRecordedAt: first.data?.created_at || null,
      lastSuccess: success.data || null,
      latestOutcome: outcome.data || null
    };
  },

  /** The ids of the newest `count` backups, in backup_prunable()'s order: the retention floor. */
  newestBackupIds: async (count) => {
    const { data, error } = await supabase
      .from('backups')
      .select('id')
      .order('taken_at', { ascending: false })
      .order('stamp', { ascending: false })
      .limit(count);
    if (error) throw new Error(error.message || 'Could not read backups');
    return (data || []).map(b => b.id);
  },

  /**
   * The off-site destination as the settings hold it, and whether the secret key is in the vault.
   * The rows are Administrator-only (`sensitive`), so anybody else reads an empty destination.
   */
  backupOffsiteDestination: async () => {
    const [rows, credential] = await Promise.all([
      supabase.from('system_settings').select('key,value').in('key', BACKUP_OFFSITE_SETTING_KEYS),
      supabase.rpc('backup_offsite_credential_is_set')
    ]);
    const error = rows.error || credential.error;
    if (error) throw new Error(error.message || 'Could not read the off-site destination');
    const byKey = Object.fromEntries((rows.data || []).map(r => [r.key.replace('backup_offsite.', ''), r.value]));
    return {
      endpoint: byKey.endpoint || '',
      region: byKey.region || '',
      bucket: byKey.bucket || '',
      prefix: byKey.prefix || '',
      access_key_id: byKey.access_key_id || '',
      recipient: byKey.recipient || '',
      path_style: byKey.path_style === true,
      credentialSet: credential.data === true
    };
  },

  /** Every destination field in one call; a refused field saves none of them. Administrator only. */
  setBackupOffsiteDestination: async (d) => {
    const { error } = await supabase.rpc('set_backup_offsite_destination', {
      p_endpoint: d.endpoint, p_region: d.region, p_bucket: d.bucket, p_prefix: d.prefix,
      p_access_key_id: d.access_key_id, p_recipient: d.recipient, p_path_style: !!d.path_style
    });
    if (error) {
      throw new Error(error.code === '42501'
        ? 'Only an Administrator can set the off-site destination'
        : (error.message || 'Could not save the off-site destination'));
    }
    return true;
  },

  /** The secret key, into the vault. Write-only: nothing reads it back. */
  setBackupOffsiteCredential: async (secret) => {
    const { error } = await supabase.rpc('set_backup_offsite_credential', { p_secret: secret });
    if (error) {
      throw new Error(error.code === '42501'
        ? 'Only an Administrator can set the off-site credential'
        : (error.message || 'Could not save the off-site credential'));
    }
    return true;
  },

  /** Stop copying: every field emptied and the secret deleted. Copies already made stay. */
  clearBackupOffsiteDestination: async () => {
    const { error } = await supabase.rpc('clear_backup_offsite_destination');
    if (error) throw new Error(error.message || 'Could not remove the off-site destination');
    return true;
  },

  /** The backup that is queued or running, or null. At most one, by a partial unique index. */
  activeBackupJob: async () => {
    const { data, error } = await supabase
      .from('backup_jobs')
      .select('*')
      .in('status', ['PENDING', 'RUNNING'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Could not read backup jobs');
    return data || null;
  },

  /**
   * Queue a backup. Returns the job id. The gate refuses while one is queued or running and
   * names it, so the message is surfaced verbatim.
   */
  requestBackup: async (note) => {
    const { data, error } = await supabase.rpc('request_backup', { p_note: note || null });
    if (error) {
      if (/insufficient_privilege|only an Administrator/i.test(error.message || '')) {
        throw new Error('Taking a backup requires Administrator.');
      }
      throw new Error(error.message || 'Could not queue the backup');
    }
    return data;
  },

  /** Withdraw a queued backup. False when the service had already claimed it. */
  cancelBackupJob: async (jobId) => {
    const { data, error } = await supabase.rpc('cancel_backup_job', { p_job_id: jobId });
    if (error) throw new Error(error.message || 'Could not cancel the backup');
    return data === true;
  },

  /** Let the retention window apply to a requested backup. False when it was not pinned. */
  releaseBackup: async (backupId) => {
    const { data, error } = await supabase.rpc('release_backup', { p_backup_id: backupId });
    if (error) throw new Error(error.message || 'Could not release the backup');
    return data === true;
  },

  /**
   * The historian's physical backup (0157), read over the FDW: its schedule, last success,
   * repository size, a failure newer than the last success, and the latest request. Null when the
   * historian cannot be read, which the page reports as unreachable rather than as nothing to say.
   */
  historianBackupState: async () => {
    const { data, error } = await supabase.rpc('historian_backup_state');
    if (error) throw new Error(error.message || 'Could not read the historian\'s backup');
    return (Array.isArray(data) ? data[0] : data) || null;
  },

  /**
   * Every stored capture, with the subject it was recorded from.
   *
   * Read from the table, not from storage: the row carries the note, the message count and the
   * manifest, including `birth_captured`. `canManage` comes from the session's role, not from the
   * list's length, since storage-api returns an empty array to an unauthorised caller.
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
   * The capture that is queued or running, or null. At most one exists, enforced by a partial
   * unique index. `maybeSingle()` makes "none" an ordinary answer.
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
   * `replace` is the confirmation dialog as an argument: the gate refuses when a capture of the
   * subject exists unless it is true, and names the capture it is protecting, so the message is
   * surfaced verbatim.
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
   * Ask a running capture to finish now. A column on the other side: the daemon observes
   * `stop_requested` on its next message. Returns false when the job had already finished, which
   * is not an error.
   */
  stopCapture: async (jobId) => {
    const { data, error } = await supabase.rpc('request_capture_stop', { p_job_id: jobId });
    if (error) throw new Error(error.message || 'Could not stop the capture');
    return data === true;
  },

  /**
   * Upload a capture recorded elsewhere.
   *
   * Validated as a capture before it is sent, since the bucket's MIME check is close to none and
   * a bad file would otherwise be discovered at playback. The object goes up first and the row is
   * written second: the path is deterministic, so a stray object is overwritten by the next
   * upload. The manifest is built here because the file is already parsed.
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
    const version = parsed.aber_capture_version;
    if (version === undefined) {
      // The likeliest wrong file in this dialog by a distance, since both are JSON and both are
      // things an engineer downloads from this same application.
      if (Array.isArray(parsed)) {
        throw new Error('That looks like a Node-RED flow export, not a capture.');
      }
      throw new Error('That file carries no aber_capture_version, so it is not a broker capture.');
    }
    if (version !== CAPTURE_VERSION) {
      throw new Error(
        `That capture is version ${version} and this stack reads version ${CAPTURE_VERSION}. ` +
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
   * A browser cannot publish MQTT, so this writes a row that the ingestion daemon picks up; the
   * answer arrives as an NBIRTH on the wire. This is the only command this stack sends: NCMD can
   * also write metric values, and that is not reachable from the dashboard.
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
   * The Playback gateway only (`is_shadow`; the filter below says why). `start_playback_job()`
   * itself refuses any gateway that is not simulated.
   * `gateway_has_broker_credential` is a computed field: PostgREST exposes a function taking the
   * row type as a selectable column, so the gate's own predicate is what the dialog displays.
   */
  playbackTargets: async () => {
    const { data, error } = await supabase
      .from('gateways')
      // `status` and `last_heartbeat` are read to warn about a target something ELSE is already
      // publishing as -- see StartPlaybackModal. Not to refuse one: a playback target is
      // legitimately OFFLINE, because nothing publishes as it until a playback runs.
      .select('id, name, sparkplug_id, sparkplug_group, is_archived, status, last_heartbeat, gateway_has_broker_credential, devices(id, name, sparkplug_id, is_archived, shadow_of)')
      // `is_shadow`, not `is_simulated`: a simulator holds a credential and Node-RED is publishing as
      // it at the same time, so two publishers would share one `seq` counter. The database refuses it.
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
   * A write, hung off an explicit click rather than off opening a dialog. Idempotent: a lane is
   * keyed on (playback gateway, original device) and reused.
   */
  ensureShadowLanes: async (captureId) => {
    const { data, error } = await supabase.rpc('ensure_shadow_devices', { p_capture_id: captureId });
    if (error) throw new Error(error.message || 'Could not prepare replay lanes');
    return data || {};
  },

  /**
   * What the playback worker can actually publish as, and when it last said so.
   *
   * The one fact the database cannot derive: the password is minted in a browser and pasted into
   * the worker's environment by hand. Null when nothing has ever reported, treated as stale.
   */
  playbackWorkerStatus: async () => {
    const { data, error } = await supabase
      .from('playback_worker_status')
      .select('held_edge_nodes, reported_at')
      .maybeSingle();
    if (error) throw new Error(error.message || 'Could not read the playback worker status');
    return data || null;
  },

  /**
   * The gateways the worker holds a credential for that has since been RE-ISSUED (#217, `0129`).
   * Held and current are different facts: the broker keeps one password per gateway, so every mint
   * after the first replaces one, and the reported id set does not change when it does.
   *
   * Server-side, because the comparison is against `audit_trail`, which the dialog has no
   * business reading.
   */
  playbackStaleCredentials: async () => {
    const { data, error } = await supabase.rpc('playback_stale_credentials');
    if (error) throw new Error(error.message || 'Could not read which playback credentials are stale');
    return data || [];
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
   * Queue a playback. Returns the job id. Every refusal comes back verbatim: the gate names what
   * it objected to, and each is a different thing for the operator to do next.
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
   * A short-lived signed URL; the bucket is private. `download` names the saved file and forces
   * an attachment, so a 50 MiB JSON recording is saved rather than rendered in the tab.
   */
  captureUrl: async (path) => {
    const filename = `${(path.split('/')[0] || 'capture')}.capture.json`;
    const { data, error } = await supabase.storage
      .from(CAPTURE_BUCKET).createSignedUrl(path, 60, { download: filename });
    if (error) throw new Error(error.message || 'Could not create a download link');
    return withApiKey(data.signedUrl);
  },

  /**
   * A stored asset bundle, as a download. The object sits in the cold tier's bucket, whose read
   * policy admits the same three roles the exports table does, so a row the reader can see is an
   * object they can fetch. Sixty seconds, one object, the same shape as a capture download.
   */
  assetExportDownloadUrl: async (row) => {
    const filename = row.object_key.split('/').pop();
    const { data, error } = await supabase.storage
      .from(row.object_bucket).createSignedUrl(row.object_key, 60, { download: filename });
    if (error) throw new Error(error.message || 'Could not create a download link');
    return withApiKey(data.signedUrl);
  },

  /**
   * Remove a capture: the row and the object. The row goes first, the opposite of upload: a failed
   * object delete leaves unreferenced bytes that the next capture of that subject overwrites.
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

  get: async (path, _options = {}) => {
    /**
     * The tombstones: rows that were archived and then deleted, one per entity, written by the
     * database on the DELETE and readable by whoever may read the page or the trail's asset
     * lane. Each carries the exports taken of it while it was alive, so the page can offer the
     * download after the row is gone.
     */
    if (path.startsWith('/api/v1/archives/retired')) {
      const { data, error } = await supabase
        .from('retired_entities')
        .select('*')
        .order('retired_at', { ascending: false });
      if (error) throw error;
      const rows = data || [];
      // Tolerated: the exports table is readable by the three bucket roles, and a reader admitted
      // to the tombstones by `audit_trail:read` alone sees them without their downloads.
      const { data: exportRows } = await supabase
        .from('asset_exports')
        .select('*')
        .in('entity_id', rows.map(r => r.entity_id))
        .order('taken_at', { ascending: false });
      const exportsByEntity = new Map();
      for (const x of exportRows || []) {
        if (!exportsByEntity.has(x.entity_id)) exportsByEntity.set(x.entity_id, []);
        exportsByEntity.get(x.entity_id).push(x);
      }
      return rows.map(r => ({
        ...r,
        // The singular the page's other rows use, so one row shape serves both cards.
        entity_type: r.entity_type.replace(/s$/, ''),
        exports: exportsByEntity.get(r.entity_id) || []
      }));
    }

    /** The bundles taken of live devices, newest first, keyed by device for the archived card. */
    if (path.startsWith('/api/v1/archives/exports')) {
      const { data, error } = await supabase
        .from('asset_exports')
        .select('*')
        .order('taken_at', { ascending: false });
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/archives')) {
      const [areasRes, cellsRes, gatewaysRes, devicesRes] = await Promise.all([
        supabase.from('areas').select('*').eq('is_archived', true),
        supabase.from('cells').select('*').eq('is_archived', true),
        supabase.from('gateways').select('*').eq('is_archived', true),
        supabase.from('devices').select('*').eq('is_archived', true)
      ]);

      if (areasRes.error) throw areasRes.error;
      if (cellsRes.error) throw cellsRes.error;
      if (gatewaysRes.error) throw gatewaysRes.error;
      if (devicesRes.error) throw devicesRes.error;

      const areas = (areasRes.data || []).map(a => ({
        entity_id: a.id,
        name: a.name,
        entity_type: 'area',
        archived_at: a.archived_at,
        auto_delete_at: a.auto_delete_at,
        // The purge dialog says the plan goes with the row, when there is one.
        plan_path: a.plan_path
      }));

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
        // What archiving took, so the restore dialog can say it as a fact: archiving rotates the
        // gateway's broker credential, and restoring flips `is_archived` back and nothing else.
        credential_revoked_at: g.credential_revoked_at,
        // The forge's half of the same sentence (0114). Set means the sweep has archived the
        // repository, so restoring has something to reverse — and the deploy key it removed on
        // the way in is not something restoring can give back.
        forge_archived_at: g.forge_archived_at
      }));

      const devices = (devicesRes.data || []).map(d => ({
        entity_id: d.id,
        name: d.name,
        entity_type: 'device',
        archived_at: d.archived_at,
        auto_delete_at: d.auto_delete_at
      }));

      const combined = [...areas, ...cells, ...gateways, ...devices];
      combined.sort((a, b) => new Date(b.archived_at || 0) - new Date(a.archived_at || 0));
      return combined;
    }

    if (path.startsWith('/api/v1/areas')) {
      // Cells embedded so the Areas page has membership in one round trip. Devices are not: a
      // device's area is its resolved cell's, which is device_locations' answer, except an
      // Area-Wide device, which carries its own `area_id`.
      const { data, error } = await supabase
        .from('areas')
        .select('*, cells(id, name, plan_x, plan_y, icon, is_archived)')
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(a => ({
        ...a,
        area_id: a.id,
        area_name: a.name,
        cells: (a.cells || []).map(c => ({ ...c, cell_id: c.id, cell_name: c.name })),
        cell_count: (a.cells || []).length
      }));
    }

    if (path.startsWith('/api/v1/cells')) {
      // Nested embed so each cell arrives with its gateways in one round trip. Devices are not
      // returned: membership is the resolved effective cell, which no embed can express, and every
      // caller already holds the device list (groupDevicesByCell() in utils/cellResolution.js).
      // `devices`/`device_count` are omitted rather than empty, so a consumer expecting them fails
      // visibly.
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
     * Latest value per metric for one device, for the Devices page's telemetry drawer.
     *
     * Checked before the /config route and the collection route, which would otherwise match
     * first. Scoped to a single asset so the bounded page is spent on this device; the default
     * window is 24h because a machine that reports hourly should not appear to have no data.
     */
    if (path.match(/\/api\/v1\/devices\/(.+)\/telemetry\/latest/)) {
      const match = path.match(/\/api\/v1\/devices\/(.+)\/telemetry\/latest/);
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '1440', 10);
      return queryLatestTelemetry({ assetId: match[1], minutes });
    }

    /**
     * Everything the nameplate editor needs, in one round trip: the template's element list, the
     * stored row, and what the device publishes for itself. The AAS exporter prefers a
     * device-published value over a stored one, so the form shows which fields the device already
     * answers. The join is on `semantic_id`, as the exporter does it.
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

    if (path.startsWith('/api/v1/devices')) {
      // Embed the serving gateway so each device carries its resolved gateway name, and read
      // device_locations for the effective cell. The gateway's own cell is what the local fallback
      // resolves from.
      const [{ data, error }, locations] = await Promise.all([
        supabase
          .from('devices')
          // `is_simulated` and `is_shadow` are selected for the fallback path: when the device_locations
          // read fails, resolveDeviceLocation() re-derives locally and needs them.
          .select('*, gateways(id, name, cell_id, area_id, location_scope, is_simulated, is_shadow, status, is_archived)')
          .order('created_at', { ascending: false }),
        loadDeviceLocations()
      ]);
      if (error) throw error;

      // The schemas attached to each device, read from the `device_schemas` view so the choice
      // between device_submodels rows and devices.schema_id is made once, in SQL. Non-fatal:
      // schemasForDevice() falls back to schema_id.
      const { data: links } = await supabase.from('device_schemas').select('device_id, schema_id');
      const schemasByDevice = new Map();
      for (const link of links || []) {
        if (!schemasByDevice.has(link.device_id)) schemasByDevice.set(link.device_id, []);
        schemasByDevice.get(link.device_id).push(link.schema_id);
      }

      // No `cell_id:` override here: `cell_id` is the device's own explicit override (null means
      // inherit), and the resolved value is `effective_cell_id`.
      return (data || []).map(d => ({
        ...mapDeviceRow(d, d.gateways, locations?.get(d.id)),
        submodel_schema_ids: schemasByDevice.get(d.id) || []
      }));
    }

    if (path.includes('/audit-trail')) {
      const url = new URL(path, window.location.origin);
      const entityType = url.searchParams.get('entity_type');
      // Pushed down as a SQL predicate, matching the entity id and the audit-snapshot fields the
      // timeline labels a lane from, so a deleted entity is still searchable by name.
      const search = (url.searchParams.get('search') || '').trim();
      const entityIds = url.searchParams.has('entity_ids')
        ? url.searchParams.get('entity_ids').split(',').filter(Boolean)
        : undefined;
      // INSERT / UPDATE / DELETE. Filtered in SQL rather than client-side because the row limit
      // is applied by the database: filtering after the fact would page through 200 mixed rows
      // and then show whatever fraction of them happened to be deletions.
      const action = (url.searchParams.get('action') || '').trim().toUpperCase();
      const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
      // The timeline's range control is pushed down as a SQL predicate: `limit` applies to rows
      // ordered newest first, so a client-side window would spend the budget on rows it then discards.
      const since = (url.searchParams.get('since') || '').trim();
      const until = (url.searchParams.get('until') || '').trim();

      // The keyset cursor: both halves or neither. `recorded_at` is not unique (one transaction's rows
      // share one `now()`), so the id is what makes the position exact. The RPC ignores a half-cursor.
      const beforeRecordedAt = (url.searchParams.get('before_recorded_at') || '').trim();
      const beforeId = (url.searchParams.get('before_id') || '').trim();
      const hasCursor = beforeRecordedAt !== '' && beforeId !== '';

      // An EMPTY list must return nothing rather than everything -- "these ids, of which there are
      // none" is not "no filter". The Audit Trail page searches by name (`search` above); this
      // stays as the primitive for "this entity's history", which `p_search` cannot express.
      if (entityIds && entityIds.length === 0) return [];

      // The deleted-asset filter is a predicate, not a post-filter, which is why this is an RPC:
      // "still exists" is an anti-join against five tables, and a filter applied after the limit
      // pages through mixed rows and shows whichever fraction survived. `audit_trail_page()` also
      // returns the purged count, which drives the control that reveals them.
      const includePurged = url.searchParams.get('include_purged') === 'true';

      if (action && !Object.prototype.hasOwnProperty.call(AUDIT_TRAIL_ACTIONS, action)) {
        // An action the client does not know about. Refusing beats widening: returning every row
        // for an unrecognised filter is how a caller ends up believing it has seen a filtered set.
        return [];
      }

      const { data, error } = await supabase.rpc('audit_trail_page', {
        p_limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        p_include_purged: includePurged,
        // Normalised to the stored form: the trigger writes TG_TABLE_NAME ('cells' / 'gateways' /
        // 'devices') and the UI offers 'CELL' / 'GATEWAY' / 'DEVICE'. Read from `constants.js`, shared
        // with the dropdown that offers them, so a kind cannot be offered without being resolvable. An
        // unrecognised kind is passed through rather than nulled.
        p_entity_type: entityType
          ? (ENTITY_TABLE_BY_KIND[entityType.toUpperCase()] || entityType)
          : null,
        p_action: action || null,
        p_entity_ids: entityIds && entityIds.length ? entityIds : null,
        p_search: search || null,
        p_since: since || null,
        p_until: until || null,
        // Sent only with a cursor, both halves or neither.
        ...(hasCursor
          ? { p_before_recorded_at: beforeRecordedAt, p_before_id: Number(beforeId) }
          : {}),
      });
      if (error) throw error;

      const payload = data || {};
      // Nothing is filtered after this point: a filter applied after the page would make
      // `rows.length` say nothing about whether the database had more, which is why `next_cursor`
      // is the only end-of-data signal.
      const rows = (payload.events || []).map(mapAuditTrailRow);

      // The array is still the return value, with the page-level facts attached to it, so
      // `.length`, `.map`, destructuring and bare-array mocks keep working.
      rows.purgedAssets = Number(payload.purged_assets || 0);
      rows.truncated = Boolean(payload.truncated);
      // How many rows the filters select in total. NULL rather than 0 when the payload carries none,
      // so "no total" is not read as "no events"; 0 is a real answer an empty filter result gives.
      rows.totalMatching = typeof payload.total_matching === 'number'
        ? payload.total_matching
        : null;
      // NULL IS THE ONLY END-OF-DATA SIGNAL, and it comes from the server. A full page that happens
      // to be the last one is ordinary, so "fewer rows than I asked for" is not a reliable test and
      // callers must not invent one.
      rows.nextCursor = payload.next_cursor || null;
      return rows;
    }

    if (path.startsWith('/api/v1/quarantine')) {
      // The gateway's cell and scope are selected, not just its name: mapDeviceRow resolves the
      // device's location from them, which the approval modal shows.
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
      // flat and bucketed by the caller -- it is ~600 short rows, read once per visit to the Metrics
      // or Vocabulary page.
      const { data, error } = await supabase
        .from('mtconnect_vocabulary')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      // semantic_id is the concept-level local IRI added by archived migration
      // 20260101000032_effectiveness_and_mtconnect_semantics.sql -- distinct from the observation-level
      // id a catalog metric carries, which is built from the whole metric name.
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
      // Reference data (archived migration 0013_ashrae223_vocabulary.sql), generated from the open223 ontology. Ordered by the
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

    if (path.startsWith('/api/v1/idta-submodel-templates')) {
      // Reference data (seeded by 0002_seed_data.sql), read-only to the app: each IDTA template
      // element with the id and reference type the template issues for it, for the semantic id picker.
      const { data, error } = await supabase
        .from('idta_submodel_templates')
        .select('template_id, template_name, template_version, id_short, semantic_id, semantic_id_type, description')
        .order('template_id', { ascending: true })
        .order('ordinal', { ascending: true });
      if (error) throw error;
      return data || [];
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
        // Generated column: the name's first `/`-separated segment, NULL when there isn't one.
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
        // legitimate state for a local extension: no vocabulary names it.
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
        // Defaulted here as well as in the column, so a client against a database that has not
        // replayed the versioning migration renders v1/Active and `isSchemaEditable()` fails closed.
        version: s.version ?? 1,
        status: s.status ?? 'active',
        parent_schema_id: s.parent_schema_id ?? null,
        change_description: s.change_description ?? null,
        created_at: s.created_at
      }));
    }

    /*
     * The runtime configuration plane. Ordered by category then label, so the settings page groups
     * without sorting client-side.
     */
    if (path.startsWith('/api/v1/settings')) {
      const { data, error } = await supabase
        .from('system_settings')
        .select('id,key,value,value_type,category,label,description,fallback_source,min_value,max_value,read_only,updated_at,updated_by')
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
        // The image the release deploys for the service (0140); null when nothing recorded one.
        image: s.image ?? null,
        status: s.status,
        last_heartbeat: s.last_heartbeat
      }));
    }

    // How far back each resolution reaches. Four rows, evaluated on the TimescaleDB side (archived
    // migration 0111_how_far_back_each_telemetry_resolution_reaches.sql) -- the retention SETTINGS
    // cannot answer this, because a young stack holds less than its policy allows and a widened
    // policy does not restore dropped chunks.
    if (path.startsWith('/api/v1/telemetry/horizons')) {
      return queryTelemetryHorizons();
    }

    // Latest value per (device, metric) inside a bounded recent window, for the Devices page, which
    // needs current state rather than the history the export dialog pages through.
    if (path.startsWith('/api/v1/telemetry/latest')) {
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '60', 10);
      return queryLatestTelemetry({ minutes });
    }

    if (path.startsWith('/api/v1/telemetry')) {
      const url = new URL(path, window.location.origin);
      return queryTelemetry({
        assetId: url.searchParams.get('asset_id'),
        metricName: url.searchParams.get('metric_name'),
        minutes: Number.parseInt(url.searchParams.get('minutes') || '', 10),
        // Absolute bounds, used by the CSV export's custom range. Null when absent, so the
        // relative `minutes` form still applies for every other caller.
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: Number.parseInt(url.searchParams.get('limit') || '', 10),
        offset: Number.parseInt(url.searchParams.get('offset') || '', 10),
        // `?resolution=1m|5m|1h` reads a rollup instead of raw. ABSENT MEANS RAW, and that is the
        // export's default rather than its only option: past the raw retention window a rollup is
        // the only thing that still answers. See TELEMETRY_RESOLUTIONS.
        resolution: url.searchParams.get('resolution') || undefined
      });
    }

    /**
     * The approvals queue, with each proposal's target resolved beside it.
     *
     * The whole queue in one call: `proposals.max_open_per_person` and a partial unique index per
     * asset bound it to tens of rows. RLS decides what comes back, not a parameter. The targets are
     * fetched separately because `entity_id` addresses a table that varies per row.
     */
    if (path === '/api/v1/proposals') {
      const { data, error } = await supabase
        .from('change_proposals')
        .select('*')
        .order('proposed_at', { ascending: false });
      if (error) throw error;

      const rows = data || [];
      if (rows.length === 0) return [];

      const idsOf = (...types) => [...new Set(rows
        .filter(r => types.includes(r.entity_type))
        .map(r => r.entity_id))];

      // One read per subject table, for this page's ids only. A read that fails resolves to null:
      // its rows keep their uuid and no diff, and are not marked missing, because a failed read is
      // not evidence the subject is gone.
      const readByIds = async (table, columns, key, ids) => {
        if (ids.length === 0) return new Map();
        try {
          const { data, error } = await supabase.from(table).select(columns).in(key, ids);
          if (error) return null;
          return new Map((data || []).map(row => [row[key], row]));
        } catch {
          return null;
        }
      };

      // Each read names every column `proposable_columns()` lets its lane patch, or the drawer's Now
      // column reads blank for that field. apiProposals.test.js checks this against the migrations.
      const deviceIds = idsOf('devices', 'device_nameplate');
      const [devices, nameplates, schemas, areas, cells, gateways, proposersRes] = await Promise.all([
        readByIds('devices',
          'id,name,description,connection_method,cell_id,area_id,location_scope,model_3d_path,is_archived',
          'id', deviceIds),
        readByIds('device_nameplate', '*', 'device_id', deviceIds),
        readByIds('schemas', 'id,schema_name,version,status,parent_schema_id', 'id', idsOf('schemas')),
        readByIds('areas', 'id,name,description,icon', 'id', idsOf('areas')),
        readByIds('cells', 'id,name,grafana_url,icon,area_id,plan_x,plan_y,description', 'id',
          idsOf('cells')),
        readByIds('gateways', 'id,name,sparkplug_id,description,cell_id,area_id,location_scope,access_url',
          'id', idsOf('gateways')),
        // The machines behind the proposals this caller may decide (0154); empty for anyone else.
        // An error leaves the proposer as its uuid rather than failing the queue.
        Promise.resolve(supabase.rpc('list_proposer_names')).catch(() => ({ data: [] }))
      ]);

      const machineNames = new Map((proposersRes?.data || []).map(m => [m.principal_id, m.name]));

      // Per lane: the read that holds the subject and how to name it. A nameplate's subject is its
      // device and its `current` is the nameplate row, `{}` until the first approval creates it.
      const subjects = {
        devices:          { found: devices,  label: d => d.name },
        device_nameplate: { found: devices,  label: d => d.name,
                            current: id => (nameplates ? nameplates.get(id) || {} : null) },
        schemas:          { found: schemas,  label: s => `${s.schema_name} v${s.version}` },
        areas:            { found: areas,    label: a => a.name },
        cells:            { found: cells,    label: c => c.name },
        gateways:         { found: gateways, label: g => g.name || g.sparkplug_id }
      };

      return rows.map(r => {
        const lane = subjects[r.entity_type];
        const subject = lane?.found?.get(r.entity_id) || null;
        return {
          ...r,
          target_label: (subject && lane.label(subject)) || r.entity_id,
          target_missing: Boolean(lane?.found) && !subject,
          // What the patch would change FROM, so the drawer shows a diff and not only the ask.
          current: lane?.current ? lane.current(r.entity_id) : subject,
          proposed_by_machine_name: machineNames.get(r.proposed_by) || null
        };
      });
    }

    throw new Error('Unhandled API path: ' + path);
  },

  post: async (path, body, _options = {}) => {
    /**
     * File a proposal. A plain INSERT: `Operator` holds an INSERT policy on this one table, and
     * routing it through an RPC would put the grant somewhere the RLS policy is not. The errors are
     * not flattened: a unique violation is the per-asset cap and a check violation the per-person
     * one, and they need different repairs.
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

    // A metric's lifecycle (#468). Matched before the generic `/restore` below, which would write
    // `is_archived` to a table named after the path. Restore clears `superseded_by` with the flag.
    // No row back means RLS refused the UPDATE (Administrator only), so it is not a success.
    const metricLifecycle = path.match(/^\/api\/v1\/metric-catalog\/([^/]+)\/(deprecate|restore)$/);
    if (metricLifecycle) {
      const [, id, action] = metricLifecycle;
      const change = action === 'deprecate'
        ? { deprecated: true, superseded_by: emptyToNull(body?.superseded_by) }
        : { deprecated: false, superseded_by: null };
      const { data, error } = await supabase.from('metric_catalog').update(change).eq('id', id).select();
      if (error) throw error;
      if (!data?.length) {
        throw new Error(
          `Metric not ${action === 'deprecate' ? 'deprecated' : 'restored'} — it may no longer exist, ` +
          'or you may not have permission to change the catalog.'
        );
      }
      return data[0];
    }

    if (path.includes('/archive')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const now = new Date().toISOString();
      const days = body?.auto_delete_days;
      const auto_delete_at = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

      let query = supabase
        .from(entityType)
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

      let query = supabase
        .from(entityType)
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

    if (path === '/api/v1/areas') {
      const { data, error } = await supabase.from('areas').insert({
        name: body.area_name,
        description: emptyToNull(body.description),
        // Omitted when the caller sends nothing, so the column's own default is the one place
        // that value lives (the cells insert below says why).
        ...(body.icon ? { icon: body.icon } : {})
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/cells') {
      const { data, error } = await supabase.from('cells').insert({
        name: body.cell_name,
        grafana_url: body.access_url,
        description: emptyToNull(body.description),
        area_id: emptyToNull(body.area_id),
        plan_x: planCoordFrom(body.plan_x),
        plan_y: planCoordFrom(body.plan_y),
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
        connection_method: emptyToNull(body.connection_method),
        schema_id: emptyToNull(body.schema_id),
        // NO `status`. It is observed, never asserted: ingestion writes ONLINE on a DBIRTH, and the
        // column defaults to OFFLINE for a device that has not connected. Sending one here claims a
        // machine is running before the platform has heard from it, which
        // devices_online_implies_born now refuses.
        // Omitted entirely when the caller sends nothing: cell_id has no column default, and NULL
        // means "inherit from the gateway".
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
      // `standard` records which vocabulary a group came from; the picker filters by it. Empty string
      // is the Custom standard, stored as NULL (STANDARDS.CUSTOM in utils/standards.js).
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
      // The last check before something permanent: `metric_catalog.name` is immutable. The form
      // already refuses a bad name and the database constraint refuses it too; this gives any other
      // caller a sentence naming the offending character instead of a raw 400 quoting a regex.
      // The same mirrored expression as utils/metricGroup.js, not a second one.
      const nameError = metricNameError(body.name)
      if (nameError) throw new Error(nameError)

      const { data, error } = await supabase.from('metric_catalog').insert({
        name: (body.name || '').trim(),
        datatype: body.datatype,
        category: emptyToNull(body.category),
        units: emptyToNull(body.units),
        sub_type: emptyToNull(body.sub_type),
        standard: emptyToNull(body.standard),
        ...semanticIdPair(body),
        description: body.description || null
      }).select();
      if (error) throw error;
      const item = data?.[0] || {};
      return { metric_uuid: item.id || '', ...item };
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
      return { valid: true, message: 'All required fields are present.' };
    }

    // Both are RPCs rather than table writes: `version` is computed from the parent and `publish`
    // repoints every device and archives the predecessor in one transaction. The database refuses
    // the direct forms (`enforce_schema_version_provenance()`, `prevent_active_schema_mutation()`).
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
     * Through the RPC, not a DELETE: `devices.schema_id` is ON DELETE SET NULL and
     * `device_submodels.schema_id` is ON DELETE CASCADE, so deleting an active schema silently
     * detaches every device bound to it. The function refuses anything that is not a draft.
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
        ...semanticIdPair(body),
        // A newly built schema is v1 and in force immediately; `version` and `status` are left to their
        // column defaults because sending them is what the provenance trigger refuses.
        change_description: emptyToNull(body.change_description) || 'Initial release'
      }).select();
      if (error) throw error;
      const item = data?.[0] || {};
      return { schema_uuid: item.id || '', ...item };
    }

    /**
     * The per-asset bundle: the AASX with the device's trail, its live telemetry and a manifest
     * naming the cold objects, stored beside the cold tier and recorded in `asset_exports` by the
     * function. Fetched directly for the reason the AASX path is: the body is a ZIP. The counts,
     * and whether the copy was stored, ride in the same header.
     */
    if (path.startsWith('/api/v1/devices/asset-export')) {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/aas-export?format=bundle`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_GATEWAY_KEY,
          Authorization: `Bearer ${session?.access_token || SUPABASE_GATEWAY_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ device_id: body.device_id })
      });

      if (!res.ok) {
        const failed = await res.json().catch(() => null);
        throw new Error(withReference(failed?.error || `Export failed (${res.status})`, failed));
      }

      let stats = {};
      try { stats = JSON.parse(res.headers.get('X-AAS-Stats') || '{}'); } catch { /* absent */ }
      const disposition = res.headers.get('Content-Disposition') || '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || null;
      return { blob: await res.blob(), stats, filename, format: 'bundle' };
    }

    if (path.startsWith('/api/v1/devices/aas-export')) {
      // The whole document is composed server-side: the shell needs the service role to read
      // asset_config and the full metric_catalog.
      // AASX is fetched directly rather than through functions.invoke(): supabase-js decodes any
      // response that is not JSON or octet-stream as text, which corrupts a ZIP.
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
          const failed = await res.json().catch(() => null);
          throw new Error(withReference(failed?.error || `AAS export failed (${res.status})`, failed));
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

  put: async (path, body, _options = {}) => {
    /**
     * Edit an open proposal: the patch and the rationale, the only two columns the transition
     * guard lets a proposer move. This is what makes the per-asset cap livable: told there is
     * already an open proposal on this device, a person can open that one and add to it.
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

    /**
     * Correct a catalog metric's semantic id. Only the pair is sent: `name` and `datatype` are what
     * devices publish, and enforce_metric_catalog_immutability() refuses both regardless. No row
     * back means RLS refused the UPDATE (Administrator only), so it is not a success.
     */
    if (/^\/api\/v1\/metric-catalog\/[^/]+$/.test(path)) {
      const { data, error } = await supabase
        .from('metric_catalog').update(semanticIdPair(body)).eq('id', id).select();
      if (error) throw error;
      if (!data?.length) {
        throw new Error(
          'Semantic id not changed — the metric may no longer exist, or you may not have permission ' +
          'to change the catalog.'
        );
      }
      return data[0];
    }

    // Editing a draft version: its metric set, description and semantic id. No status guard here
    // beyond sending only the editable keys: `prevent_active_schema_mutation()` refuses this write
    // against an active or archived row.
    if (path.startsWith('/api/v1/schemas/')) {
      const patch = {};
      if ('schema_definition' in body) patch.schema_definition = body.schema_definition;
      if ('description' in body) patch.description = body.description;
      if ('change_description' in body) patch.change_description = emptyToNull(body.change_description);
      // The pair travels together, so clearing the id clears the type with it.
      if ('semantic_id' in body) Object.assign(patch, semanticIdPair(body));

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

    if (path.startsWith('/api/v1/areas/')) {
      const { data, error } = await supabase.from('areas').update({
        name: body.area_name,
        description: emptyToNull(body.description),
        ...(body.icon ? { icon: body.icon } : {})
      }).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    if (path.startsWith('/api/v1/cells/')) {
      const { data, error } = await supabase.from('cells').update({
        name: body.cell_name,
        grafana_url: body.access_url,
        ...(body.icon ? { icon: body.icon } : {}),
        // Only when sent: the Areas page files a cell with a body naming nothing else.
        ...('area_id' in body ? { area_id: emptyToNull(body.area_id) } : {}),
        ...('plan_x' in body ? { plan_x: planCoordFrom(body.plan_x) } : {}),
        ...('plan_y' in body ? { plan_y: planCoordFrom(body.plan_y) } : {}),
        ...('description' in body ? { description: emptyToNull(body.description) } : {})
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
      // Sent separately from deployment, but not independent of it: the table holds a simulated
      // gateway to 'host' (gateways_simulated_is_host), so pairing it with 'remote' is refused.
      if ('is_simulated' in body) patch.is_simulated = !!body.is_simulated;
      // See the devices patch: emptyToNull so clearing the field stores NULL, not ''.
      if ('description' in body) patch.description = emptyToNull(body.description);
      // Same pairing rule as devices: marking a gateway Site-Wide clears its cell. `deployment` says
      // where the connector runs; site-wide is an assertion about where the assets are.
      Object.assign(patch, locationFieldsFrom(body));

      const { data, error } = await supabase.from('gateways').update(patch).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    /**
     * Upsert a device's nameplate. An empty field clears the column rather than being skipped, so
     * a wrong serial number can be blanked. The row is deleted when every field is empty: "no
     * nameplate data" is modelled as no row, and the exporter omits an empty submodel.
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
      // Renaming is safe: `name` is a display label; telemetry, birth parameters and the MQTT topic
      // are keyed by sparkplug_id. gateway_id is written from whichever key the caller supplied (the
      // UI models it as `active_gateway_id`).
      const patch = {
        name: body.asset_name
      };
      // emptyToNull, so clearing the field in the form stores NULL rather than ''. Absent and empty
      // are the same thing to every reader of a description, and two representations of one state is
      // how a `WHERE description IS NULL` starts missing rows.
      if ('description' in body) patch.description = emptyToNull(body.description);
      if ('connection_method' in body) patch.connection_method = emptyToNull(body.connection_method);
      if ('schema_id' in body) patch.schema_id = emptyToNull(body.schema_id);
      // Not emptyToNull: the column is NOT NULL with a default of 'audit', so an absent key is how the
      // caller says "leave it alone", and the CHECK constraint refuses anything outside the two values.
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

  /**
   * Attach a plan to an area. The file is read first so an SVG with no stated size is
   * refused before anything is uploaded; the object goes up, then the row records its path and
   * aspect; a failed row write removes the object, and a successful one removes the plan it
   * replaced. Each upload takes a new path, so a cached blob URL never shows a stale drawing.
   */
  uploadAreaPlan: async (area, file) => {
    if (!isSvgFile(file)) throw new Error('An area plan is an SVG file.');
    if (file.size > AREA_PLAN_MAX_BYTES) {
      throw new Error(`"${file.name}" is larger than the ${Math.round(AREA_PLAN_MAX_BYTES / 1048576)} MiB limit for an area plan.`);
    }
    const { aspect, problem } = readSvgPlan(decodeSvgBytes(await file.arrayBuffer()));
    if (problem) throw new Error(problem);

    const areaId = area.area_id ?? area.id;
    const path = areaPlanPath({ area_id: areaId });
    const { error: uploadError } = await supabase.storage
      .from(AREA_PLAN_BUCKET)
      .upload(path, file, { upsert: false, contentType: 'image/svg+xml' });
    if (uploadError) {
      if (/row-level security|Unauthorized/i.test(uploadError.message || '')) {
        throw new Error('You do not have permission to upload an area plan.');
      }
      throw new Error(uploadError.message || 'Upload failed');
    }

    const { data, error } = await supabase
      .from('areas')
      .update({ plan_path: path, plan_aspect: aspect })
      .eq('id', areaId)
      .select();
    if (error || !data?.length) {
      await supabase.storage.from(AREA_PLAN_BUCKET).remove([path]);
      throw new Error(error?.message || 'Could not attach the plan to the area');
    }

    const previous = area.plan_path;
    if (previous && previous !== path) {
      await supabase.storage.from(AREA_PLAN_BUCKET).remove([previous]).catch(() => {});
    }
    return { ...data[0], area_id: data[0].id };
  },

  /**
   * Detach an area's plan. The row is cleared before the object is deleted: the worst case is a
   * stranded object, never an area pointing at a drawing that is gone. Cell places in the area are
   * kept, since the default outline shares the plan's coordinate space.
   */
  removeAreaPlan: async (area) => {
    const areaId = area.area_id ?? area.id;
    const { data, error } = await supabase
      .from('areas')
      .update({ plan_path: null, plan_aspect: null })
      .eq('id', areaId)
      .select();
    if (error) throw new Error(error.message || 'Could not detach the plan');
    if (!data?.length) throw new Error('You do not have permission to change this area.');
    if (area.plan_path) {
      await supabase.storage.from(AREA_PLAN_BUCKET).remove([area.plan_path]).catch(() => {});
    }
    return { ...data[0], area_id: data[0].id };
  },

  /**
   * Change one setting's value.
   *
   * PATCH semantics through `.update()`, not PUT: `value` is the only column `authenticated`
   * holds a grant on. `.select()` is not optional: RLS makes a non-Administrator's update affect
   * zero rows without erroring, and returning the row lets the page tell "saved" from "silently
   * not saved".
   */
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
   * The search bar's third answer: pasting an id from a Grafana alert, a topic or a log line.
   * Five tables because five pages can focus one row. All five are asked at once and a list comes
   * back, so on the day two tables answer the caller shows both. A miss and a refusal both come
   * back empty: RLS returns no rows rather than an error, and the palette must not claim to know
   * which.
   */
  resolveId: async (uuid) => {
    if (!isUuid(uuid)) return [];

    // `maybeSingle` rather than `single`: four of the five probes always miss. The name column is
    // named per table (`schemas` calls it `schema_name`).
    const probe = (table, kind, nameColumn) =>
      supabase.from(table).select(`id, ${nameColumn}`).eq('id', uuid).maybeSingle()
        .then(({ data, error }) => (error || !data ? null : { kind, id: data.id, name: data[nameColumn] }));

    return (await Promise.all([
      probe('devices', 'device', 'name'),
      probe('gateways', 'gateway', 'name'),
      probe('cells', 'cell', 'name'),
      probe('areas', 'area', 'name'),
      probe('schemas', 'schema', 'schema_name')
    ])).filter(Boolean);
  },

  /**
   * The five asset kinds, matched by name.
   *
   * The companion to `resolveId`, separate because a name search can hit many rows and fails
   * differently. `ilike` with the term escaped, since `%` and `_` are LIKE wildcards. Capped per
   * kind, not overall, so four hundred devices cannot crowd out three cells. RLS decides what
   * comes back.
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
      probe('areas', 'area', 'name'),
      probe('schemas', 'schema', 'schema_name')
    ]);

    // AN EXACT MATCH FIRST, then alphabetical. Somebody who typed a full name wants that row, and
    // it would otherwise sit wherever its table happened to fall among the five.
    const lowered = needle.toLowerCase();
    return found.flat().sort((a, b) => {
      const aExact = String(a.name || '').toLowerCase() === lowered;
      const bExact = String(b.name || '').toLowerCase() === lowered;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  },

  delete: async (path, _options = {}) => {
    if (path.startsWith('/api/v1/links/')) {
      const id = path.split('/')[4];
      const { error } = await supabase.from('links').delete().eq('id', id);
      if (error) throw error;
      return true;
    }

    const parts = path.split('/');
    const id = parts[parts.length - 1];

    if (path.startsWith('/api/v1/areas/')) {
      // Refused by the database while an area-wide asset names it; its cells are un-filed. The
      // plan object is removed afterwards: the delete cannot reach storage, and a stranded object
      // is the tolerable failure.
      const { data: rows } = await supabase.from('areas').select('plan_path').eq('id', id);
      const { error } = await supabase.from('areas').delete().eq('id', id);
      if (error) throw error;
      const planPath = rows?.[0]?.plan_path;
      if (planPath) await supabase.storage.from(AREA_PLAN_BUCKET).remove([planPath]).catch(() => {});
      return true;
    }

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
