import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An area plan's download. The bucket is private, so the object is signed for one minute, asked for
 * as an attachment named after the area, and the gateway's key is added, since a new tab sends none.
 */

const calls = vi.hoisted(() => ({ log: [], answer: null }));

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    storage: {
      from: vi.fn((bucket) => ({
        createSignedUrl: (path, seconds, options) => {
          calls.log.push([bucket, path, seconds, options]);
          return Promise.resolve(calls.answer);
        }
      }))
    },
    auth: { getSession: vi.fn() }
  }
}));

import { api } from '../api';

const AREA = { area_id: 'a1', area_name: 'Assembly Hall', plan_path: 'a1/plan-1.svg' };

beforeEach(() => {
  calls.log.length = 0;
  calls.answer = { data: { signedUrl: 'http://stack.test/storage/v1/object/sign/area-plans/a1/plan-1.svg?token=t&download=Assembly-Hall-plan.svg' }, error: null };
});

describe('areaPlanDownloadUrl', () => {
  it('signs the stored plan as a download, and adds the gateway key', async () => {
    expect(await api.areaPlanDownloadUrl(AREA)).toBe(
      'http://stack.test/storage/v1/object/sign/area-plans/a1/plan-1.svg?token=t&download=Assembly-Hall-plan.svg&apikey=sb_publishable_test');
    expect(calls.log).toEqual([['area-plans', 'a1/plan-1.svg', 60, { download: 'Assembly-Hall-plan.svg' }]]);
  });

  it('throws what storage answered', async () => {
    calls.answer = { data: null, error: { message: 'Object not found' } };
    await expect(api.areaPlanDownloadUrl(AREA)).rejects.toThrow('Object not found');
  });
});
