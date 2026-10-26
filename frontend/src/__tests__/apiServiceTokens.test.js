import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `api.listServiceTokens`: every TOKEN_MINTED row by identity, each with when the i3X server last
 * accepted it (`service_token_last_use`, 0209). The two reads go out together, and a failed
 * last-use read leaves the list whole with no last use known, never Never.
 */

// Each `from(table)` chain answers with that table's queued response.
const state = { calls: [], answers: {} };

function makeBuilder(table) {
  const record = { table, select: null, filters: [], order: null };
  state.calls.push(record);
  const answer = state.answers[table] ?? { data: [], error: null };
  const builder = {
    select: (cols) => { record.select = cols; return builder; },
    eq: (col, val) => { record.filters.push([col, val]); return builder; },
    order: (col, opts) => { record.order = [col, opts]; return builder; },
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

const CLIENT = 'b0000000-0000-4000-8000-000000000001';
const mint = (jti, at) => ({
  entity_id: CLIENT,
  recorded_at: at,
  new_data: { jti, issued_at: at, expires_at: '2026-11-25T10:00:00+00:00' },
});

beforeEach(() => {
  state.calls = [];
  state.answers = {
    audit_trail: { data: [mint('used', '2026-10-26T10:00:00+00:00'), mint('idle', '2026-10-20T10:00:00+00:00')], error: null },
    service_token_last_use: { data: [{ jti: 'used', last_used_at: '2026-10-26T14:00:00+00:00' }], error: null },
  };
});

describe('api.listServiceTokens', () => {
  it('gives each token its identity and its last use, or null for none', async () => {
    const tokens = (await api.listServiceTokens()).get(CLIENT);
    expect(tokens).toEqual([
      { issued_at: '2026-10-26T10:00:00+00:00', expires_at: '2026-11-25T10:00:00+00:00', jti: 'used',
        principal_id: CLIENT, lastUsedAt: '2026-10-26T14:00:00+00:00' },
      { issued_at: '2026-10-20T10:00:00+00:00', expires_at: '2026-11-25T10:00:00+00:00', jti: 'idle',
        principal_id: CLIENT, lastUsedAt: null },
    ]);
    expect(state.calls.map(c => c.table).sort()).toEqual(['audit_trail', 'service_token_last_use']);
    expect(state.calls.find(c => c.table === 'service_token_last_use').select).toBe('jti,last_used_at');
  });

  it('keeps the list when the last use cannot be read, and knows no last use', async () => {
    state.answers.service_token_last_use = { data: null, error: { message: 'relation does not exist' } };
    const tokens = (await api.listServiceTokens()).get(CLIENT);
    expect(tokens.map(t => t.jti)).toEqual(['used', 'idle']);
    expect(tokens.every(t => t.lastUsedAt === undefined)).toBe(true);
  });

  it('still fails when the token history cannot be read', async () => {
    state.answers.audit_trail = { data: null, error: { message: 'permission denied' } };
    await expect(api.listServiceTokens()).rejects.toThrow('permission denied');
  });
});
