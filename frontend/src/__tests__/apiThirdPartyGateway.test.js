import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The API layer passes `third_party` through on create and edit. Anything it does not know still
 * reads as `remote`, the type that needs an appliance.
 */

const calls = vi.hoisted(() => ({ insert: [], update: [] }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    insert: vi.fn((row) => { calls.insert.push(row); return builder; }),
    update: vi.fn((patch) => { calls.update.push(patch); return builder; }),
    eq: vi.fn(() => builder),
    select: vi.fn(() => Promise.resolve({ data: [{ id: 'gw-1' }], error: null }))
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
});

describe('a Third-party gateway through the API layer', () => {
  it('is created as third_party', async () => {
    await api.post('/api/v1/gateways', { gateway_name: 'Vendor_Node', deployment: 'third_party' });
    expect(calls.insert[0]).toMatchObject({ name: 'Vendor_Node', deployment: 'third_party', is_simulated: false });
  });

  it('is edited to third_party', async () => {
    await api.put('/api/v1/gateways/gw-1', { gateway_name: 'Vendor_Node', deployment: 'third_party' });
    expect(calls.update[0]).toMatchObject({ deployment: 'third_party' });
  });

  it('leaves Host as it was, and reads anything else as Remote', async () => {
    await api.post('/api/v1/gateways', { gateway_name: 'A', deployment: 'host' });
    await api.post('/api/v1/gateways', { gateway_name: 'B', deployment: 'elsewhere' });
    await api.post('/api/v1/gateways', { gateway_name: 'C' });
    expect(calls.insert.map(row => row.deployment)).toEqual(['host', 'remote', 'remote']);
  });
});
