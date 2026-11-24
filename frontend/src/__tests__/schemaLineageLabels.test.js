import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A schema is named by its lineage and its version once: `Robot_Arm_Schema v2`, where the version's
 * own name (`Robot_Arm_Schema_v2`) already says the version. Approvals names a schema's proposal
 * this way, and the Schemas list carries the lineage's name for the toast and the tooltip.
 */

const state = { calls: [], rows: {} };

function makeBuilder(table) {
  const record = { table, select: null };
  state.calls.push(record);
  const builder = {
    select: (cols) => { record.select = cols; return builder; },
    in: () => builder,
    order: () => builder,
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: state.rows[table] ?? [], error: null }).then(onFulfilled, onRejected)
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    from: vi.fn((table) => makeBuilder(table)),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null }))
  }
}));

const { api } = await import('../api');
const { lineageName, lineageVersionLabel } = await import('../utils/schemaVersion');

const SCHEMA_ID = 's0000000-0000-4000-8000-000000000002';
const ROOT_ID = 's0000000-0000-4000-8000-000000000001';

beforeEach(() => {
  state.calls = [];
  state.rows = {};
});

describe('lineageName and lineageVersionLabel', () => {
  it('print the lineage’s name and the version once', () => {
    const v2 = { schema_name: 'Robot_Arm_Schema_v2', lineage_name: 'Robot_Arm_Schema', version: 2 };
    expect(lineageName(v2)).toBe('Robot_Arm_Schema');
    expect(lineageVersionLabel(v2)).toBe('Robot_Arm_Schema v2');
  });

  it('do not rebuild the lineage from a suffixed name', () => {
    // A version made before 0318 may be called X_v2_2_v3: X_v2 was taken, and fork_schema() named
    // the next one from its parent's name. Stripping one _v<n> would say X_v2_2; the lineage says X.
    const v3 = { schema_name: 'X_v2_2_v3', lineage_name: 'X', version: 3 };
    expect(lineageVersionLabel(v3)).toBe('X v3');
  });

  it('read a row from before the lineage columns as its own lineage', () => {
    expect(lineageVersionLabel({ schema_name: 'Mill', version: 1 })).toBe('Mill v1');
    expect(lineageVersionLabel({ schema_name: 'Mill' })).toBe('Mill v1');
    expect(lineageVersionLabel(null)).toBe(' v1');
  });
});

describe('the Schemas list', () => {
  it('carries each version’s lineage name and root, beside its own name', async () => {
    state.rows = {
      schemas: [{
        id: SCHEMA_ID, schema_name: 'Robot_Arm_Schema_v2', lineage_name: 'Robot_Arm_Schema',
        lineage_root_id: ROOT_ID, schema_definition: {}, version: 2, status: 'active',
        parent_schema_id: ROOT_ID, created_at: '2026-11-01T00:00:00Z'
      }]
    };
    const [row] = await api.get('/api/v1/schemas');
    expect(row).toMatchObject({
      schema_uuid: SCHEMA_ID,
      schema_name: 'Robot_Arm_Schema_v2',
      lineage_name: 'Robot_Arm_Schema',
      lineage_root_id: ROOT_ID
    });
  });

  it('reads a database that has no lineage columns as one lineage a version', async () => {
    state.rows = {
      schemas: [{ id: SCHEMA_ID, schema_name: 'Mill', schema_definition: {}, version: 1 }]
    };
    const [row] = await api.get('/api/v1/schemas');
    expect(row).toMatchObject({ lineage_name: 'Mill', lineage_root_id: SCHEMA_ID });
  });
});

describe('Approvals', () => {
  it('names a schema’s proposal by its lineage and version, not by the version’s name', async () => {
    state.rows = {
      change_proposals: [{
        id: 'p1', entity_type: 'schemas', entity_id: SCHEMA_ID, patch: {}, status: 'open',
        proposed_by: 'aaaaaaaa-0000-4000-8000-000000000001', proposed_at: '2026-11-02T09:00:00Z'
      }],
      schemas: [{
        id: SCHEMA_ID, schema_name: 'Robot_Arm_Schema_v2', lineage_name: 'Robot_Arm_Schema',
        version: 2, status: 'draft', parent_schema_id: ROOT_ID
      }]
    };
    const [row] = await api.get('/api/v1/proposals');
    expect(row.target_label).toBe('Robot_Arm_Schema v2');
    expect(row.target_missing).toBe(false);
    // The read asks for the column the label needs.
    const read = state.calls.find(c => c.table === 'schemas');
    expect(read.select.split(',')).toContain('lineage_name');
  });
});
