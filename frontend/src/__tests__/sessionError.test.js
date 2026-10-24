import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';

const signOut = vi.fn().mockResolvedValue({ error: null });
const getUser = vi.fn();
const getSession = vi.fn();
vi.mock('../lib/supabaseClient', () => ({ supabase: { auth: { signOut, getUser, getSession } } }));

const {
  isInvalidSessionError, isSessionRefusal, isSessionRejected, askAuthServer, clearInvalidSession, describeAuthFailure
} = await import('../utils/sessionError');

beforeEach(() => vi.clearAllMocks());

describe('detecting a session the auth server has forgotten', () => {
  it('recognises the GoTrue message for a missing session row', () => {
    // What an Edge Function returns after auth.sessions is wiped (e.g. the database
    // volume was recreated) while the browser still holds a signature-valid JWT.
    expect(isInvalidSessionError('Session from session_id claim in JWT does not exist')).toBe(true);
    expect(isInvalidSessionError(new Error('Invalid user token'))).toBe(true);
    expect(isInvalidSessionError({ message: 'Invalid user token', details: 'Session from session_id claim in JWT does not exist' })).toBe(true);
    expect(isInvalidSessionError('JWT expired')).toBe(true);
  });

  it('does not mistake an authorization failure for a dead session', () => {
    // A valid session that simply lacks the role must not sign the user out.
    expect(isInvalidSessionError('Forbidden: Insufficient privileges')).toBe(false);
    expect(isInvalidSessionError('Missing required parameter: device_id')).toBe(false);
    expect(isInvalidSessionError(null)).toBe(false);
  });
});

describe("reading an edge function's refusal", () => {
  // What every function answers when its auth.getUser() fails, after the auth.sessions row went.
  const ended = { error: 'Invalid user token', details: 'Session from session_id claim in JWT does not exist' };

  it('recognises a 401 whose body says the session no longer exists', () => {
    expect(isSessionRefusal(401, ended)).toBe(true);
    expect(isSessionRefusal(401, { error: 'Invalid user token' })).toBe(true);
    expect(isSessionRefusal(401, { msg: 'JWT expired' })).toBe(true);
  });

  it('leaves a 401 that says something else, such as no token at all', () => {
    expect(isSessionRefusal(401, { error: 'Unauthorized', details: 'A signed-in session is required.' })).toBe(false);
    expect(isSessionRefusal(401, { error: 'Missing Authorization header' })).toBe(false);
    expect(isSessionRefusal(401, null)).toBe(false);
  });

  it('leaves any other status, whatever the body says', () => {
    expect(isSessionRefusal(403, { error: 'Forbidden: Insufficient privileges', details: 'Reading the broker requires Administrator.' })).toBe(false);
    expect(isSessionRefusal(500, ended)).toBe(false);
    expect(isSessionRefusal(undefined, ended)).toBe(false);
  });
});

describe('asking the auth server about the session', () => {
  const live = { access_token: 'token' };

  it('calls a session the server refused rejected', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await askAuthServer()).toMatchObject({ rejected: true, current: null });
  });

  it('calls a session supabase-js dropped rejected, whatever auth-js calls the error', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('A name this release has not seen', 400, 'some_new_code') });
    getSession.mockResolvedValue({ data: { session: null } });
    expect((await askAuthServer()).rejected).toBe(true);
  });

  it('never calls an unreachable server a refusal, even when an expired token could not be refreshed', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    getSession.mockResolvedValue({ data: { session: null } });
    expect((await askAuthServer()).rejected).toBe(false);

    getSession.mockResolvedValue({ data: { session: live } });
    expect((await askAuthServer()).rejected).toBe(false);
  });

  it('says a live session is live', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } }, error: null });
    getSession.mockResolvedValue({ data: { session: live } });
    expect(await askAuthServer()).toEqual({ error: null, current: live, rejected: false });
  });
});

describe('distinguishing a rejection from an unreachable server', () => {
  it('treats an explicit 401/403 as a rejection', () => {
    expect(isSessionRejected({ status: 403, message: 'invalid claim: missing sub claim' })).toBe(true);
    expect(isSessionRejected({ status: 401, message: 'Unauthorized' })).toBe(true);
  });

  it('treats the error auth-js makes of a 403 session_not_found as a rejection, despite its 400', () => {
    // GoTrue's answer once the auth.sessions row has gone: auth-js returns this in its place.
    const error = new AuthSessionMissingError();
    expect(error.status).toBe(400);
    expect(isSessionRejected(error)).toBe(true);
  });

  it('does NOT sign the user out when the auth server is simply unreachable', () => {
    // A dropped connection must not be mistaken for a revoked session -- signing
    // someone out over a network blip is worse than the stale session this guards.
    expect(isSessionRejected({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toBe(false);
    expect(isSessionRejected(new AuthRetryableFetchError('Failed to fetch', 0))).toBe(false);
    expect(isSessionRejected(new AuthRetryableFetchError('no healthy upstream', 503))).toBe(false);
    expect(isSessionRejected({ message: 'NetworkError when attempting to fetch resource' })).toBe(false);
    expect(isSessionRejected(null)).toBe(false);
  });

  it('still catches an unmistakable dead-session message without a status', () => {
    expect(isSessionRejected({ message: 'Session from session_id claim in JWT does not exist' })).toBe(true);
  });
});

describe('recovering from a dead session', () => {
  it('clears the stale tokens locally instead of asking the server to revoke them', async () => {
    const message = await clearInvalidSession();
    // scope 'local': the server-side session is already gone, so a remote revoke would
    // just fail again and leave the stale tokens in storage.
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(message).toMatch(/sign in again/i);
  });

  it('signs out and explains itself when a privileged call hits a dead session', async () => {
    const message = await describeAuthFailure(
      'Invalid user token: Session from session_id claim in JWT does not exist',
      'Quarantine approval denied or failed'
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(message).toMatch(/no longer valid/i);
  });

  it('passes other failures through untouched, staying signed in', async () => {
    const message = await describeAuthFailure('Forbidden: Insufficient privileges', 'fallback');
    expect(signOut).not.toHaveBeenCalled();
    expect(message).toBe('Forbidden: Insufficient privileges');
  });

  it('falls back when the error carries no message', async () => {
    expect(await describeAuthFailure(new Error(), 'Quarantine approval failed')).toBe('Quarantine approval failed');
    expect(signOut).not.toHaveBeenCalled();
  });
});
