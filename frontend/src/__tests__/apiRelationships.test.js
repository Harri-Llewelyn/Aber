import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the asset relationship + telemetry read/write paths:
 *  - cells -> gateways arrive as a nested embed; a cell's DEVICES are bucketed by their
 *    effective cell instead, since an explicit devices.cell_id can override the data path
 *  - `cell_id` on a mapped device row is the explicit override; `effective_cell_id` is resolved
 *  - a device's gateway is written from `active_gateway_id`, the key the UI actually sends
 *  - telemetry is read from the TimescaleDB-backed `telemetry` view with real filters
 */

// Recording stub for the PostgREST query builder. Each `from()` starts a fresh chain and
// pushes the resulting call record onto `calls`.
// `rpcCalls` is separate from `calls` because they answer different questions: `calls` records
// PostgREST table access, `rpcCalls` records the digital_thread_page function the Digital Thread
// moved to in 0039. Keeping them apart means `callFor('digital_thread')` still means "the table
// was queried", which is the assertion that would otherwise quietly start passing again.
const state = { calls: [], rpcCalls: [], responses: {} };

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
    in: (col, vals) => { record.filters.push(['in', col, vals]); return builder; },
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
    // The Digital Thread page is an RPC since 0039. Calls are recorded so the tests below can
    // assert the ARGUMENTS, which is where its filters live now.
    rpc: vi.fn((fn, args) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: {
          events: (state.responses.digital_thread || { data: [] }).data || [],
          purged_assets: 0,
          truncated: false
        },
        error: null
      });
    }),
    functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) }
  }
}));

const { api } = await import('../api');

const callFor = (table) => state.calls.find(c => c.table === table);

beforeEach(() => {
  state.calls = [];
  state.rpcCalls = [];
  state.responses = {};
});

