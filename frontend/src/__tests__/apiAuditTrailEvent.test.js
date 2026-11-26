import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `api.auditTrailEvent`: one Audit Trail event by id, for a link to an event the page has not loaded.
 * The row is found in the table, under its policies, and then read with its entity's events through
 * the page's own read, so it has what a loaded row has. The entity's newest page is read first; when
 * that does not hold the event, the page that ends at it.
 */

const state = { from: [], rpc: [], rows: [], pages: [] };

function makeBuilder(table) {
  const record = { table, select: null, filters: [], limit: null };
  state.from.push(record);
  const answer = state.rows.shift() ?? { data: [], error: null };
  const builder = {
    select: (cols) => { record.select = cols; return builder; },
    eq: (col, val) => { record.filters.push([col, val]); return builder; },
    limit: (n) => { record.limit = n; return builder; },
    then: (onFulfilled, onRejected) => Promise.resolve(answer).then(onFulfilled, onRejected),
  };
  return builder;
}

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    from: vi.fn((table) => makeBuilder(table)),
    rpc: vi.fn(async (name, args) => {
      state.rpc.push({ name, args });
      return state.pages.shift() ?? { data: { events: [] }, error: null };
    }),
  },
}));

const { api } = await import('../api');

const DEVICE = 'd0c4e000-0000-4000-8000-000000001688';
const AT = '2026-03-02T09:00:00.123456+00:00';
const row = (id, recorded_at = AT) => ({ id, entity_type: 'devices', entity_id: DEVICE, action: 'UPDATE', recorded_at, old_data: {}, new_data: {}, class: 'operational' });

beforeEach(() => {
  state.from = [];
  state.rpc = [];
  state.rows = [];
  state.pages = [];
});

describe('api.auditTrailEvent', () => {
  it("finds the row by id, then reads its entity's newest page, deleted entities included", async () => {
    state.rows.push({ data: [{ id: 900, entity_id: DEVICE, recorded_at: AT }], error: null });
    state.pages.push({ data: { events: [row(950, '2026-03-03T00:00:00Z'), row(900), row(870)], next_cursor: null }, error: null });
    const found = await api.auditTrailEvent('900');
    expect(state.from[0]).toMatchObject({ table: 'audit_trail', filters: [['id', '900']], limit: 1 });
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].name).toBe('audit_trail_page');
    expect(state.rpc[0].args).toMatchObject({ p_entity_ids: [DEVICE], p_include_purged: true, p_limit: 200 });
    expect(state.rpc[0].args.p_before_id).toBeUndefined();
    expect(found.event).toMatchObject({ event_id: 900, event_type: 'UPDATE' });
    expect(found.events.map(e => e.event_id)).toEqual([950, 900, 870]);
    expect(found).toMatchObject({ olderUnread: false, newerUnread: false });
  });

  it("reads the page that ends at the event when the entity's newest page does not hold it", async () => {
    state.rows.push({ data: [{ id: 900, entity_id: DEVICE, recorded_at: AT }], error: null });
    state.pages.push({ data: { events: [row(990, '2026-04-01T00:00:00Z')], next_cursor: { recorded_at: '2026-04-01T00:00:00Z', id: 990 } }, error: null });
    state.pages.push({ data: { events: [row(900), row(870)], next_cursor: { recorded_at: AT, id: 870 } }, error: null });
    const found = await api.auditTrailEvent('900');
    expect(state.rpc).toHaveLength(2);
    expect(state.rpc[1].args).toMatchObject({ p_entity_ids: [DEVICE], p_before_recorded_at: AT, p_before_id: 901 });
    expect(found.events.map(e => e.event_id)).toEqual([900, 870]);
    expect(found).toMatchObject({ olderUnread: true, newerUnread: true });
  });

  it('answers null for an id no row has, or one the policies hide, and for an id that is no number', async () => {
    state.rows.push({ data: [], error: null });
    expect(await api.auditTrailEvent('900')).toBeNull();
    expect(await api.auditTrailEvent('not-an-id')).toBeNull();
    expect(state.from).toHaveLength(1);
    expect(state.rpc).toHaveLength(0);
  });

  it('fails when the row cannot be read, so the page says it could not read it rather than that it is absent', async () => {
    state.rows.push({ data: null, error: { message: 'connection reset' } });
    await expect(api.auditTrailEvent('900')).rejects.toThrow('connection reset');
  });
});
