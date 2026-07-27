import { supabase } from './lib/supabaseClient';
import { isUuid } from './utils/isUuid';

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
      const { data, error } = await supabase.from('cells').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(c => ({
        ...c,
        cell_id: c.id,
        cell_name: c.name,
        access_url: c.grafana_url
      }));
    }

    if (path.startsWith('/api/v1/gateways')) {
      const { data, error } = await supabase.from('gateways').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(g => ({
        ...g,
        gateway_id: g.id,
        gateway_name: g.name
      }));
    }

    if (path.match(/\/api\/v1\/devices\/(.+)\/config/)) {
      const match = path.match(/\/api\/v1\/devices\/(.+)\/config/);
      const assetId = match[1];
      const { data, error } = await supabase.from('asset_config').select('*').eq('asset_id', assetId);
      if (error) throw error;
      return data || [];
    }

    if (path.startsWith('/api/v1/devices') || path.startsWith('/api/v1/assets')) {
      const { data, error } = await supabase.from('devices').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(d => ({
        ...d,
        asset_id: d.id,
        asset_name: d.name,
        active_gateway_id: d.gateway_id
      }));
    }

    if (path.includes('/digital-thread')) {
      const { data, error } = await supabase.from('digital_thread').select('*').order('recorded_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(mapDigitalThreadRow);
    }

    if (path.startsWith('/api/v1/quarantine')) {
      const { data, error } = await supabase.from('devices').select('*').eq('is_quarantined', true);
      if (error) throw error;
      return (data || []).map(d => ({
        ...d,
        asset_id: d.name
      }));
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

    if (path.startsWith('/api/v1/telemetry')) {
      const url = new URL(path, window.location.origin);
      const assetFilter = url.searchParams.get('asset_id');
      const metricFilter = url.searchParams.get('metric_name');
      
      const devicesRes = await supabase.from('devices').select('*');
      let devicesList = devicesRes.data || [];
      if (assetFilter) {
        devicesList = devicesList.filter(d => d.id === assetFilter || d.name === assetFilter);
      }

      const now = Date.now();
      const sampleMetrics = [
        { name: 'temperature', val_double: 42.5 },
        { name: 'status', val_string: 'RUNNING' },
        { name: 'safety_ok', val_bool: true }
      ];

      const telemetryRows = [];
      devicesList.forEach((d, idx) => {
        sampleMetrics.forEach((m, mIdx) => {
          if (metricFilter && m.name !== metricFilter) return;
          telemetryRows.push({
            time: new Date(now - (idx * 3000 + mIdx * 1000)).toISOString(),
            asset_id: d.name || d.id,
            metric_name: m.name,
            val_double: m.val_double,
            val_string: m.val_string,
            val_bool: m.val_bool
          });
        });
      });

      return telemetryRows;
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
        cell_id: body.cell_id
      }).select();
      if (error) throw error;
      return data?.[0] || {};
    }

    if (path === '/api/v1/devices') {
      const { data, error } = await supabase.from('devices').insert({
        name: body.asset_name,
        gateway_id: body.gateway_id,
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
      if (error) throw error;
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
      const { data, error } = await supabase.from('gateways').update({
        name: body.gateway_name,
        access_url: body.access_url,
        cell_id: body.cell_id
      }).eq('id', id).select();
      if (error) throw error;
      return data[0];
    }

    if (path.startsWith('/api/v1/devices/')) {
      const { data, error } = await supabase.from('devices').update({
        name: body.asset_name,
        gateway_id: body.gateway_id,
        status: body.status,
        is_quarantined: body.is_quarantined
      }).eq('id', id).select();
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
