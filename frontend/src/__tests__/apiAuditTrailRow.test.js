import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `api.getAuditTrailRow`: one audit row by id, read through the table so its policies decide. An
 * approval's own row carries no `old_data`, so for that row the values it replaced are read from
 * the UPDATE the target's trigger wrote in the same transaction.
 */

// Each `from('audit_trail')` chain answers with the next queued response, in order.
const state = { calls: [], answers: [] };

function makeBuilder(table) {
  const record = { table, select: null, filters: [], order: null, limit: null };
  state.calls.push(record);
  const answer = state.answers.shift() ?? { data: [], error: null };
  const builder = {
    select: (cols) => { record.select = cols; return builder; },
    eq: (col, val) => { record.filters.push([col, val]); return builder; },
    order: (col, opts) => { record.order = [col, opts]; return builder; },
    limit: (n) => { record.limit = n; return builder; },
    then: (onFulfilled, onRejected) => Promise.resolve(answer).then(onFulfilled, onRejected)
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { from: vi.fn((table) => makeBuilder(table)) }
}));

const { api } = await import('../api');

const APPLIED = {
  id: 4321, entity_type: 'devices', entity_id: 'dev-1', action: 'PROPOSAL_APPLIED',
  old_data: null, new_data: { patch: { name: 'Cell 4 Lathe' } },
  recorded_at: '2026-09-06T10:00:00.123456+00:00', causation_id: 991
};

beforeEach(() => {
  state.calls = [];
  state.answers = [];
});

describe('api.getAuditTrailRow', () => {
  it('reads the row by its id from the audit table', async () => {
    state.answers.push({ data: [{ ...APPLIED, action: 'UPDATE', old_data: { name: 'a' } }], error: null });
    const row = await api.getAuditTrailRow(4321);
    expect(row).toMatchObject({ id: 4321, action: 'UPDATE', old_data: { name: 'a' } });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ table: 'audit_trail', filters: [['id', 4321]], limit: 1 });
  });

  it('answers null when the policies hide the row, or it is absent', async () => {
    state.answers.push({ data: [], error: null });
    expect(await api.getAuditTrailRow(4321)).toBeNull();
    state.answers.push({ data: null, error: { message: 'permission denied' } });
    expect(await api.getAuditTrailRow(4321)).toBeNull();
  });

  it('reads what an approval replaced from the UPDATE in the same transaction', async () => {
    state.answers.push({ data: [APPLIED], error: null });
    state.answers.push({ data: [{ old_data: { name: 'Lathe_01' } }], error: null });
    const row = await api.getAuditTrailRow(4321);
    expect(row.replaced).toEqual({ name: 'Lathe_01' });
    // The approval's own row is returned as it is: its `old_data` stays null.
    expect(row.old_data).toBeNull();
    expect(state.calls[1].filters).toEqual([
      ['causation_id', 991], ['entity_type', 'devices'], ['entity_id', 'dev-1'], ['action', 'UPDATE']
    ]);
    expect(state.calls[1].order).toEqual(['id', { ascending: false }]);
  });

  it('leaves `replaced` null when that UPDATE cannot be read', async () => {
    state.answers.push({ data: [APPLIED], error: null });
    state.answers.push({ data: [], error: null });
    expect((await api.getAuditTrailRow(4321)).replaced).toBeNull();
  });
});
