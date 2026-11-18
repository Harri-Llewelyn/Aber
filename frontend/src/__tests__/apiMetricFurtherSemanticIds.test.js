import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A metric's further semantic ids (0299) through the API layer: read beside the catalog rows and
 * tolerated when they cannot be; written in the order the database's rules ask for, with a refusal
 * after the first write saying what was already saved; and the Digital Nameplate reader, which joins
 * on the crosswalk so a metric carrying a Machinery concept as a further id answers for it.
 */

// Recording stub for the PostgREST query builder, as apiRelationships.test.js has it.
const state = { calls: [], responses: {} };

function makeBuilder(table) {
  const record = { table, select: null, filters: [], order: null, payload: null, op: null };
  state.calls.push(record);
  const resolve = () => Promise.resolve(state.responses[table] ?? { data: [], error: null });
  const builder = {
    select: (cols) => { record.select = cols ?? '*'; return builder; },
    insert: (payload) => { record.op = 'insert'; record.payload = payload; return builder; },
    update: (payload) => { record.op = 'update'; record.payload = payload; return builder; },
    delete: () => { record.op = 'delete'; return builder; },
    eq: (col, val) => { record.filters.push(['eq', col, val]); return builder; },
    in: (col, vals) => { record.filters.push(['in', col, vals]); return builder; },
    not: (col, op, val) => { record.filters.push(['not', col, op, val]); return builder; },
    order: (col, opts) => { record.order = [col, opts]; return builder; },
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected)
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => makeBuilder(table)),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) }
  }
}));

const { api } = await import('../api');

const callsOn = (table) => state.calls.filter(c => c.table === table);
const sequence = () => state.calls.map(c => `${c.table}:${c.op || 'select'}`);

const OWN = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003';
const ECLASS = '0112/2///61987#ABA951#009';
const CDD = '0112/2///62683#ACE000#001';

beforeEach(() => {
  state.calls = [];
  state.responses = {};
});

