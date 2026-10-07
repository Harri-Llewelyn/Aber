import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withReference, edgeFunctionErrorMessage } from '../utils/edgeFunctionError';
import { api } from '../api';

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }) }
  }
}));

const ID = '3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10';

/** A function's failed answer, as fetch() resolves it. */
const answer = (status, body) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => body
});

describe('withReference', () => {
  it('ends the message with the reference the body carries', () => {
    expect(withReference('The request failed on the server.', { request_id: ID }))
      .toBe(`The request failed on the server. Reference: ${ID}`);
  });

  it('closes a message that has no full stop before the reference', () => {
    expect(withReference('Could not generate the bundle', { request_id: ID }))
      .toBe(`Could not generate the bundle. Reference: ${ID}`);
  });

  it('leaves the message alone when the body has no request id', () => {
    expect(withReference('gateway_id must be a UUID', { error: 'Malformed request' })).toBe('gateway_id must be a UUID');
    expect(withReference('Could not read the broker (502)', null)).toBe('Could not read the broker (502)');
  });
});

describe('a function failure in the dashboard', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('shows the reference for a function called with functions.invoke()', async () => {
    const error = {
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'The request failed on the server.', request_id: ID }), { status: 500 })
    };
    expect(await edgeFunctionErrorMessage(error, 'Approval failed'))
      .toBe(`The request failed on the server. Reference: ${ID}`);
  });

  it('shows the reference for a function fetched directly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(500, { error: 'Cannot mint a credential', request_id: ID })));
    await expect(api.mintGatewayCredential('6f1d2c3b-4a59-4e8f-9b1e-2c7d5a4e9f10'))
      .rejects.toThrow(`Cannot mint a credential. Reference: ${ID}`);
  });

  it('keeps a refusal the caller can act on as it was', async () => {
    const details = 'gateway 6f1d2c3b is a Remote gateway; use an enrolment bundle';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(400, { error: 'Cannot mint a credential', details })));
    await expect(api.mintGatewayCredential('6f1d2c3b-4a59-4e8f-9b1e-2c7d5a4e9f10')).rejects.toThrow(new Error(details));
  });

  it('keeps the status and details on a bundle failure beside the reference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(500, { error: 'Could not generate the bundle', request_id: ID })));
    const failure = await api.downloadGatewayBundle('6f1d2c3b-4a59-4e8f-9b1e-2c7d5a4e9f10').catch((e) => e);
    expect(failure.message).toBe(`Could not generate the bundle. Reference: ${ID}`);
    expect(failure.status).toBe(500);
    expect(failure.details).toBeNull();
  });
});
