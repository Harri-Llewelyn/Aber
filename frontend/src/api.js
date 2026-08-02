import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './lib/supabaseClient';
import { isUuid } from './utils/isUuid';
import { deviceSparkplugId } from './utils/sparkplugId';
import { resolveDeviceLocation, SCOPE_SITE_WIDE } from './utils/cellResolution';
import { edgeFunctionErrorMessage } from './utils/edgeFunctionError';
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
//   * `devices.cell_id` (migration 0036) is an explicit LOCATION override. NULL means inherit
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
  'id, name, sparkplug_id, reported_identity, identity_source, status, is_quarantined, ' +
  'is_archived, gateway_id, cell_id, location_scope, created_at, model_3d_path';
const GATEWAY_EMBED =
  `id, name, sparkplug_id, cell_id, location_scope, access_url, status, last_heartbeat, ` +
  `is_virtual, is_archived, archived_at, created_at, devices(${DEVICE_EMBED})`;

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
 * (migration 0036) reject a site-wide asset that also names a cell, because "it is in no
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
 */
async function queryTelemetry({ assetId, assetIds, metricName, minutes, from: fromTime, to: toTime, limit, offset } = {}) {
  const pageSize = Math.min(
    Number.isFinite(limit) && limit > 0 ? limit : TELEMETRY_PAGE_SIZE,
    TELEMETRY_MAX_ROWS
  );
  const from = Number.isFinite(offset) && offset > 0 ? offset : 0;

  const telemetryKey = toTelemetryKey(assetId);
  // Set by a tag filter, which resolves to a whole group of devices. The IN list grows with the
  // fleet, and postgres_fdw pushes the WHERE down but not the LIMIT (README known issue #4), so
  // the Telemetry tab requires a time window whenever this path is used.
  const telemetryKeys = (assetIds || []).map(toTelemetryKey).filter(Boolean);

  // An empty set means "a tag that matches no device", which must return nothing rather than
  // silently widening to the whole fleet. Checked before the query is built so no request is
  // issued at all.
  if (!telemetryKey && assetIds && telemetryKeys.length === 0) return [];

  let query = supabase.from('telemetry').select('*');
  if (telemetryKey) query = query.eq('asset_id', telemetryKey);
  else if (assetIds) query = query.in('asset_id', telemetryKeys);
  if (metricName) query = query.eq('metric_name', metricName);

  // Absolute bounds win over the relative window -- see the parameter note above.
  if (fromTime || toTime) {
    if (fromTime) query = query.gte('time', fromTime);
    if (toTime)   query = query.lte('time', toTime);
  } else if (Number.isFinite(minutes) && minutes > 0) {
    query = query.gte('time', new Date(Date.now() - minutes * 60000).toISOString());
  }

  const { data, error } = await query
    .order('time', { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) throw error;
  return data || [];
}

/**
 * Collapse a newest-first telemetry page to one row per (asset, metric).
 *
 * Relies on queryTelemetry ordering `time` descending, so the FIRST row seen for a key is the
 * most recent one. Shared by the fleet-wide `/telemetry/latest` (the Overview map) and the
 * device-scoped one (the Devices page's telemetry drawer) so the two cannot disagree about what
 * "latest" means.
 */
function newestPerMetric(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const key = `${row.asset_id}::${row.metric_name}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
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
 * dereferenceable by a viewer holding no Factory+ session, which a signed URL would not be.
 * Writes are gated by RLS to Administrator/Shopfloor_Manager (migration 0035).
 */
export const MODEL_3D_BUCKET = 'asset-3d-models';

/** The public URL for a stored model path. Composed, never stored -- see migration 0035. */
export function model3dPublicUrl(path) {
  if (!path) return null;
  return supabase.storage.from(MODEL_3D_BUCKET).getPublicUrl(path).data.publicUrl;
}

export const api = {
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

  get: async (path, options = {}) => {
    const entityDigitalThreadMatch = path.match(/\/api\/v1\/(cells|gateways|devices|assets)\/([^/]+)\/digital-thread/);
    if (entityDigitalThreadMatch) {
      const rawEntityType = entityDigitalThreadMatch[1];
      const entityId = entityDigitalThreadMatch[2];
      const SINGULAR_MAP = { cells: 'cell', gateways: 'gateway', devices: 'device', assets: 'device' };
      const singularType = SINGULAR_MAP[rawEntityType] || rawEntityType.replace(/s$/, '');

      let query = supabase.from('digital_thread').select('*').eq('entity_id', entityId);
      const { data, error } = await query.order('recorded_at', { ascending: false });
      if (error) throw error;

      const filtered = (data || []).filter(t => {
        if (!t.entity_type) return true;
        const et = t.entity_type.toLowerCase();
        return et === singularType || et === rawEntityType || et === `${singularType}s`;
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
        auto_delete_at: g.auto_delete_at
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
      const rows = await queryTelemetry({
        assetId: match[1],
        minutes,
        limit: TELEMETRY_MAX_ROWS
      });
      return newestPerMetric(rows);
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
          .select('*, gateways(id, name, cell_id, location_scope, status, is_archived)')
          .order('created_at', { ascending: false }),
        loadDeviceLocations()
      ]);
      if (error) throw error;

      // The schemas attached through device_submodels (migration 0034), one AAS Submodel each.
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

      // A tag that matches no device must return nothing rather than everything.
      if (entityIds && entityIds.length === 0) return [];

      let query = supabase.from('digital_thread').select('*');

      if (entityType) {
        // The trigger writes TG_TABLE_NAME -- 'cells' / 'gateways' / 'devices'. The UI has always
        // offered 'CELL' / 'GATEWAY' / 'DEVICE', so even an honoured exact match would never have
        // hit. Normalise to the stored form.
        const stored = { CELL: 'cells', GATEWAY: 'gateways', DEVICE: 'devices' }[entityType.toUpperCase()];
        query = query.eq('entity_type', stored || entityType);
      }
      if (entityIds) query = query.in('entity_id', entityIds);
      if (['INSERT', 'UPDATE', 'DELETE'].includes(action)) query = query.eq('action', action);
      if (Number.isFinite(limit) && limit > 0) query = query.limit(limit);

      const { data, error } = await query.order('recorded_at', { ascending: false });
      if (error) throw error;

      const rows = (data || []).map(mapDigitalThreadRow);
      if (!search) return rows;

      // Substring match, applied after mapping so it searches the rendered description rather
      // than the raw columns -- that is what the field's placeholder promises.
      const needle = search.toLowerCase();
      return rows.filter(r =>
        String(r.entity_id || '').toLowerCase().includes(needle) ||
        String(r.description || '').toLowerCase().includes(needle)
      );
    }

    if (path.startsWith('/api/v1/quarantine')) {
      // The gateway's cell and scope are selected, not just its name: mapDeviceRow resolves the
      // device's location from them, and an embed that omitted them would report every
      // quarantined device as unassigned even when the edge node it arrived on has a cell. That
      // is what the approval modal has to show to be worth showing at all.
      const { data, error } = await supabase
        .from('devices')
        .select('*, gateways(id, name, cell_id, location_scope)')
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

    if (path.startsWith('/api/v1/documents')) {
      const url = new URL(path, window.location.origin);
      const entityType = url.searchParams.get('entity_type');
      const entityId = url.searchParams.get('entity_id');
      let query = supabase.from('documents').select('*');
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
      // semantic_id is the concept-level local IRI added by migration 0032 -- distinct from the
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
        // Versioning (migration 0037). Defaulted here as well as in the column, so a client
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

    if (path.startsWith('/api/v1/directory')) {
      const { data, error } = await supabase.from('directory_services').select('*').order('service_name', { ascending: true });
      if (error) throw error;
      return (data || []).map(s => ({
        service_uuid: s.id,
        service_name: s.service_name,
        service_type: s.service_type,
        endpoint_url: s.endpoint_url,
        status: s.status,
        last_heartbeat: s.last_heartbeat
      }));
    }

    if (path.startsWith('/api/v1/stats')) {
      const [qRes, docRes] = await Promise.all([
        supabase.from('devices').select('id', { count: 'exact', head: true }).eq('is_quarantined', true),
        supabase.from('documents').select('id', { count: 'exact', head: true })
      ]);
      return {
        quarantine_pending: qRes.count || 0,
        documents_attached: docRes.count || 0
      };
    }

    // Latest value per (device, metric) inside a bounded recent window. Used by the
    // Overview map, which only needs current state -- not the full history the
    // export dialog pages through.
    if (path.startsWith('/api/v1/telemetry/latest')) {
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '60', 10);
      const rows = await queryTelemetry({ minutes, limit: 1000 });
      return newestPerMetric(rows);
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
        offset: Number.parseInt(url.searchParams.get('offset') || '', 10)
      });
    }

    throw new Error('Unhandled API path: ' + path);
  },

  post: async (path, body, options = {}) => {
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
        grafana_url: body.access_url
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/gateways') {
      const { data, error } = await supabase.from('gateways').insert({
        name: body.gateway_name,
        access_url: body.access_url,
        is_virtual: !!body.is_virtual,
        status: body.status || 'OFFLINE',
        ...locationFieldsFrom(body)
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/devices') {
      const { data, error } = await supabase.from('devices').insert({
        name: body.asset_name,
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

    if (path === '/api/v1/documents') {
      const { data, error } = await supabase.from('documents').insert({
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        display_name: body.display_name,
        url: body.url,
        document_tag: body.document_tag || 'other'
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
      const { data, error } = await supabase.from('metric_catalog').insert({
        name: body.name,
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

    // Versioning (migration 0037). Both of these are RPCs rather than table writes, and that is
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

    if (path.startsWith('/api/v1/gitops/deploy-flow')) {
      const { data, error } = await supabase.functions.invoke('deploy-nodered', { body });
      if (error) {
        // Replace supabase-js's generic non-2xx message with the server's own.
        throw new Error(await edgeFunctionErrorMessage(error, 'GitOps flow deployment failed'));
      }
      return {
        status: data?.status || 'SUCCESS',
        message: data?.message || 'GitOps edge deployment flow sync triggered successfully',
      };
    }

    if (path.startsWith('/api/v1/devices/aas-export')) {
      // Phase 3 of the AAS roadmap. The whole document is composed server-side: the shell needs
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
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
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

    if (path.startsWith('/api/v1/documents/')) {
      const id = path.split('/')[4];
      const { data, error } = await supabase.from('documents').update({
        display_name: body.display_name,
        url: body.url,
        document_tag: body.document_tag || 'other',
        updated_at: new Date().toISOString()
      }).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    const parts = path.split('/');
    const id = parts[parts.length - 1];

    // Editing a DRAFT version's metric set. There is deliberately no status guard here beyond
    // sending only the editable keys: `prevent_active_schema_mutation()` (migration 0037) is what
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
        grafana_url: body.access_url
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
      if ('is_virtual' in body)  patch.is_virtual = !!body.is_virtual;
      // Same pairing rule as devices: marking a gateway Site-Wide clears its cell rather than
      // letting the CHECK reject the write. is_virtual is NOT what decides this -- a virtual
      // gateway is a deployment fact, site-wide is an operator's assertion about location, and
      // conflating them would relocate assets on a checkbox.
      Object.assign(patch, locationFieldsFrom(body));

      const { data, error } = await supabase.from('gateways').update(patch).eq('id', id).select();
      if (error) throw error;
      return data[0];
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
      if ('connection_method' in body) patch.connection_method = emptyToNull(body.connection_method);
      if ('schema_id' in body) patch.schema_id = emptyToNull(body.schema_id);
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

  delete: async (path, options = {}) => {
    if (path.startsWith('/api/v1/documents/')) {
      const id = path.split('/')[4];
      const { error } = await supabase.from('documents').delete().eq('id', id);
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