describe('reading the catalog with the further ids beside it', () => {
  const catalog = {
    data: [
      { id: 'm1', name: 'Machine/SERIAL', datatype: 12, semantic_id: OWN, semantic_id_type: 'ExpandedNodeId' },
      { id: 'm2', name: 'Systems/TEMPERATURE', datatype: 10, semantic_id: null }
    ],
    error: null
  };

  it('gives each metric its further ids, by id, with type and source, and none an empty list', async () => {
    state.responses.metric_catalog = catalog;
    state.responses.metric_semantic_ids = {
      data: [
        { metric_id: 'm1', semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' },
        { metric_id: 'm1', semantic_id: CDD, semantic_id_type: 'IRDI', source: null }
      ],
      error: null
    };
    const [serial, temperature] = await api.get('/api/v1/metric-catalog');

    expect(serial.further_semantic_ids).toEqual([
      { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' },
      { semantic_id: CDD, semantic_id_type: 'IRDI', source: null }
    ]);
    expect(temperature.further_semantic_ids).toEqual([]);
    expect(callsOn('metric_semantic_ids')[0].order).toEqual(['semantic_id', { ascending: true }]);
  });

  it('still reads the catalog where the further ids cannot be read', async () => {
    state.responses.metric_catalog = catalog;
    state.responses.metric_semantic_ids = { data: null, error: { message: 'relation "metric_semantic_ids" does not exist' } };
    const rows = await api.get('/api/v1/metric-catalog');

    expect(rows.map(r => r.name)).toEqual(['Machine/SERIAL', 'Systems/TEMPERATURE']);
    expect(rows.map(r => r.further_semantic_ids)).toEqual([[], []]);
  });
});

describe('writing a metric’s further ids', () => {
  const rows = (...ids) => ({ data: ids.map(semantic_id => ({ semantic_id })), error: null });

  it('removes, then changes the row, then adds, so the database’s rules are met in that order', async () => {
    state.responses.metric_semantic_ids = rows(ECLASS, CDD);
    state.responses.metric_catalog = { data: [{ id: 'm1' }], error: null };

    await api.put('/api/v1/metric-catalog/m1', {
      semantic_id: ECLASS, semantic_id_type: 'IRDI',
      further_semantic_ids: {
        remove: [ECLASS],
        add: [{ semantic_id: OWN, semantic_id_type: 'ExpandedNodeId', source: '  The old own id  ' }]
      }
    });

    expect(sequence()).toEqual(['metric_semantic_ids:delete', 'metric_catalog:update', 'metric_semantic_ids:insert']);
    const [removal, , addition] = state.calls;
    expect(removal.filters).toEqual([['eq', 'metric_id', 'm1'], ['in', 'semantic_id', [ECLASS]]]);
    expect(addition.payload).toEqual([
      { metric_id: 'm1', semantic_id: OWN, semantic_id_type: 'ExpandedNodeId', source: 'The old own id' }
    ]);
  });

  it('writes only the further ids when the body names nothing else, and leaves the row alone', async () => {
    state.responses.metric_semantic_ids = rows(ECLASS);
    await api.put('/api/v1/metric-catalog/m1', {
      further_semantic_ids: { remove: [], add: [{ semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null }] }
    });

    expect(sequence()).toEqual(['metric_semantic_ids:insert']);
    expect(state.calls[0].payload).toEqual([{ metric_id: 'm1', semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null }]);
  });

  it('writes nothing to the further ids when the body has none, as before', async () => {
    state.responses.metric_catalog = { data: [{ id: 'm1' }], error: null };
    await api.put('/api/v1/metric-catalog/m1', { semantic_id: ECLASS, semantic_id_type: 'IRDI' });
    expect(sequence()).toEqual(['metric_catalog:update']);
  });

  it('treats a removal that matched nothing as refused, and writes nothing after it', async () => {
    // Row security hides the rows from anyone but an Administrator: the DELETE matches none.
    state.responses.metric_semantic_ids = { data: [], error: null };
    await expect(api.put('/api/v1/metric-catalog/m1', {
      semantic_id: ECLASS, semantic_id_type: 'IRDI', further_semantic_ids: { remove: [ECLASS], add: [] }
    })).rejects.toThrow(/^Metric not changed/);
    expect(sequence()).toEqual(['metric_semantic_ids:delete']);
  });

  it('treats an addition that came back with no row as refused', async () => {
    state.responses.metric_semantic_ids = { data: [], error: null };
    await expect(api.put('/api/v1/metric-catalog/m1', {
      further_semantic_ids: { remove: [], add: [{ semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null }] }
    })).rejects.toThrow(/^Metric not changed/);
  });

  it('says what was already saved when a later write is refused', async () => {
    state.responses.metric_semantic_ids = rows(ECLASS);
    state.responses.metric_catalog = {
      data: null, error: { message: `${ECLASS} is already one of the further semantic ids of Machine/SERIAL.` }
    };
    await expect(api.put('/api/v1/metric-catalog/m1', {
      semantic_id: ECLASS, semantic_id_type: 'IRDI', further_semantic_ids: { remove: [CDD], add: [] }
    })).rejects.toThrow(/is already one of the further semantic ids.*Part of the save was made: the further ids you removed were removed\. Close this and open Edit again/s);
  });

  it('passes the database’s own refusal on, worded as it came, when nothing was saved first', async () => {
    state.responses.metric_semantic_ids = {
      data: null, error: { message: 'Machine/SERIAL already carries 10 further semantic ids, the most a metric may. Remove one first.' }
    };
    await expect(api.put('/api/v1/metric-catalog/m1', {
      further_semantic_ids: { remove: [], add: [{ semantic_id: ECLASS, semantic_id_type: 'IRDI', source: null }] }
    })).rejects.toThrow(/^Machine\/SERIAL already carries 10 further semantic ids/);
  });
});

describe('the Digital Nameplate reader', () => {
  const SERIAL_NODE = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003';
  const MANUFACTURER_NODE = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002';
  const nameplate = (crosswalk, config = []) => {
    state.responses.device_nameplate = { data: [], error: null };
    state.responses.idta_submodel_templates = { data: [], error: null };
    state.responses.metric_semantic_id_crosswalk = { data: crosswalk, error: null };
    state.responses.asset_config = { data: config, error: null };
    return api.get('/api/v1/devices/dev-1/nameplate');
  };

  it('asks the crosswalk about the six Machinery concepts and no others', async () => {
    await nameplate([]);
    const [ask] = callsOn('metric_semantic_id_crosswalk');
    const ids = ask.filters.find(f => f[0] === 'in' && f[1] === 'semantic_id')[2];
    expect(ids.sort()).toEqual([
      'nsu=http://opcfoundation.org/UA/Machinery/;i=6002', 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003',
      'nsu=http://opcfoundation.org/UA/Machinery/;i=6004', 'nsu=http://opcfoundation.org/UA/Machinery/;i=6008',
      'nsu=http://opcfoundation.org/UA/Machinery/;i=6011', 'nsu=http://opcfoundation.org/UA/Machinery/;i=6015'
    ]);
    expect(callsOn('metric_catalog')).toHaveLength(0);
  });

  it('finds a published value under a metric that carries the concept as a further id', async () => {
    const { published } = await nameplate(
      [{ metric_name: 'Machine/SERIAL', semantic_id: SERIAL_NODE, held_as: 'supplemental' }],
      [{ metric_name: 'Machine/SERIAL', val_string: 'SN-PUBLISHED', val_double: null, val_bool: null }]
    );
    expect(published).toEqual({ serial_number: 'SN-PUBLISHED' });
  });

  it('prefers the metric that carries the concept as its own id, whatever its name', async () => {
    await nameplate([
      { metric_name: 'A/First', semantic_id: MANUFACTURER_NODE, held_as: 'supplemental' },
      { metric_name: 'Z/Last', semantic_id: MANUFACTURER_NODE, held_as: 'primary' }
    ]);
    const read = callsOn('asset_config')[0];
    expect(read.filters.find(f => f[0] === 'in')[2]).toEqual(['Z/Last']);
  });

  it('reads no readings when no metric carries any of the concepts', async () => {
    const { published } = await nameplate([]);
    expect(published).toEqual({});
    expect(callsOn('asset_config')).toHaveLength(0);
  });
});
