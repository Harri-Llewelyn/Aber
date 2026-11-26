import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * One backup run by its id, for a link to a run the Backups page has not loaded: the list's own
 * query, narrowed to the id, among the finished runs, with the backup it produced. An id that is no
 * uuid is no run, and is not asked about.
 */

const calls = vi.hoisted(() => ({ steps: [], result: { data: [], error: null, count: 0 } }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {};
  for (const step of ['from', 'select', 'in', 'eq', 'order']) {
    builder[step] = vi.fn((...args) => { calls.steps.push([step, ...args]); return builder; });
  }
  builder.limit = vi.fn((n) => { calls.steps.push(['limit', n]); return Promise.resolve(calls.result); });
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: builder.from, auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const ID = 'b0c4e000-0000-4000-8000-000000001672';
const BACKUP = { id: 'b0c4e000-0000-4000-8000-0000000016b1', job_id: ID, stamp: '20260611T143000Z', pinned: true };

beforeEach(() => {
  calls.steps = [];
  calls.result = { data: [], error: null, count: 0 };
});

describe('one backup run by its id', () => {
  it('asks the list\'s query for that id among the finished runs, and gives it with its backup', async () => {
    calls.result = { data: [{ id: ID, status: 'COMPLETED', backups: [BACKUP] }], error: null, count: 1 };
    expect(await api.backupRun(ID)).toEqual({ id: ID, status: 'COMPLETED', backup: BACKUP });
    expect(calls.steps).toEqual([
      ['from', 'backup_jobs'],
      ['select', '*, backups(*)', { count: 'exact' }],
      ['in', 'status', ['COMPLETED', 'FAILED', 'CANCELLED']],
      ['eq', 'id', ID],
      ['order', 'finished_at', { ascending: false }],
      ['limit', 1],
    ]);
  });

  it('is null when no finished run has the id', async () => {
    expect(await api.backupRun(ID)).toBeNull();
  });

  it('is null for an id that is no uuid, without asking', async () => {
    for (const id of ['', 'nightly-30', 'historian', null, undefined]) {
      expect(await api.backupRun(id)).toBeNull();
    }
    expect(calls.steps).toEqual([]);
  });

  it('passes a refusal on', async () => {
    calls.result = { data: null, error: { message: 'permission denied for table backup_jobs' }, count: null };
    await expect(api.backupRun(ID)).rejects.toThrow('permission denied for table backup_jobs');
  });

  it('leaves the list without an id as it was: no id in its query', async () => {
    await api.listBackupRuns({ statuses: ['FAILED'], limit: 30 });
    expect(calls.steps.map(s => s[0])).toEqual(['from', 'select', 'in', 'order', 'limit']);
  });
});
