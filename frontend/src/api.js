import { supabase } from './lib/supabaseClient';

let __globalToken = null;

export const setGlobalToken = (token) => {
  __globalToken = token;
};

export const getGlobalToken = () => __globalToken;

export const api = {
  get: async (path, options = {}) => {
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
    return [];
  },

  post: async (path, body, options = {}) => {
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
    return {};
  },

  put: async (path, body, options = {}) => {
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
    return {};
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
    return true;
  }
};
