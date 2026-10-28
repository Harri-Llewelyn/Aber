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
 * session failure the strip shows, through one check, once the auth server confirms it; any other
 * refusal stays the page's.
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
// The same label when the function could not reach the auth server at all.
const UNCHECKED = { error: 'Invalid user token', details: 'fetch failed' };
// A 401 for a request that carried no token, which says nothing about a session that existed.
const NO_TOKEN = { error: 'Unauthorized', details: 'A signed-in session is required.' };

/** A function's failed answer, as fetch() resolves it. */
const answer = (status, body) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: async () => body
});

const isUserCheck = (url) => String(url) === 'http://stack.test/auth/v1/user';

/**
 * Every function answers `status` with `body`, through fetch() and through invoke(), and the auth
 * server's /user answers `auth`: a status, 'unreachable' for a fetch that rejects, or a promise.
 */
function functionsAnswer(status, body, auth = 403) {
  const fetchMock = vi.fn(async (url) => {
    if (!isUserCheck(url)) return answer(status, body);
    const outcome = await auth;
    if (outcome === 'unreachable') throw new TypeError('Failed to fetch');
    return { ok: outcome === 200, status: outcome, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  supabase.functions.invoke.mockResolvedValue({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status }) }
  });
  return fetchMock;
}

const userChecks = (fetchMock) => fetchMock.mock.calls.filter(([url]) => isUserCheck(url)).length;

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
  ['broker-subscriber (create)', () => api.createBrokerSubscriber({ name: 'Line 4', description: 'Reads line 4.' })],
  ['broker-subscriber (delete)', () => api.deleteBrokerSubscriber('sub0a1b2c3d4e5f60718293a')],
  ['gateway-credential', () => api.mintGatewayCredential(ID)],
  ['mint-service-token', () => api.mintServiceToken(ID, 30)],
  ['aas-export (bundle)', () => api.post('/api/v1/devices/asset-export', { device_id: ID })],
  ['aas-export (AASX)', () => api.post('/api/v1/devices/aas-export', { device_id: ID, format: 'aasx' })],
  ['aas-export (JSON, through invoke)', () => api.post('/api/v1/devices/aas-export', { device_id: ID })]
];

describe('an edge function refusing the session', () => {
  beforeEach(() => resetConnectionState());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetConnectionState();
  });

  it.each(CALLS)('%s: a 401 saying the session no longer exists, which the auth server confirms, ends it for the strip', async (_label, call) => {
    const fetchMock = functionsAnswer(401, ENDED, 403);
    const failure = await call().catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe(SESSION_REFUSED);
    expect(classifyRefreshError(failure)).toBe(FAILURE_SESSION);
    expect(getConnectionSnapshot().status).toBe(CONNECTION_SESSION_ENDED);
    expect(userChecks(fetchMock)).toBe(1);
  });

  it.each(CALLS)('%s: a 401 that says something else is left to the page, unasked', async (_label, call) => {
    const fetchMock = functionsAnswer(401, NO_TOKEN, 403);
    const failure = await call().catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBeUndefined();
    expect(getConnectionSnapshot().status).toBe(CONNECTION_OK);
    expect(userChecks(fetchMock)).toBe(0);
  });

  // The functions answer "Invalid user token" for any failed getUser(), including one that never
  // reached the auth server, so the label alone proves nothing.
  it.each([
    ['answers a live user', 200, false],
    ['answers session_not_found', 403, true],
    ['answers a token it cannot use', 401, true],
    ['cannot be reached', 'unreachable', false],
    ['answers a 503', 503, false]
  ])('a 401 "Invalid user token" with details "fetch failed" when the auth server %s', async (_label, auth, ends) => {
    functionsAnswer(401, UNCHECKED, auth);
    const failure = await api.listBrokerInventory().catch((e) => e);
    expect(failure.message).toBe('fetch failed');
    expect(failure.code).toBe(ends ? SESSION_REFUSED : undefined);
    expect(getConnectionSnapshot().status).toBe(ends ? CONNECTION_SESSION_ENDED : CONNECTION_OK);
  });

  it('asks once for refusals that arrive together, and again for a later one', async () => {
    let release;
    const fetchMock = functionsAnswer(401, ENDED, new Promise((resolve) => { release = resolve; }));
    const together = Promise.all([
      api.listBrokerInventory().catch((e) => e),
      api.mintGatewayCredential(ID).catch((e) => e),
      api.enrolmentReadiness().catch((e) => e)
    ]);
    await vi.waitFor(() => expect(userChecks(fetchMock)).toBe(1));
    // The other two refusals reach the check while the first is still waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(403);
    const failures = await together;
    expect(failures.map((f) => f.code)).toEqual([SESSION_REFUSED, SESSION_REFUSED, SESSION_REFUSED]);
    expect(userChecks(fetchMock)).toBe(1);

    await api.listBrokerInventory().catch(() => {});
    expect(userChecks(fetchMock)).toBe(2);
  });

  it('leaves a refusal of the role to the page', async () => {
    const fetchMock = functionsAnswer(403, { error: 'Forbidden: Insufficient privileges', details: "Reading the broker's accounts requires Administrator." });
    const failure = await api.listBrokerInventory().catch((e) => e);
    expect(failure.message).toBe("Reading the broker's accounts requires Administrator.");
    expect(classifyRefreshError(failure)).toBe(FAILURE_OTHER);
    expect(getConnectionSnapshot().status).toBe(CONNECTION_OK);
    expect(userChecks(fetchMock)).toBe(0);
  });

  it("keeps the message and the bundle failure's status as they were", async () => {
    functionsAnswer(401, ENDED, 403);
    const failure = await api.downloadGatewayBundle(ID).catch((e) => e);
    expect(failure.message).toBe('Invalid user token');
    expect(failure.status).toBe(401);
    expect(failure.details).toBe(ENDED.details);

    const broker = await api.listBrokerInventory().catch((e) => e);
    expect(broker.message).toBe(ENDED.details);
  });
});
