import { supabase } from './lib/supabaseClient';

let __globalToken = null;

export const setGlobalToken = (token) => {
  __globalToken = token;
};

export const getGlobalToken = () => __globalToken;

export const api = {
  get: async (path, options = {}) => {
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

    if (path.startsWith('/api/v1/digital-thread')) {
      const { data, error } = await supabase.from('digital_thread').select('*').order('recorded_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(t => ({
        ...t,
        event_id: t.id,
        timestamp: t.recorded_at,
        event_type: t.action,
        description: `Action ${t.action} on ${t.entity_type} [${t.entity_id}]`,
        metadata: { old_data: t.old_data, new_data: t.new_data, changed_by: t.changed_by }
      }));
    }

    if (path.startsWith('/api/v1/quarantine')) {
      const { data, error } = await supabase.from('devices').select('*').eq('is_quarantined', true);
      if (error) throw error;
      return (data || []).map(d => ({
        ...d,
        asset_id: d.name
      }));
    }

    throw new Error('Unhandled API path: ' + path);
  },

  post: async (path, body, options = {}) => {
    if (path.includes('/archive')) {
      const parts = path.split('/');
      const entityType = parts[3]; // 'cells', 'gateways', or 'devices'
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;
      const now = new Date().toISOString();
      const days = body?.auto_delete_days;
      const auto_delete_at = days ? new Date(Date.now() + days * 86400000).toISOString() : null;

      const { data, error } = await supabase
        .from(table)
        .update({ is_archived: true, archived_at: now, auto_delete_at })
        .or(`id.eq.${id},name.eq.${id}`)
        .select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/restore')) {
      const parts = path.split('/');
      const entityType = parts[3]; // 'cells', 'gateways', or 'devices'
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;

      const { data, error } = await supabase
        .from(table)
        .update({ is_archived: false, archived_at: null, auto_delete_at: null })
        .or(`id.eq.${id},name.eq.${id}`)
        .select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path === '/api/v1/cells') {
      const { data, error } = await supabase.from('cells').insert({
        name: body.cell_name,
        grafana_url: body.access_url
      }).select();
      if (error) throw error;
      return data[0];
    }

    if (path === '/api/v1/gateways') {
      const { data, error } = await supabase.from('gateways').insert({
        name: body.gateway_name,
        access_url: body.access_url,
        cell_id: body.cell_id
      }).select();
      if (error) throw error;
      return data[0];
    }

    if (path === '/api/v1/devices') {
      const { data, error } = await supabase.from('devices').insert({
        name: body.asset_name,
        gateway_id: body.gateway_id,
        status: body.status || 'ONLINE'
      }).select();
      if (error) throw error;
      return data[0];
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

      const { data, error } = await supabase
        .from(table)
        .update({ is_archived: true, archived_at: now, auto_delete_at })
        .or(`id.eq.${id},name.eq.${id}`)
        .select();
      if (error) throw error;
      return data[0] || {};
    }

    if (path.includes('/restore')) {
      const parts = path.split('/');
      const entityType = parts[3];
      const id = parts[4];
      const table = entityType === 'assets' ? 'devices' : entityType;

      const { data, error } = await supabase
        .from(table)
        .update({ is_archived: false, archived_at: null, auto_delete_at: null })
        .or(`id.eq.${id},name.eq.${id}`)
        .select();
      if (error) throw error;
      return data[0] || {};
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
