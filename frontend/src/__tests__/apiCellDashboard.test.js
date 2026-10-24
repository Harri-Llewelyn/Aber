import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `cells.grafana_url` is deprecated: a cell's dashboard is one of its Attached Links. The API layer
 * neither writes the column nor maps it onto `access_url`, the name of a real gateway column.
 */

const calls = vi.hoisted(() => ({ insert: [], update: [], rows: [] }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    insert: vi.fn((row) => { calls.insert.push(row); return builder; }),
    update: vi.fn((patch) => { calls.update.push(patch); return builder; }),
    eq: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve({ data: calls.rows, error: null })),
    select: vi.fn(() => {
      // A write's trailing select resolves; the list read goes on to order().
      const done = Promise.resolve({ data: [{ id: 'cell-1' }], error: null });
      return Object.assign(done, { order: builder.order });
    })
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(() => builder), auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

beforeEach(() => {
  calls.insert.length = 0;
  calls.update.length = 0;
  calls.rows = [];
});

describe("a cell's deprecated dashboard address through the API layer", () => {
  it('is not written when a cell is created, whatever the body carries', async () => {
    await api.post('/api/v1/cells', {
      cell_name: 'Bay 4', access_url: 'https://grafana.test/d/1', grafana_url: 'https://grafana.test/d/1'
    });
    expect(calls.insert[0]).toMatchObject({ name: 'Bay 4' });
    expect(calls.insert[0]).not.toHaveProperty('grafana_url');
  });

  it('is not written when a cell is edited', async () => {
    await api.put('/api/v1/cells/cell-1', {
      cell_name: 'Bay 4', access_url: 'https://grafana.test/d/1', grafana_url: 'https://grafana.test/d/1'
    });
    expect(calls.update[0]).toMatchObject({ name: 'Bay 4' });
    expect(calls.update[0]).not.toHaveProperty('grafana_url');
  });

  it('is not read back as access_url, a gateway column', async () => {
    calls.rows = [{ id: 'cell-1', name: 'Bay 4', grafana_url: 'https://grafana.test/d/1', gateways: [] }];
    const [cell] = await api.get('/api/v1/cells');
    expect(cell).toMatchObject({ cell_id: 'cell-1', cell_name: 'Bay 4' });
    expect(cell).not.toHaveProperty('access_url');
  });
});
