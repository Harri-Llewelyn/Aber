import { describe, it, expect, vi, beforeEach } from 'vitest';

const signOut = vi.fn().mockResolvedValue({ error: null });
vi.mock('../lib/supabaseClient', () => ({ supabase: { auth: { signOut } } }));

const { isInvalidSessionError, isSessionRejected, clearInvalidSession, describeAuthFailure } =
  await import('../utils/sessionError');

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

describe('distinguishing a rejection from an unreachable server', () => {
  it('treats an explicit 401/403 as a rejection', () => {
    expect(isSessionRejected({ status: 403, message: 'invalid claim: missing sub claim' })).toBe(true);
    expect(isSessionRejected({ status: 401, message: 'Unauthorized' })).toBe(true);
  });

  it('does NOT sign the user out when the auth server is simply unreachable', () => {
    // A dropped connection must not be mistaken for a revoked session -- signing
    // someone out over a network blip is worse than the stale session this guards.
    expect(isSessionRejected({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toBe(false);
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
