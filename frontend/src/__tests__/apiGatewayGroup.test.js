import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PUT /api/v1/gateways/:id writes `sparkplug_group` when the form sends it, and a refusal by
 * gateways_sparkplug_group_format comes back as the rule rather than the constraint's name.
 */

const calls = vi.hoisted(() => ({ update: [], result: { data: [{ id: 'gw-1' }], error: null } }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    update: vi.fn((patch) => { calls.update.push(patch); return builder; }),
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

beforeEach(() => {
  calls.update.length = 0;
  calls.result = { data: [{ id: 'gw-1' }], error: null };
});

describe("a gateway's Sparkplug group through the API layer", () => {
  it('is written when the form sends it', async () => {
    await api.put('/api/v1/gateways/gw-1', { gateway_name: 'Line_A', sparkplug_group: 'Plant-B' });
    expect(calls.update[0]).toMatchObject({ name: 'Line_A', sparkplug_group: 'Plant-B' });
  });

  it('is left alone when the form does not send it', async () => {
    await api.put('/api/v1/gateways/gw-1', { gateway_name: 'Line_A' });
    expect(calls.update[0]).not.toHaveProperty('sparkplug_group');
  });

  it('comes back refused as the rule, not as the constraint', async () => {
    calls.result = {
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "gateways" violates check constraint "gateways_sparkplug_group_format"'
      }
    };
    await expect(api.put('/api/v1/gateways/gw-1', { sparkplug_group: 'a#b' }))
      .rejects.toThrow('A Sparkplug group is one level of the topic, so it cannot contain #.');
  });

  it('passes any other error through', async () => {
    calls.result = { data: null, error: { code: '42501', message: 'permission denied' } };
    await expect(api.put('/api/v1/gateways/gw-1', { sparkplug_group: 'Plant-B' }))
      .rejects.toMatchObject({ code: '42501' });
  });
});
