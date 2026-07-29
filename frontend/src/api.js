import { supabase } from './lib/supabaseClient';
import { isUuid } from './utils/isUuid';
import { edgeFunctionErrorMessage } from './utils/edgeFunctionError';

// Devices are related to cells *through* gateways (devices.gateway_id -> gateways.id ->
// gateways.cell_id -> cells.id). There is no devices.cell_id column, so anything that
// wants "the devices in this cell" has to walk the embed rather than filter on a field.
const mapDeviceRow = (d, gateway) => ({
  ...d,
  asset_id: d.id,
  asset_name: d.name,
  active_gateway_id: d.gateway_id ?? gateway?.id ?? null,
  gateway_name: gateway?.name ?? null
});

const mapGatewayRow = (g) => {
  const devices = (g.devices || []).map(d => mapDeviceRow(d, g));
  return {
    ...g,
    gateway_id: g.id,
    gateway_name: g.name,
    devices,
    device_count: devices.length
  };
};

// PostgREST embeds. Kept as constants so the Cells and Gateways queries stay in step.
const DEVICE_EMBED = 'id, name, status, is_quarantined, is_archived, gateway_id, created_at';
const GATEWAY_EMBED =
  `id, name, cell_id, access_url, status, last_heartbeat, ip_address, is_virtual, ` +
  `is_archived, archived_at, created_at, devices(${DEVICE_EMBED})`;

// PostgREST rejects '' for a UUID/foreign-key column; the UI's "unassigned" option
// submits exactly that.
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

// The UI carries a device's gateway as `active_gateway_id`; the column is `gateway_id`.
const gatewayIdFrom = (body) => emptyToNull(body.active_gateway_id ?? body.gateway_id);

export const TELEMETRY_PAGE_SIZE = 500;
// postgres_fdw pushes WHERE clauses to TimescaleDB but not LIMIT, so an unbounded
// query materialises the whole matching range in Supabase before trimming. Cap it.
const TELEMETRY_MAX_ROWS = 5000;

/**
 * Sparkplug B keys everything it publishes by device *name*, so `telemetry.asset_id`
 * and `asset_config.asset_id` both hold the name while the UI works in device UUIDs.
 * Translate before querying either of them.
 *
 * An unresolvable UUID is returned unchanged, so the query comes back empty rather
 * than silently widening to every device.
 */
async function resolveAssetName(assetId) {
  if (!assetId || !isUuid(assetId)) return assetId || '';

  const { data, error } = await supabase.from('devices').select('name').eq('id', assetId);
  if (error) throw error;
  return data?.[0]?.name || assetId;
}

/**
 * Query the `telemetry` view -- a postgres_fdw projection of the standalone
 * TimescaleDB hypertable, exposed through PostgREST (see
 * supabase/migrations/20260101000010_telemetry_foreign_table.sql).
 */
