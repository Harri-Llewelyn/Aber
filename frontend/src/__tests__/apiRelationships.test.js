import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the asset relationship + telemetry read/write paths:
 *  - cells -> gateways -> devices arrive as nested embeds (devices have no cell_id)
 *  - a device's gateway is written from `active_gateway_id`, the key the UI actually sends
 *  - telemetry is read from the TimescaleDB-backed `telemetry` view with real filters
 */

// Recording stub for the PostgREST query builder. Each `from()` starts a fresh chain and
// pushes the resulting call record onto `calls`.
const state = { calls: [], responses: {} };

function makeBuilder(table) {
  const record = { table, select: null, filters: [], range: null, order: null, payload: null, op: null };
  state.calls.push(record);

  const resolve = () => Promise.resolve(state.responses[table] ?? { data: [], error: null });

  const builder = {
    select: (cols) => { record.select = cols ?? '*'; return builder; },
    insert: (payload) => { record.op = 'insert'; record.payload = payload; return builder; },
    update: (payload) => { record.op = 'update'; record.payload = payload; return builder; },
    delete: () => { record.op = 'delete'; return builder; },
    eq: (col, val) => { record.filters.push(['eq', col, val]); return builder; },
    gte: (col, val) => { record.filters.push(['gte', col, val]); return builder; },
    limit: (n) => { record.filters.push(['limit', n]); return builder; },
    order: (col, opts) => { record.order = [col, opts]; return builder; },
    range: (from, to) => { record.range = [from, to]; return resolve(); },
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected)
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => makeBuilder(table)),
    functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) }
  }
}));

const { api } = await import('../api');

const callFor = (table) => state.calls.find(c => c.table === table);

beforeEach(() => {
  state.calls = [];
  state.responses = {};
});

describe('cell -> gateway -> device relationships', () => {
  it('requests gateways and their devices as a nested embed on cells', async () => {
    await api.get('/api/v1/cells');
    expect(callFor('cells').select).toMatch(/gateways\(.*devices\(.*\).*\)/s);
  });

  it('flattens each cell to its gateways and the devices reachable through them', async () => {
    state.responses.cells = {
      data: [{
        id: 'cell-1',
        name: 'Assembly',
        gateways: [
          { id: 'gw-1', name: 'GW One', cell_id: 'cell-1', status: 'ONLINE', devices: [
            { id: 'dev-1', name: 'CNC_01', status: 'ONLINE', gateway_id: 'gw-1' },
            { id: 'dev-2', name: 'CNC_02', status: 'OFFLINE', gateway_id: 'gw-1' }
          ] },
          { id: 'gw-2', name: 'GW Two', cell_id: 'cell-1', status: 'OFFLINE', devices: [] }
        ]
      }],
      error: null
    };

    const [cell] = await api.get('/api/v1/cells');

    expect(cell.cell_id).toBe('cell-1');
    expect(cell.gateway_count).toBe(2);
    expect(cell.device_count).toBe(2);
    expect(cell.gateways.map(g => g.gateway_name)).toEqual(['GW One', 'GW Two']);
    expect(cell.gateways[0].device_count).toBe(2);
    // Devices carry their resolved gateway, which the cell card renders instead of a UUID.
    expect(cell.devices.map(d => d.asset_name)).toEqual(['CNC_01', 'CNC_02']);
    expect(cell.devices[0].gateway_name).toBe('GW One');
    expect(cell.devices[0].active_gateway_id).toBe('gw-1');
  });

  it('returns each gateway with its assigned devices and a device count', async () => {
    state.responses.gateways = {
      data: [{ id: 'gw-1', name: 'GW One', status: 'ONLINE', last_heartbeat: '2026-01-01T00:00:00Z', devices: [
        { id: 'dev-1', name: 'CNC_01', status: 'ONLINE', gateway_id: 'gw-1' }
      ] }],
      error: null
    };

    const [gateway] = await api.get('/api/v1/gateways');

    expect(callFor('gateways').select).toMatch(/devices\(/);
    expect(gateway.gateway_id).toBe('gw-1');
    expect(gateway.device_count).toBe(1);
    expect(gateway.devices[0].asset_name).toBe('CNC_01');
    expect(gateway.last_heartbeat).toBe('2026-01-01T00:00:00Z');
  });

  it('derives a device cell from its gateway', async () => {
    state.responses.devices = {
      data: [{ id: 'dev-1', name: 'CNC_01', gateway_id: 'gw-1', gateways: { id: 'gw-1', name: 'GW One', cell_id: 'cell-1' } }],
      error: null
    };

    const [device] = await api.get('/api/v1/devices');

    expect(device.cell_id).toBe('cell-1');
    expect(device.gateway_name).toBe('GW One');
    expect(device.active_gateway_id).toBe('gw-1');
  });
});

describe('device gateway assignment', () => {
  it('writes gateway_id from active_gateway_id on update', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', active_gateway_id: 'gw-9' });
    expect(callFor('devices').payload).toMatchObject({ name: 'CNC_01', gateway_id: 'gw-9' });
  });

  it('writes gateway_id from active_gateway_id on insert', async () => {
    await api.post('/api/v1/devices', { asset_name: 'CNC_02', active_gateway_id: 'gw-9' });
    expect(callFor('devices').payload).toMatchObject({ name: 'CNC_02', gateway_id: 'gw-9' });
  });

  it('clears the gateway when unassigned rather than sending an empty string', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', active_gateway_id: '' });
    expect(callFor('devices').payload.gateway_id).toBeNull();
  });

  it('leaves gateway_id untouched when the caller does not mention it', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'Renamed' });
    expect(callFor('devices').payload).not.toHaveProperty('gateway_id');
  });
});

