import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/v1/schemas/validate judges a payload against one version and against the catalogue's
 * derived metrics: a reading under one of their names is dropped by ingestion whatever a schema
 * says, so the dialog has to be told the names or it passes a payload ingestion refuses.
 */

const stack = vi.hoisted(() => ({
  schema: { data: [{ schema_definition: {} }], error: null },
  derived: { data: [], error: null },
  reads: []
}));

vi.mock('../lib/supabaseClient', () => {
  const from = (table) => {
    const read = { table, select: null, not: null };
    stack.reads.push(read);
    const builder = {
      select: vi.fn((columns) => { read.select = columns; return builder; }),
      eq: vi.fn(() => Promise.resolve(stack.schema)),
      not: vi.fn((...args) => { read.not = args; return Promise.resolve(stack.derived); })
    };
    return builder;
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(from), auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const DERIVED = 'Controller/PARTS_PER_HOUR';

beforeEach(() => {
  stack.reads.length = 0;
  stack.schema = { data: [{ schema_definition: { properties: { [DERIVED]: { type: 'number' } } } }], error: null };
  stack.derived = { data: [{ name: DERIVED }], error: null };
});

describe("a payload's validation through the API layer", () => {
  it("reads the catalogue's derived metrics, and only those", async () => {
    await api.post('/api/v1/schemas/validate', { schema_uuid: 'v1', payload: {} });
    const read = stack.reads.find((r) => r.table === 'metric_catalog');
    expect(read.select).toBe('name');
    expect(read.not).toEqual(['derivation', 'is', null]);
  });

  it('reports a reading under a derived name as one ingestion drops, though the schema models it', async () => {
    const result = await api.post('/api/v1/schemas/validate', { schema_uuid: 'v1', payload: { [DERIVED]: 12 } });
    expect(result.findings.map((f) => [f.metric, f.code, f.dropped])).toEqual([[DERIVED, 'derived_name', true]]);
  });

  it('passes the same payload when the catalogue has no derived metric', async () => {
    stack.derived = { data: [], error: null };
    const result = await api.post('/api/v1/schemas/validate', { schema_uuid: 'v1', payload: { [DERIVED]: 12 } });
    expect(result.findings).toEqual([]);
  });

  it('says so when the catalogue cannot be read, rather than passing the payload', async () => {
    stack.derived = { data: null, error: { message: 'permission denied' } };
    const result = await api.post('/api/v1/schemas/validate', { schema_uuid: 'v1', payload: { [DERIVED]: 12 } });
    expect(result.error).toMatch(/metric catalog could not be read/);
    expect(result.findings).toBeUndefined();
  });

  it('still says when the version is not there, without reading the catalogue', async () => {
    stack.schema = { data: [], error: null };
    const result = await api.post('/api/v1/schemas/validate', { schema_uuid: 'gone', payload: {} });
    expect(result.error).toBe('Target schema definition not found');
    expect(stack.reads.some((r) => r.table === 'metric_catalog')).toBe(false);
  });
});
