import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A device or a gateway written with a blank name is refused by devices_name_not_blank and
 * gateways_name_not_blank. The API layer says the rule, on the create and on the update, and passes
 * any other error through as it came.
 */

const calls = vi.hoisted(() => ({ result: { data: [{ id: 'row-1' }], error: null } }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    select: vi.fn(() => Promise.resolve(calls.result))
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(() => builder), auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const refused = (table, constraint) => ({
  data: null,
  error: {
    code: '23514',
    message: `new row for relation "${table}" violates check constraint "${constraint}"`
  }
});

const WRITES = [
  { what: 'creating a device', call: () => api.post('/api/v1/devices', { asset_name: ' ' }), table: 'devices', constraint: 'devices_name_not_blank', sentence: 'Give the device a name' },
  { what: 'updating a device', call: () => api.put('/api/v1/devices/d-1', { asset_name: '' }), table: 'devices', constraint: 'devices_name_not_blank', sentence: 'Give the device a name' },
  { what: 'registering a gateway', call: () => api.post('/api/v1/gateways', { gateway_name: ' ' }), table: 'gateways', constraint: 'gateways_name_not_blank', sentence: 'Give the gateway a name' },
  { what: 'updating a gateway', call: () => api.put('/api/v1/gateways/g-1', { gateway_name: '' }), table: 'gateways', constraint: 'gateways_name_not_blank', sentence: 'Give the gateway a name' }
];

beforeEach(() => {
  calls.result = { data: [{ id: 'row-1' }], error: null };
});

describe('a blank device or gateway name through the API layer', () => {
  for (const { what, call, table, constraint, sentence } of WRITES) {
    it(`comes back from ${what} as the rule, not as the constraint`, async () => {
      calls.result = refused(table, constraint);
      await expect(call()).rejects.toThrow(sentence);
    });

    it(`passes another refusal of ${what} through as it came`, async () => {
      calls.result = { data: null, error: { code: '42501', message: 'permission denied' } };
      await expect(call()).rejects.toMatchObject({ code: '42501' });
    });
  }

  it("does not read a device's refusal as a gateway's", async () => {
    calls.result = refused('devices', 'devices_name_not_blank');
    await expect(api.put('/api/v1/gateways/g-1', { gateway_name: '' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('does not rewrite another CHECK on the same row', async () => {
    calls.result = refused('devices', 'devices_location_scope_valid');
    await expect(api.put('/api/v1/devices/d-1', { asset_name: 'Press' }))
      .rejects.toMatchObject({ code: '23514' });
  });
});
