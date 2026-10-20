import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A capture download goes through the database first. `issue_capture_download()` writes the Audit
 * Trail's CAPTURE_DOWNLOAD_ISSUED and answers the path; only the path it answered is signed, and a
 * refusal signs nothing, so the page cannot hand out a link the trail does not record.
 */

const calls = vi.hoisted(() => ({ log: [], answers: {} }));

vi.mock('../lib/supabaseClient', () => {
  const answer = (name) => calls.answers[name] || { data: null, error: null };
  const bucket = {
    createSignedUrl: vi.fn((path, seconds, options) => {
      calls.log.push(['sign', path, seconds, options]);
      return Promise.resolve(answer('sign'));
    })
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      rpc: vi.fn((name, args) => {
        calls.log.push(['rpc', name, args]);
        return Promise.resolve(answer(name));
      }),
      storage: { from: vi.fn(() => bucket) },
      auth: { getSession: vi.fn() }
    }
  };
});

import { api } from '../api';

const PATH = 'dev270000000000400080000/6f0c.json';

beforeEach(() => {
  calls.log.length = 0;
  calls.answers = {
    issue_capture_download: { data: PATH, error: null },
    sign: { data: { signedUrl: 'http://stack.test/storage/v1/object/sign/broker-captures/x?token=t' }, error: null }
  };
});

describe('captureUrl', () => {
  it('records the download, then signs the path the database answered', async () => {
    const url = await api.captureUrl(PATH);
    expect(calls.log).toEqual([
      ['rpc', 'issue_capture_download', { p_storage_path: PATH }],
      ['sign', PATH, 60, { download: 'dev270000000000400080000.capture.json' }]
    ]);
    expect(url).toBe('http://stack.test/storage/v1/object/sign/broker-captures/x?token=t&apikey=sb_publishable_test');
  });

  it('signs nothing when the database refuses the caller', async () => {
    calls.answers.issue_capture_download = {
      data: null,
      error: { message: 'issue_capture_download: downloading a capture requires Administrator, Shopfloor_Manager or Auditor' }
    };
    await expect(api.captureUrl(PATH)).rejects.toThrow(
      'Downloading a capture requires Administrator, Shopfloor Manager or Auditor.');
    expect(calls.log.map(c => c[0])).toEqual(['rpc']);
  });

  it('signs nothing for a capture that is gone, and says so', async () => {
    calls.answers.issue_capture_download = {
      data: null,
      error: { message: `issue_capture_download: no stored capture is at ${PATH}. It may have been deleted or replaced; reload the list.` }
    };
    await expect(api.captureUrl(PATH)).rejects.toThrow('no stored capture is at');
    expect(calls.log.map(c => c[0])).toEqual(['rpc']);
  });
});