describe('device DBIRTH parameters', () => {
  // asset_config is keyed by sparkplug_id. That value is a generated column derived from the
  // device's UUID primary key, so the UI derives it locally instead of querying for it --
  // 'ccd19944-8805-4c11-ae66-ea0d2c50f40c' -> 'dev' + the first 21 unhyphenated hex chars.
  const DEVICE_UUID = 'ccd19944-8805-4c11-ae66-ea0d2c50f40c';
  const DEVICE_SPARKPLUG_ID = 'devccd1994488054c11ae66e';

  it('looks up asset_config by the device sparkplug_id, derived from its UUID', async () => {
    await api.get(`/api/v1/devices/${DEVICE_UUID}/config`);

    const call = callFor('asset_config');
    expect(call.filters).toContainEqual(['eq', 'asset_id', DEVICE_SPARKPLUG_ID]);
    expect(call.order).toEqual(['metric_name', { ascending: true }]);
  });

  it('resolves the sparkplug_id without a devices round-trip', async () => {
    await api.get(`/api/v1/devices/${DEVICE_UUID}/config`);
    expect(callFor('devices')).toBeUndefined();
  });

  it('returns the stored birth parameters', async () => {
    state.responses.asset_config = {
      data: [{ asset_id: DEVICE_SPARKPLUG_ID, metric_name: 'firmware_version', val_string: 'v3.2.0-industrial', datatype: 12 }],
      error: null
    };

    const rows = await api.get(`/api/v1/devices/${DEVICE_UUID}/config`);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric_name: 'firmware_version', val_string: 'v3.2.0-industrial', datatype: 12 });
  });
});

describe('telemetry queries', () => {
  it('reads the telemetry view with filters, ordering and a bounded page', async () => {
    await api.get('/api/v1/telemetry?metric_name=temperature&minutes=15&limit=200&offset=200');

    const call = callFor('telemetry');
    expect(call.filters).toContainEqual(['eq', 'metric_name', 'temperature']);
    expect(call.filters.some(([op, col]) => op === 'gte' && col === 'time')).toBe(true);
    expect(call.order).toEqual(['time', { ascending: false }]);
    expect(call.range).toEqual([200, 399]);
  });

  it('defaults to a 500-row page when no limit is supplied', async () => {
    await api.get('/api/v1/telemetry');
    expect(callFor('telemetry').range).toEqual([0, 499]);
  });

  it('resolves a device UUID filter to the sparkplug_id the hypertable stores', async () => {
    await api.get('/api/v1/telemetry?asset_id=ccd19944-8805-4c11-ae66-ea0d2c50f40c');

    expect(callFor('telemetry').filters).toContainEqual(['eq', 'asset_id', 'devccd1994488054c11ae66e']);
  });

  it('passes a non-UUID asset filter straight through', async () => {
    await api.get('/api/v1/telemetry?asset_id=Simulated_CNC_01');
    expect(callFor('telemetry').filters).toContainEqual(['eq', 'asset_id', 'Simulated_CNC_01']);
  });

  it('reduces the latest endpoint to one row per device and metric', async () => {
    state.responses.telemetry = {
      data: [
        { time: '2026-01-01T00:00:20Z', asset_id: 'CNC_01', metric_name: 'temperature', val_double: 42 },
        { time: '2026-01-01T00:00:10Z', asset_id: 'CNC_01', metric_name: 'temperature', val_double: 41 },
        { time: '2026-01-01T00:00:15Z', asset_id: 'CNC_01', metric_name: 'status', val_string: 'RUNNING' }
      ],
      error: null
    };

    const rows = await api.get('/api/v1/telemetry/latest?minutes=60');

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.metric_name === 'temperature').val_double).toBe(42);
  });

  it('propagates query errors instead of returning placeholder rows', async () => {
    state.responses.telemetry = { data: null, error: { message: 'relation "telemetry" does not exist' } };
    await expect(api.get('/api/v1/telemetry')).rejects.toMatchObject({ message: expect.stringContaining('telemetry') });
  });
});
