import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The approvals queue's read (`GET /api/v1/proposals`): each proposal's subject named from its own
 * table, with the row the patch would change, and a failed subject read degrading to the uuid
 * rather than failing the queue.
 */

// Per-table answers. `failing` answers with a PostgREST error, `throwing` rejects outright.
const state = { calls: [], rows: {}, failing: new Set(), throwing: new Set(), proposers: [] };

function makeBuilder(table) {
  const record = { table, select: null, filters: [] };
  state.calls.push(record);
  const answer = () => {
    if (state.throwing.has(table)) return Promise.reject(new Error('network down'));
    if (state.failing.has(table)) {
      return Promise.resolve({ data: null, error: { message: 'permission denied' } });
    }
    return Promise.resolve({ data: state.rows[table] ?? [], error: null });
  };
  const builder = {
    select: (cols) => { record.select = cols; return builder; },
    in: (col, vals) => { record.filters.push(['in', col, vals]); return builder; },
    order: () => builder,
    then: (onFulfilled, onRejected) => answer().then(onFulfilled, onRejected)
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    from: vi.fn((table) => makeBuilder(table)),
    rpc: vi.fn(() => Promise.resolve({ data: state.proposers, error: null }))
  }
}));

const { api } = await import('../api');
const { KINDS } = await import('../components/tabs/ApprovalsTab');

const CELL_ID = 'c0000000-0000-4000-8000-000000000001';
const GATEWAY_ID = 'a0000000-0000-4000-8000-000000000002';
const AREA_ID = 'e0000000-0000-4000-8000-000000000003';
const DEVICE_ID = 'd0000000-0000-4000-8000-000000000004';
const NORTH_ID = 'e0000000-0000-4000-8000-000000000005';

const proposal = (id, entity_type, entity_id, patch) => ({
  id, entity_type, entity_id, patch, status: 'open',
  proposed_by: 'aaaaaaaa-0000-4000-8000-000000000001', proposed_at: '2026-09-29T09:00:00Z'
});

const cellRow = {
  id: CELL_ID, name: 'Weld Bay', grafana_url: null, icon: 'Factory', area_id: null,
  plan_x: null, plan_y: null, description: 'Robot welding'
};
const gatewayRow = {
  id: GATEWAY_ID, name: 'Line 3 edge', sparkplug_id: 'gwya00000000000400080000', description: null,
  cell_id: CELL_ID, area_id: null, location_scope: 'cell', access_url: null
};
const areaRow = { id: AREA_ID, name: 'North Shop', description: null, icon: 'Factory' };

const queue = () => [
  proposal('p-cell', 'cells', CELL_ID, { area_id: NORTH_ID }),
  proposal('p-gateway', 'gateways', GATEWAY_ID, { access_url: 'https://line3.test' }),
  proposal('p-area', 'areas', AREA_ID, { icon: 'Warehouse' })
];

const byId = (rows) => Object.fromEntries(rows.map(r => [r.id, r]));
const readsOf = (table) => state.calls.filter(c => c.table === table);

beforeEach(() => {
  state.calls = [];
  state.rows = {};
  state.failing = new Set();
  state.throwing = new Set();
  state.proposers = [];
});