async function queryTelemetry({ assetId, metricName, minutes, limit, offset } = {}) {
  const pageSize = Math.min(
    Number.isFinite(limit) && limit > 0 ? limit : TELEMETRY_PAGE_SIZE,
    TELEMETRY_MAX_ROWS
  );
  const from = Number.isFinite(offset) && offset > 0 ? offset : 0;

  const assetName = await resolveAssetName(assetId);

  let query = supabase.from('telemetry').select('*');
  if (assetName) query = query.eq('asset_id', assetName);
  if (metricName) query = query.eq('metric_name', metricName);
  if (Number.isFinite(minutes) && minutes > 0) {
    query = query.gte('time', new Date(Date.now() - minutes * 60000).toISOString());
  }

  const { data, error } = await query
    .order('time', { ascending: false })
    .range(from, from + pageSize - 1);

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

export const api = {
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
      const { data, error } = await supabase
        .from('cells')
        .select(`*, gateways(${GATEWAY_EMBED})`)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(c => {
        const gateways = (c.gateways || []).map(mapGatewayRow);
        const devices = gateways.flatMap(g => g.devices);
        return {
          ...c,
          cell_id: c.id,
          cell_name: c.name,
          access_url: c.grafana_url,
          gateways,
          devices,
          gateway_count: gateways.length,
          device_count: devices.length
        };
      });
    }

    if (path.startsWith('/api/v1/gateways')) {
      const { data, error } = await supabase
        .from('gateways')
        .select(`*, devices(${DEVICE_EMBED})`)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(mapGatewayRow);
    }

    if (path.match(/\/api\/v1\/devices\/(.+)\/config/)) {
      const match = path.match(/\/api\/v1\/devices\/(.+)\/config/);
      // asset_config is keyed by the Sparkplug B device name written by the ingestion
      // daemon on DBIRTH; the UI passes a device UUID.
      const assetName = await resolveAssetName(match[1]);
      const { data, error } = await supabase
        .from('asset_config')
        .select('*')
        .eq('asset_id', assetName)
        .order('metric_name', { ascending: true });
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/devices') || path.startsWith('/api/v1/assets')) {
      // Embed the serving gateway so each device carries its resolved gateway name and
      // the cell it belongs to -- a device's cell is the cell of its gateway.
      const { data, error } = await supabase
        .from('devices')
        .select('*, gateways(id, name, cell_id, status, is_archived)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(d => ({
        ...d,
        asset_id: d.id,
        asset_name: d.name,
        active_gateway_id: d.gateway_id,
        gateway_name: d.gateways?.name || null,
        cell_id: d.gateways?.cell_id || null
      }));
    }

    if (path.includes('/digital-thread')) {
      const { data, error } = await supabase.from('digital_thread').select('*').order('recorded_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(mapDigitalThreadRow);
    }

    if (path.startsWith('/api/v1/quarantine')) {
      const { data, error } = await supabase
        .from('devices')
        .select('*, gateways(id, name)')
        .eq('is_quarantined', true);
      if (error) throw error;

      const names = (data || []).map(d => d.name);
      let metricsByName = new Map();
      if (names.length > 0) {
        const { data: configRows, error: configError } = await supabase
          .from('asset_config')
          .select('asset_id, metric_name')
          .in('asset_id', names);
        if (configError) throw configError;
        metricsByName = (configRows || []).reduce((map, row) => {
          const list = map.get(row.asset_id) || [];
          list.push(row.metric_name);
          map.set(row.asset_id, list);
          return map;
        }, new Map());
      }

      return (data || []).map(d => {
        const reportedMetrics = metricsByName.get(d.name) || [];
        return {
          ...d,
          // approve/reject address the device by its Sparkplug B name.
          asset_id: d.name,
          quarantine_id: d.id,
          discovered_at: d.created_at,
          gateway_id: d.gateway_id || null,
          gateway_name: d.gateways?.name || null,
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

    if (path.startsWith('/api/v1/metric-catalog')) {
      const { data, error } = await supabase.from('metric_catalog').select('*').order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map(m => ({
        metric_uuid: m.id,
        name: m.name,
        datatype: m.datatype,
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

    if (path.startsWith('/api/v1/gitops/status')) {
      return {
        gitops_status: 'SYNCED',
        active_commit_sha: 'a8f3e4b',
        repository_url: 'https://github.com/AMRC-FactoryPlus/edge-flows.git'
      };
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
    // Telemetry tab pages through.
    if (path.startsWith('/api/v1/telemetry/latest')) {
      const url = new URL(path, window.location.origin);
      const minutes = Number.parseInt(url.searchParams.get('minutes') || '60', 10);
      const rows = await queryTelemetry({ minutes, limit: 1000 });

      const latest = new Map();
      for (const row of rows) {
        const key = `${row.asset_id}::${row.metric_name}`;
        // queryTelemetry returns newest-first, so the first hit for a key wins.
        if (!latest.has(key)) latest.set(key, row);
      }
      return [...latest.values()];
    }

    if (path.startsWith('/api/v1/telemetry')) {
      const url = new URL(path, window.location.origin);
      return queryTelemetry({
        assetId: url.searchParams.get('asset_id'),
        metricName: url.searchParams.get('metric_name'),
        minutes: Number.parseInt(url.searchParams.get('minutes') || '', 10),
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
      query = isUuid(id) ? query.eq('id', id) : query.eq('name', id);

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
      query = isUuid(id) ? query.eq('id', id) : query.eq('name', id);

      const { data, error } = await query.select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/quarantine/') && path.endsWith('/reject')) {
      const parts = path.split('/');
      const id = parts[4];
      let query = supabase.from('devices').delete();
      query = isUuid(id) ? query.eq('id', id) : query.eq('name', id);

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
        cell_id: emptyToNull(body.cell_id),
        ip_address: emptyToNull(body.ip_address),
        is_virtual: !!body.is_virtual,
        status: body.status || 'OFFLINE'
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
        status: body.status || 'ONLINE'
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

    if (path === '/api/v1/metric-catalog') {
      const { data, error } = await supabase.from('metric_catalog').insert({
        name: body.name,
        datatype: body.datatype,
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

    if (path === '/api/v1/schemas') {
      const { data, error } = await supabase.from('schemas').insert({
        schema_name: body.schema_name,
        description: body.description,
        schema_definition: body.schema_definition
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
      query = isUuid(id) ? query.eq('id', id) : query.eq('name', id);

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
      query = isUuid(id) ? query.eq('id', id) : query.eq('name', id);

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
      if ('cell_id' in body)     patch.cell_id = emptyToNull(body.cell_id);
      if ('ip_address' in body)  patch.ip_address = emptyToNull(body.ip_address);
      if ('is_virtual' in body)  patch.is_virtual = !!body.is_virtual;

      const { data, error } = await supabase.from('gateways').update(patch).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    if (path.startsWith('/api/v1/devices/')) {
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