describe('cell -> gateway -> device relationships', () => {
  it('requests gateways and their devices as a nested embed on cells', async () => {
    await api.get('/api/v1/cells');
    expect(callFor('cells').select).toMatch(/gateways\(.*devices\(.*\).*\)/s);
  });

  it('flattens each cell to its gateways, and does not fetch devices to do it', async () => {
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
    expect(cell.gateways.map(g => g.gateway_name)).toEqual(['GW One', 'GW Two']);
    // The gateway's own devices ARE the embed -- that is the data path, and it is a plain FK.
    expect(cell.gateways[0].device_count).toBe(2);
    expect(cell.gateways[0].devices[0].gateway_name).toBe('GW One');

    // A cell's device MEMBERSHIP is not returned: it is the resolved effective cell, which no
    // embed can express, and fetching every device here made each consumer read the device
    // table twice per refresh. Callers group what they already hold, via groupDevicesByCell().
    expect(cell.devices).toBeUndefined();
    expect(cell.device_count).toBeUndefined();
    expect(callFor('devices')).toBeUndefined();
    expect(callFor('device_locations')).toBeUndefined();
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

  it('derives a device cell from its gateway when it has no explicit one', async () => {
    state.responses.devices = {
      data: [{ id: 'dev-1', name: 'CNC_01', gateway_id: 'gw-1', cell_id: null, gateways: { id: 'gw-1', name: 'GW One', cell_id: 'cell-1' } }],
      error: null
    };

    const [device] = await api.get('/api/v1/devices');

    expect(device.effective_cell_id).toBe('cell-1');
    expect(device.location_source).toBe('inherited');
    // The explicit column stays null. It used to be overwritten with the gateway's cell after
    // the row spread, which would now discard the very column it is named after -- and a form
    // round-trip would write the inherited value back as an explicit override.
    expect(device.cell_id).toBeNull();
    expect(device.gateway_name).toBe('GW One');
    expect(device.active_gateway_id).toBe('gw-1');
  });

  it('lets an explicit device cell override the gateway, and flags the disagreement', async () => {
    state.responses.devices = {
      data: [{ id: 'dev-1', name: 'CNC_01', gateway_id: 'gw-1', cell_id: 'cell-9', gateways: { id: 'gw-1', name: 'GW One', cell_id: 'cell-1' } }],
      error: null
    };

    const [device] = await api.get('/api/v1/devices');

    expect(device.effective_cell_id).toBe('cell-9');
    expect(device.cell_id).toBe('cell-9');
    expect(device.location_source).toBe('explicit');
    expect(device.cell_mismatch).toBe(true);
  });

});

describe('writing an asset location', () => {
  it('writes an explicit cell on update', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', cell_id: 'cell-9' });
    expect(callFor('devices').payload).toMatchObject({ cell_id: 'cell-9' });
  });

  it('clears the cell back to inherit rather than sending an empty string', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', cell_id: '' });
    expect(callFor('devices').payload.cell_id).toBeNull();
  });

  it('never touches cell_id when the caller does not mention it', async () => {
    // Reassigning a gateway must not silently relocate the asset.
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', active_gateway_id: 'gw-9' });
    expect('cell_id' in callFor('devices').payload).toBe(false);
    expect('location_scope' in callFor('devices').payload).toBe(false);
  });

  it('omits cell_id entirely on insert when none was chosen, so inheritance stays reachable', async () => {
    await api.post('/api/v1/devices', { asset_name: 'CNC_02', active_gateway_id: 'gw-9' });
    expect('cell_id' in callFor('devices').payload).toBe(false);
  });

  it('clears the cell when an asset is marked Site-Wide, rather than letting the CHECK reject it', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'BMS', location_scope: 'site_wide', cell_id: 'cell-9' });
    expect(callFor('devices').payload).toMatchObject({ location_scope: 'site_wide', cell_id: null });
  });

  it('applies the same pairing rule to gateways', async () => {
    await api.put('/api/v1/gateways/gw-1', { gateway_name: 'Virtual', location_scope: 'site_wide', cell_id: 'cell-1' });
    expect(callFor('gateways').payload).toMatchObject({ location_scope: 'site_wide', cell_id: null });
  });

  it('normalises an unrecognised scope to cell rather than writing it through', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', location_scope: 'nonsense' });
    expect(callFor('devices').payload.location_scope).toBe('cell');
  });

  it('does not treat deployment as a location assertion', async () => {
    // A virtual gateway is a deployment fact; site-wide is an operator's claim about location.
    await api.put('/api/v1/gateways/gw-1', { gateway_name: 'Virtual', deployment: 'host', cell_id: 'cell-1' });
    expect(callFor('gateways').payload).toMatchObject({ deployment: 'host', cell_id: 'cell-1' });
    expect('location_scope' in callFor('gateways').payload).toBe(false);
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

  // THE COLLAPSE MOVED INTO THE DATABASE. `public.telemetry_latest` is a view over a remote
  // DISTINCT ON, so the endpoint no longer fetches a window and keeps the first row per key --
  // that transferred a day of rows through postgres_fdw to end up with about ten. What is asserted
  // now is that it reads the right relation and still bounds staleness; asserting a local collapse
  // would be asserting logic that should no longer exist.
  it('reads the latest endpoint from telemetry_latest, not from a raw window', async () => {
    state.responses.telemetry_latest = {
      data: [
        { time: '2026-01-01T00:00:20Z', asset_id: 'CNC_01', metric_name: 'temperature', val_double: 42 },
        { time: '2026-01-01T00:00:15Z', asset_id: 'CNC_01', metric_name: 'status', val_string: 'RUNNING' }
      ],
      error: null
    };

    const rows = await api.get('/api/v1/telemetry/latest?minutes=60');

    const call = callFor('telemetry_latest');
    expect(call).toBeTruthy();
    // Still bounded: dropping the window would let a machine that last reported in March show a
    // March reading as its current state on the Overview map.
    expect(call.filters.some(([op, col]) => op === 'gte' && col === 'time')).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.metric_name === 'temperature').val_double).toBe(42);
  });

  it('reads a rollup when a resolution is asked for, and refuses an unknown one', async () => {
    state.responses.telemetry_5m = { data: [], error: null };
    await api.get('/api/v1/telemetry?resolution=5m&asset_id=dev200000000000400080000');
    const call = callFor('telemetry_5m');
    expect(call).toBeTruthy();
    // The rollup's time column is `bucket`, not `time`.
    expect(call.filters.some(([op, col]) => op === 'gte' && col === 'bucket')).toBe(true);

    // An unknown resolution must NOT fall back to raw: answering a request for a year of hourly
    // buckets by scanning a year of raw rows is the failure this whole change exists to prevent.
    await expect(api.get('/api/v1/telemetry?resolution=30s')).rejects.toThrow(/unknown telemetry resolution/);
  });

  it('propagates query errors instead of returning placeholder rows', async () => {
    state.responses.telemetry = { data: null, error: { message: 'relation "telemetry" does not exist' } };
    await expect(api.get('/api/v1/telemetry')).rejects.toMatchObject({ message: expect.stringContaining('telemetry') });
  });
});

