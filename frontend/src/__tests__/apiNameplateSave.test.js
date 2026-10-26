import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PUT /api/v1/devices/:id/nameplate sends the nameplate's fields and nothing about who saved it or
 * when: the database stamps updated_by and updated_at (device_nameplate_stamp, migration 0210).
 */

const calls = vi.hoisted(() => ({ upsert: [], deleted: 0 }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    upsert: vi.fn((row, options) => { calls.upsert.push({ row, options }); return builder; }),
    delete: vi.fn(() => { calls.deleted += 1; return builder; }),
    eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
    select: vi.fn(() => Promise.resolve({ data: [{ device_id: 'dev-1' }], error: null }))
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      from: vi.fn(() => builder),
      auth: { getSession: vi.fn(() => Promise.resolve({ data: { session: { user: { id: 'me' } } } })) }
    }
  };
});

import { api } from '../api';
import { supabase } from '../lib/supabaseClient';

beforeEach(() => {
  calls.upsert.length = 0;
  calls.deleted = 0;
  supabase.auth.getSession.mockClear();
});

describe("a device's nameplate save", () => {
  it('sends the fields, keyed by the device', async () => {
    await api.put('/api/v1/devices/dev-1/nameplate', { serial_number: 'SN-1', manufacturer_name: 'Haas' });
    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0].row).toMatchObject({
      device_id: 'dev-1', serial_number: 'SN-1', manufacturer_name: 'Haas', hardware_version: null
    });
    expect(calls.upsert[0].options).toEqual({ onConflict: 'device_id' });
  });

  it('sends neither who saved it nor when, whatever the form carries', async () => {
    await api.put('/api/v1/devices/dev-1/nameplate', {
      serial_number: 'SN-1',
      updated_by: '00000000-0000-4000-8000-000000000bad',
      updated_at: '2001-01-01T00:00:00Z'
    });
    expect(calls.upsert[0].row).not.toHaveProperty('updated_by');
    expect(calls.upsert[0].row).not.toHaveProperty('updated_at');
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it('deletes the row when every field is empty', async () => {
    await api.put('/api/v1/devices/dev-1/nameplate', { serial_number: '' });
    expect(calls.deleted).toBe(1);
    expect(calls.upsert).toHaveLength(0);
  });
});
