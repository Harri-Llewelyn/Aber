import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the asset relationship and telemetry read/write paths: cells -> gateways
 * arrive as a nested embed and a cell's devices are bucketed by effective cell; `cell_id` on a
 * device row is the explicit override and `effective_cell_id` is resolved; a device's gateway is
 * written from `active_gateway_id`; telemetry is read from the `telemetry` view with real filters.
 */

// Recording stub for the PostgREST query builder. Each `from()` starts a fresh chain and pushes the
// call record onto `calls`. `rpcCalls` is separate so `callFor('digital_thread')` still means the
// table was queried.
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
          truncated: false,
          // Only when a test asks for one. A server without 0115 returns no such key at all, and
          // the attachment has to tell that apart from a total of zero.
          ...(state.responses.digital_thread?.total_matching !== undefined
            ? { total_matching: state.responses.digital_thread.total_matching }
            : {})
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

  /**
   * The two ways a gateway row reaches the frontend must agree about what a gateway is. The
   * gateways query selects `*`; the embed names its columns, so a column load-bearing for what a
   * page claims has to be named there too or it arrives `undefined` -- which reads as absent rather
   * than as unselected, and fails quiet in the direction that looks like a data problem.
   */
  it('names in the gateway embed every column a page decides what to render from', async () => {
    await api.get('/api/v1/cells');
    const embed = callFor('cells').select;
    for (const column of ['enrolled_at', 'forge_repository_at']) {
      expect(embed).toContain(column);
    }
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

    // A cell's device membership is not returned: it is the resolved effective cell, which no embed
    // can express. Callers group what they hold via groupDevicesByCell().
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
    // The explicit column stays null; overwriting it with the gateway's cell would make a form
    // round-trip write the inherited value back as an override.
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
    // A host-run gateway is a deployment fact; site-wide is an operator's claim about location.
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

/**
 * Liveness is OBSERVED. Ingestion writes ONLINE on a DBIRTH and the column defaults to OFFLINE;
 * the UI registers a device and says nothing at all about whether it is running.
 *
 * The defect these lock down: the insert defaulted `status` to 'ONLINE' when the caller sent none,
 * and no caller ever sent one -- so every device ever registered through the UI was drawn green
 * before it had connected, and stayed green, because the liveness watchdog only times out devices
 * it has actually heard from. 0119 adds the constraint that refuses such a row outright.
 */
describe('device liveness is never asserted by the UI', () => {
  it('sends no status at all when registering a device, so the column default stands', async () => {
    await api.post('/api/v1/devices', { asset_name: 'KUKA_r2e', active_gateway_id: 'gw-9' });
    expect(callFor('devices').payload).not.toHaveProperty('status');
  });

  it('sends no status on an ordinary edit either', async () => {
    // The device form sends name, gateway, schema and location. An unguarded `status: body.status`
    // here is one careless caller away from writing the same lie through the edit path.
    await api.put('/api/v1/devices/dev-1', { asset_name: 'KUKA_r2e', schema_id: 'schema-1' });
    expect(callFor('devices').payload).not.toHaveProperty('status');
    expect(callFor('devices').payload).not.toHaveProperty('is_quarantined');
  });

  it('still writes a status the caller does state, so the quarantine paths keep working', async () => {
    await api.put('/api/v1/devices/dev-1', { asset_name: 'CNC_01', status: 'OFFLINE', is_quarantined: false });
    expect(callFor('devices').payload).toMatchObject({ status: 'OFFLINE', is_quarantined: false });
  });
});

describe('device DBIRTH parameters', () => {
  // asset_config is keyed by sparkplug_id, a generated column derived from the device's UUID, so
  // the UI derives it locally: 'dev' + the first 21 unhyphenated hex chars.
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

describe('a metric is deprecated and restored (#468)', () => {
  const written = { data: [{ id: 'm9' }], error: null };

  it('restores by clearing the flag and the replacement pointer together', async () => {
    state.responses.metric_catalog = written;
    await api.post('/api/v1/metric-catalog/m9/restore');

    const call = callFor('metric_catalog');
    expect(call.op).toBe('update');
    expect(call.payload).toEqual({ deprecated: false, superseded_by: null });
    expect(call.filters).toContainEqual(['eq', 'id', 'm9']);
  });

  it('is not taken by the generic archive restore, which would write is_archived', async () => {
    state.responses.metric_catalog = written;
    await api.post('/api/v1/metric-catalog/m9/restore');
    expect(state.calls.map(c => c.table)).toEqual(['metric_catalog']);
  });

  it('deprecates with the replacement it was given', async () => {
    state.responses.metric_catalog = written;
    await api.post('/api/v1/metric-catalog/m9/deprecate', { superseded_by: 'm2' });
    expect(callFor('metric_catalog').payload).toEqual({ deprecated: true, superseded_by: 'm2' });
  });

  it('treats no row back as refused rather than done', async () => {
    // metric_catalog_update_privileged admits Administrators only; anyone else matches no row and
    // PostgREST reports success with an empty array.
    await expect(api.post('/api/v1/metric-catalog/m9/restore')).rejects.toThrow(/^Metric not restored/);
    await expect(api.post('/api/v1/metric-catalog/m9/deprecate', {})).rejects.toThrow(/^Metric not deprecated/);
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

  // The collapse lives in the database: `public.telemetry_latest` is a view over a remote DISTINCT
  // ON. What is asserted is that the endpoint reads the right relation and still bounds staleness.
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
    // March reading as its current state on the Site Map.
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
  /* The filters are RPC arguments: `digital_thread_page()` hides deleted entities with an anti-join
     PostgREST cannot express. */
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

  it('hides deleted entities unless asked, as a predicate rather than afterwards', async () => {
    // THE ONE THIS MIGRATION EXISTS FOR. Applied in the query, the 200-row budget is spent on rows
    // that will be shown; applied afterwards, it was spent on rows that were then thrown away.
    await api.get('/api/v1/digital-thread');
    expect(rpcArgs().p_include_purged).toBe(false);
    state.rpcCalls.length = 0;
    await api.get('/api/v1/digital-thread?include_purged=true');
    expect(rpcArgs().p_include_purged).toBe(true);
  });

  /* The keyset cursor and the compatibility rule around it. PostgREST resolves an RPC by the
     argument names given, so naming the cursor arguments against a database without them fails with
     "function does not exist" rather than falling back. Omitted, the call matches the
     seven-argument form and the page renders unpaged. */
  it('omits the cursor arguments entirely when there is no cursor', async () => {
    await api.get('/api/v1/digital-thread');
    expect(rpcArgs()).not.toHaveProperty('p_before_recorded_at');
    expect(rpcArgs()).not.toHaveProperty('p_before_id');
  });

  it('sends both halves of the cursor when paging, because recorded_at is not unique', async () => {
    await api.get('/api/v1/digital-thread?before_recorded_at=2026-01-01T00%3A00%3A00Z&before_id=41');
    expect(rpcArgs().p_before_recorded_at).toBe('2026-01-01T00:00:00Z');
    // A NUMBER, not the string off the query. `p_before_id` is bigint and the row comparison
    // against a text argument would not resolve.
    expect(rpcArgs().p_before_id).toBe(41);
  });

  it('ignores a half-cursor rather than sending one', async () => {
    // `(recorded_at, id) < (NULL, 41)` is NULL, which filters out every row -- so a half-cursor
    // reads as "end of thread" on a thread that has plenty. Neither half goes without the other.
    await api.get('/api/v1/digital-thread?before_id=41');
    expect(rpcArgs()).not.toHaveProperty('p_before_id');
    state.rpcCalls.length = 0;
    await api.get('/api/v1/digital-thread?before_recorded_at=2026-01-01T00%3A00%3A00Z');
    expect(rpcArgs()).not.toHaveProperty('p_before_recorded_at');
  });

  it('returns nothing for a tag that matches no device', async () => {
    const rows = await api.get('/api/v1/digital-thread?entity_ids=');
    expect(rows).toEqual([]);
    expect(rpcArgs()).toBeUndefined();
  });

  it('hands the search to the database instead of filtering the page', async () => {
    /* It used to be resolved in the tab against the LIVE lists and sent as `entity_ids`, so a name
       that had been deleted matched nothing there, sent an EMPTY list, and drew an empty thread.
       `p_search` (0115) matches the id and the audit-snapshot fields the timeline labels a lane
       from, where a deleted entity still has a name. */
    await api.get('/api/v1/digital-thread?search=Press_02');
    expect(rpcArgs().p_search).toBe('Press_02');
    expect(rpcArgs().p_entity_ids).toBeNull();
  });

  it('sends no search rather than an empty one', async () => {
    // `''` would be a predicate matching every row through a LIKE, which is the same answer as no
    // filter but arrived at by scanning for it.
    await api.get('/api/v1/digital-thread');
    expect(rpcArgs().p_search).toBeNull();
    await api.get('/api/v1/digital-thread?search=%20%20');
    expect(rpcArgs().p_search).toBeNull();
  });

  it('does not filter the page after the database has answered', async () => {
    /* There used to be a substring match over the rendered `description`, which api.js synthesises
       from the entity type and id -- so it searched the id by a longer route, and no caller ever
       sent the parameter that reached it. A filter applied after the page also makes `rows.length`
       say nothing about whether the database had more. */
    state.responses.digital_thread = {
      data: [
        { id: 1, entity_type: 'devices', entity_id: 'dev-alpha', action: 'INSERT', recorded_at: '2026-01-01T00:00:00Z' },
        { id: 2, entity_type: 'cells', entity_id: 'cell-beta', action: 'UPDATE', recorded_at: '2026-01-01T00:00:01Z' }
      ],
      error: null
    };

    const rows = await api.get('/api/v1/digital-thread?search=ALPHA');
    expect(rows.map(r => r.entity_id)).toEqual(['dev-alpha', 'cell-beta']);
  });

  it('attaches the match total, and tells a missing one from a total of zero', async () => {
    // `total_matching` (0115) is how the page says "200 of 467" rather than "200 events". Zero is
    // a real answer -- a filter that matches nothing -- so the absent case has to be null, or a
    // server without 0115 renders as a thread with no events in it.
    const rows = [{ id: 1, entity_type: 'devices', entity_id: 'dev-a', action: 'INSERT', recorded_at: '2026-01-01T00:00:00Z' }];

    state.responses.digital_thread = { data: rows, total_matching: 467 };
    expect((await api.get('/api/v1/digital-thread')).totalMatching).toBe(467);

    state.responses.digital_thread = { data: [], total_matching: 0 };
    expect((await api.get('/api/v1/digital-thread')).totalMatching).toBe(0);

    state.responses.digital_thread = { data: rows };
    expect((await api.get('/api/v1/digital-thread')).totalMatching).toBeNull();
  });

  it('returns every event when no filter is supplied', async () => {
    state.responses.digital_thread = {
      data: [{ id: 1, entity_type: 'devices', entity_id: 'dev-a', action: 'INSERT', recorded_at: '2026-01-01T00:00:00Z' }],
      error: null
    };
    expect(await api.get('/api/v1/digital-thread')).toHaveLength(1);
  });
});
