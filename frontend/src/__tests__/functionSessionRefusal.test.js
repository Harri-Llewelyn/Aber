import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';
import {
  CONNECTION_OK,
  CONNECTION_SESSION_ENDED,
  FAILURE_OTHER,
  FAILURE_SESSION,
  SESSION_REFUSED,
  classifyRefreshError,
  getConnectionSnapshot,
  resetConnectionState
} from '../lib/connectionState';
import { supabase } from '../lib/supabaseClient';

/**
 * Every edge-function call in api.js turns an answer that the session no longer exists into a
 * session failure the strip shows, through one check; any other refusal stays the page's.
 */

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }) },
    functions: { invoke: vi.fn() }
  }
}));

const ID = '6f1d2c3b-4a59-4e8f-9b1e-2c7d5a4e9f10';

// What a function answers once the auth.sessions row has gone: its auth.getUser() is refused.
const ENDED = { error: 'Invalid user token', details: 'Session from session_id claim in JWT does not exist' };
// A 401 for a request that carried no token, which says nothing about a session that existed.
const NO_TOKEN = { error: 'Unauthorized', details: 'A signed-in session is required.' };

/** A function's failed answer, as fetch() resolves it. */
const answer = (status, body) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => body
});

/** Each edge-function call in api.js, by the function it calls. */
const CALLS = [
  ['gateway-bundle (bundle)', () => api.downloadGatewayBundle(ID)],
  ['gateway-bundle (install command)', () => api.installCommand(ID)],
  ['gateway-bundle (readiness)', () => api.enrolmentReadiness()],
  ['manage-people', () => api.managePeople({ action: 'set-password', user_id: ID })],
  ['manage-people (add)', () => api.addPerson('new@aber.local', 'Operator')],
  ['manage-people (remove)', () => api.removePersonAccess(ID)],
  ['manage-people (restore)', () => api.restorePersonAccess(ID)],
  ['broker-inventory', () => api.listBrokerInventory()],
  ['gateway-credential', () => api.mintGatewayCredential(ID)],
  ['mint-service-token', () => api.mintServiceToken(ID, 30)],
  ['aas-export (bundle)', () => api.post('/api/v1/devices/asset-export', { device_id: ID })],
  ['aas-export (AASX)', () => api.post('/api/v1/devices/aas-export', { device_id: ID, format: 'aasx' })]
];

/** Make every function answer `status` with `body`, through fetch() and through invoke(). */
function functionsAnswer(status, body) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(status, body)));
  supabase.functions.invoke.mockResolvedValue({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status }) }
  });
}

const ALL_CALLS = [...CALLS, ['aas-export (JSON, through invoke)', () => api.post('/api/v1/devices/aas-export', { device_id: ID })]];

describe('an edge function refusing the session', () => {
  beforeEach(() => resetConnectionState());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetConnectionState();
  });

  it.each(ALL_CALLS)('%s: a 401 saying the session no longer exists ends it for the strip', async (_label, call) => {
    functionsAnswer(401, ENDED);
    const failure = await call().catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe(SESSION_REFUSED);
    expect(classifyRefreshError(failure)).toBe(FAILURE_SESSION);
    expect(getConnectionSnapshot().status).toBe(CONNECTION_SESSION_ENDED);
  });

  it.each(ALL_CALLS)('%s: a 401 that says something else is left to the page', async (_label, call) => {
    functionsAnswer(401, NO_TOKEN);
    const failure = await call().catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBeUndefined();
    expect(getConnectionSnapshot().status).toBe(CONNECTION_OK);
  });

  it('leaves a refusal of the role to the page', async () => {
    functionsAnswer(403, { error: 'Forbidden: Insufficient privileges', details: "Reading the broker's accounts requires Administrator." });
    const failure = await api.listBrokerInventory().catch((e) => e);
    expect(failure.message).toBe("Reading the broker's accounts requires Administrator.");
    expect(classifyRefreshError(failure)).toBe(FAILURE_OTHER);
    expect(getConnectionSnapshot().status).toBe(CONNECTION_OK);
  });

  it("keeps the message and the bundle failure's status as they were", async () => {
    functionsAnswer(401, ENDED);
    const failure = await api.downloadGatewayBundle(ID).catch((e) => e);
    expect(failure.message).toBe('Invalid user token');
    expect(failure.status).toBe(401);
    expect(failure.details).toBe(ENDED.details);

    const broker = await api.listBrokerInventory().catch((e) => e);
    expect(broker.message).toBe(ENDED.details);
  });
});
