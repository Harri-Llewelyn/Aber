import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Capture page's History reads finished jobs a page at a time, keyed on (created_at, id) rather
 * than an OFFSET, so a job that finishes meanwhile does not shift a page. The cursor's timestamp is
 * passed back as PostgREST wrote it: a Date would drop its microseconds and skip or repeat a row.
 */

const calls = vi.hoisted(() => ({ log: [], answer: { data: [], error: null, count: 0 } }));

vi.mock('../lib/supabaseClient', () => {
  const builder = (table) => {
    const query = {
      then: (resolve, reject) => Promise.resolve(calls.answer).then(resolve, reject)
    };
    for (const method of ['select', 'in', 'or', 'order', 'limit']) {
      query[method] = (...args) => {
        calls.log.push([method, ...args]);
        return query;
      };
    }
    calls.log.push(['from', table]);
    return query;
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(builder), rpc: vi.fn(), auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const STAMP = '2026-10-29T10:42:17.123456+00:00';
const ID = '00000000-0000-4000-8000-0000000000aa';
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));

beforeEach(() => {
  calls.log.length = 0;
  calls.answer = { data: [], error: null, count: 0 };
});

describe('jobHistory', () => {
  it('reads one more than the page, newest first, finished jobs only, with the count', async () => {
    calls.answer = { data: rows(21), error: null, count: 57 };
    const page = await api.jobHistory('capture', { limit: 20 });
    expect(page.rows).toHaveLength(20);
    expect(page).toMatchObject({ remaining: 57, more: true });
    expect(calls.log).toEqual([
      ['from', 'capture_jobs'],
      ['select', '*, gateways(name, sparkplug_id), devices(name, sparkplug_id)', { count: 'exact' }],
      ['in', 'status', ['COMPLETED', 'FAILED', 'CANCELLED']],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 21]
    ]);
  });

  it('pages on from a row by its start time and id, the time quoted as it was read', async () => {
    calls.answer = { data: rows(3), error: null, count: 3 };
    const page = await api.jobHistory('playback', { before: { created_at: STAMP, id: ID }, limit: 20 });
    expect(page).toMatchObject({ remaining: 3, more: false });
    expect(calls.log[0]).toEqual(['from', 'playback_jobs']);
    expect(calls.log).toContainEqual(
      ['or', `created_at.lt."${STAMP}",and(created_at.eq."${STAMP}",id.lt.${ID})`]);
    expect(calls.log.some(([method]) => method === 'range')).toBe(false);
  });

  it('refuses a cursor that is not a row it read, rather than writing it into the filter', async () => {
    for (const before of [
      { created_at: `${STAMP}",id.gt."0`, id: ID },
      { created_at: STAMP, id: `${ID},status.eq.PENDING` },
      { created_at: new Date(STAMP), id: ID }
    ]) {
      await expect(api.jobHistory('capture', { before })).rejects.toThrow(/page on from a row it read/);
    }
    expect(calls.log.some(([method]) => method === 'or')).toBe(false);
  });

  it('says which history could not be read', async () => {
    calls.answer = { data: null, error: { message: '' }, count: null };
    await expect(api.jobHistory('playback')).rejects.toThrow('Could not read the playback history');
  });
});
