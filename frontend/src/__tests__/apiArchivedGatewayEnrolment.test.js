import { describe, it, expect, vi } from 'vitest';

/**
 * Entities' Archived tab reads whether a gateway's appliance had enrolled, which its Restore dialog names:
 * the same machine's old enrolment is cleared before it is set up again.
 */

vi.mock('../lib/supabaseClient', () => {
  const rows = {
    gateways: [
      { id: 'g1', name: 'Paint Line', deployment: 'remote', enrolled_at: '2026-11-01T09:00:00Z', archived_at: '2026-11-05T09:00:00Z' },
      { id: 'g2', name: 'Host Flow', deployment: 'host', enrolled_at: null, archived_at: '2026-11-04T09:00:00Z' },
    ]
  };
  const from = (table) => {
    const builder = {
      select: () => builder,
      eq: () => Promise.resolve({ data: rows[table] || [], error: null }),
      in: () => Promise.resolve({ data: [], error: null }),
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
import { hadEnrolled } from '../utils/credentialState';

describe('an archived gateway through the API layer', () => {
  it('says whether its appliance had enrolled, whatever its type', async () => {
    const rows = await api.get('/api/v1/archives');
    expect(rows.map(r => [r.name, hadEnrolled(r)])).toEqual([['Paint Line', true], ['Host Flow', false]]);
  });
});