describe('the approvals queue names every subject', () => {
  it('names a cell, a gateway and an area, with the row each patch would change', async () => {
    state.rows = {
      change_proposals: queue(), cells: [cellRow], gateways: [gatewayRow], areas: [areaRow]
    };
    const rows = byId(await api.get('/api/v1/proposals'));

    expect(rows['p-cell']).toMatchObject({ target_label: 'Weld Bay', target_missing: false });
    expect(rows['p-cell'].current).toMatchObject({ area_id: null, name: 'Weld Bay' });
    expect(rows['p-gateway']).toMatchObject({ target_label: 'Line 3 edge', target_missing: false });
    expect(rows['p-gateway'].current).toMatchObject({ access_url: null });
    expect(rows['p-area']).toMatchObject({ target_label: 'North Shop', target_missing: false });
    expect(rows['p-area'].current).toMatchObject({ icon: 'Factory' });
  });

  it('names a gateway by its sparkplug id when it has no name', async () => {
    state.rows = {
      change_proposals: [proposal('p-gateway', 'gateways', GATEWAY_ID, { name: 'Line 3 edge' })],
      gateways: [{ ...gatewayRow, name: '' }]
    };
    const [row] = await api.get('/api/v1/proposals');
    expect(row.target_label).toBe('gwya00000000000400080000');
  });

  it('reads each subject table once, for the ids on the page only', async () => {
    state.rows = {
      change_proposals: [...queue(), proposal('p-cell-2', 'cells', CELL_ID, { name: 'Weld Bay 2' })],
      cells: [cellRow], gateways: [gatewayRow], areas: [areaRow]
    };
    await api.get('/api/v1/proposals');

    for (const [table, id] of [['cells', CELL_ID], ['gateways', GATEWAY_ID], ['areas', AREA_ID]]) {
      const reads = readsOf(table);
      expect(reads, table).toHaveLength(1);
      expect(reads[0].filters).toEqual([['in', 'id', [id]]]);
    }
    // No row names a device, a nameplate or a schema, so none of those tables is read.
    expect(readsOf('devices')).toHaveLength(0);
    expect(readsOf('device_nameplate')).toHaveLength(0);
    expect(readsOf('schemas')).toHaveLength(0);
  });

  it('marks a subject whose row is gone, and gives it nothing to diff against', async () => {
    state.rows = { change_proposals: queue(), cells: [], gateways: [gatewayRow], areas: [areaRow] };
    const rows = byId(await api.get('/api/v1/proposals'));

    expect(rows['p-cell']).toMatchObject({ target_label: CELL_ID, target_missing: true, current: null });
    expect(rows['p-gateway'].target_missing).toBe(false);
  });

  it('keeps the uuid when a read fails, without marking the subject missing or failing the queue', async () => {
    state.rows = { change_proposals: queue(), areas: [areaRow] };
    state.failing.add('cells');
    state.throwing.add('gateways');
    const rows = byId(await api.get('/api/v1/proposals'));

    // A failed read is not evidence the subject is gone.
    for (const [id, uuid] of [['p-cell', CELL_ID], ['p-gateway', GATEWAY_ID]]) {
      expect(rows[id], id).toMatchObject({ target_label: uuid, target_missing: false, current: null });
    }
    // The read that worked still resolves.
    expect(rows['p-area'].target_label).toBe('North Shop');
  });

  it('diffs a nameplate with no row yet against an empty one', async () => {
    // The approval creates the row, so an absent nameplate is every field still to be set.
    state.rows = {
      change_proposals: [proposal('p-plate', 'device_nameplate', DEVICE_ID, { serial_number: 'SN-9' })],
      devices: [{ id: DEVICE_ID, name: 'Lathe_01' }],
      device_nameplate: []
    };
    const [row] = await api.get('/api/v1/proposals');
    expect(row).toMatchObject({ target_label: 'Lathe_01', target_missing: false, current: {} });
  });
});

/**
 * The drawer diffs a proposal's patch against `current`, so each lane's read has to carry every
 * column that lane can propose, and the page's kind filter has to offer every lane. Both are read
 * from the migrations, where `proposable_columns()` is the only statement of the lanes.
 */
describe('every lane the database admits', () => {
  const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations');
  const latestProposableColumns = () => {
    let body = null;
    for (const file of fs.readdirSync(MIGRATIONS).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      const m = [...sql.matchAll(
        /CREATE OR REPLACE FUNCTION public\.proposable_columns\(p_entity_type text\)[\s\S]*?\$\$([\s\S]*?)\$\$/g
      )].pop();
      if (m) body = m[1];
    }
    return body;
  };
  const proposableLanes = () => {
    const body = latestProposableColumns();
    expect(body, 'proposable_columns() has moved or been renamed').toBeTruthy();
    const lanes = Object.fromEntries([...body.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)]
      .map(m => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map(c => c[1])]));
    expect(lanes.devices, 'the CASE arms no longer parse').toBeTruthy();
    return lanes;
  };

  it('is offered as a kind in the queue filter', () => {
    expect(KINDS.map(l => l.id).sort()).toEqual(Object.keys(proposableLanes()).sort());
  });

  it('asks its table for every column it can propose', async () => {
    const lanes = proposableLanes();

    state.rows = {
      change_proposals: Object.keys(lanes).map(lane => proposal(`p-${lane}`, lane, `id-${lane}`, {}))
    };
    await api.get('/api/v1/proposals');

    for (const [lane, columns] of Object.entries(lanes)) {
      const read = readsOf(lane)[0];
      expect(read, `${lane} is not read`).toBeTruthy();
      if (read.select === '*') continue;
      const selected = read.select.split(',');
      for (const column of columns) expect(selected, `${lane}.${column}`).toContain(column);
    }
  });
});