describe('telemetry filtering by device tag', () => {
  it('expands asset_ids into a single IN over the telemetry view', async () => {
    // A tag filter resolves to a whole group of devices client-side, because a device's tags are
    // derived from its schema and the database does not model them.
    await api.get('/api/v1/telemetry?asset_ids=dev200000000000400080000,dev300000000000400080000');
    expect(callFor('telemetry').filters).toContainEqual([
      'in', 'asset_id', ['dev200000000000400080000', 'dev300000000000400080000']
    ]);
  });

  it('translates device UUIDs in asset_ids to Sparkplug keys', async () => {
    // telemetry.asset_id is keyed by sparkplug_id; the UI works in UUIDs. Same local derivation
    // as the single-device path: 'dev' + the first 21 unhyphenated hex characters.
    await api.get('/api/v1/telemetry?asset_ids=ccd19944-8805-4c11-ae66-ea0d2c50f40c');
    const [, , keys] = callFor('telemetry').filters.find(f => f[0] === 'in');
    expect(keys).toEqual(['devccd1994488054c11ae66e']);
  });

  it('returns nothing — not everything — for a tag that matches no device', async () => {
    // The failure mode this guards: an empty IN list silently widening to the whole fleet.
    const rows = await api.get('/api/v1/telemetry?asset_ids=');
    expect(rows).toEqual([]);
    expect(callFor('telemetry')).toBeUndefined();
  });

  it('lets an explicitly chosen device win over a tag', async () => {
    await api.get('/api/v1/telemetry?asset_id=dev200000000000400080000&asset_ids=dev300000000000400080000');
    const filters = callFor('telemetry').filters;
    expect(filters).toContainEqual(['eq', 'asset_id', 'dev200000000000400080000']);
    expect(filters.find(f => f[0] === 'in')).toBeUndefined();
  });
});

describe('digital thread filtering', () => {
  /*
   * THE FILTERS ARE RPC ARGUMENTS NOW, not query-builder calls. Migration 0039 moved this page to
   * `digital_thread_page()` because hiding deleted assets is an anti-join PostgREST cannot
   * express -- and doing it in the browser instead spent the row limit on rows that were then
   * discarded, which is how a cleared filter bar came to list four assets on a stack of
   * twenty-six. What each test asks is unchanged; where it looks is not.
   */
  const rpcArgs = () => state.rpcCalls.find(c => c.fn === 'digital_thread_page')?.args;

  it('normalises the UI entity type to the table name the trigger records', async () => {
    // log_digital_thread_event() writes TG_TABLE_NAME ('devices'); the dropdown offers 'DEVICE'.
    // An exact match would never have hit even once the parameter was honoured at all.
    await api.get('/api/v1/digital-thread?entity_type=DEVICE');
    expect(rpcArgs().p_entity_type).toBe('devices');
  });

  it('honours the row limit', async () => {
    await api.get('/api/v1/digital-thread?limit=200');
    expect(rpcArgs().p_limit).toBe(200);
  });

  it('restricts to the entity ids carrying a device tag', async () => {
    await api.get('/api/v1/digital-thread?entity_ids=dev-a,dev-b');
    expect(rpcArgs().p_entity_ids).toEqual(['dev-a', 'dev-b']);
  });

  it('hides deleted assets unless asked, as a predicate rather than afterwards', async () => {
    // THE ONE THIS MIGRATION EXISTS FOR. Applied in the query, the 200-row budget is spent on rows
    // that will be shown; applied afterwards, it was spent on rows that were then thrown away.
    await api.get('/api/v1/digital-thread');
    expect(rpcArgs().p_include_purged).toBe(false);
    state.rpcCalls.length = 0;
    await api.get('/api/v1/digital-thread?include_purged=true');
    expect(rpcArgs().p_include_purged).toBe(true);
  });

  it('returns nothing for a tag that matches no device', async () => {
    const rows = await api.get('/api/v1/digital-thread?entity_ids=');
    expect(rows).toEqual([]);
    expect(rpcArgs()).toBeUndefined();
  });

  it('searches entity id and rendered description, case-insensitively', async () => {
    state.responses.digital_thread = {
      data: [
        { id: 1, entity_type: 'devices', entity_id: 'dev-alpha', action: 'INSERT', recorded_at: '2026-01-01T00:00:00Z' },
        { id: 2, entity_type: 'cells', entity_id: 'cell-beta', action: 'UPDATE', recorded_at: '2026-01-01T00:00:01Z' }
      ],
      error: null
    };

    const byId = await api.get('/api/v1/digital-thread?entity_id=ALPHA');
    expect(byId.map(r => r.entity_id)).toEqual(['dev-alpha']);

    const byDescription = await api.get('/api/v1/digital-thread?entity_id=action update');
    expect(byDescription.map(r => r.entity_id)).toEqual(['cell-beta']);
  });

  it('returns every event when no filter is supplied', async () => {
    state.responses.digital_thread = {
      data: [{ id: 1, entity_type: 'devices', entity_id: 'dev-a', action: 'INSERT', recorded_at: '2026-01-01T00:00:00Z' }],
      error: null
    };
    expect(await api.get('/api/v1/digital-thread')).toHaveLength(1);
  });
});
