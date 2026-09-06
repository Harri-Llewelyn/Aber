import { describe, it, expect, vi } from 'vitest';

vi.mock('../constants', () => ({ STUDIO_URL: 'http://127.0.0.1:54323' }));

const { signOutOfStudio } = await import('../utils/studioSignOut');

describe('ending the session the gateway holds in front of Studio', () => {
  it('beacons the gateway signout path with the cookies attached', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ type: 'opaqueredirect' });

    await expect(signOutOfStudio(fetchImpl)).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:54323/oauth2/signout');
    // Without `credentials: include` the request carries no cookie, so the gateway has no session
    // to clear and answers 302 having done nothing -- the exact failure this helper exists to
    // avoid, and one that looks identical to success from here.
    expect(init.credentials).toBe('include');
    // Following the 302 would pull the browser into Studio's login flow to no purpose.
    expect(init.redirect).toBe('manual');
  });

  it('reports failure instead of throwing when Studio cannot be reached', async () => {
    // Kubernetes ships routes.studio false, so the address commonly resolves to nothing at all.
    // Sign-out must not depend on a second origin being up.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(signOutOfStudio(fetchImpl)).resolves.toBe(false);
  });

  it('gives up rather than hanging when Studio accepts the connection and never answers', async () => {
    // `fetch` has no default timeout. Left alone this would hold the sign-out open for as long as
    // the browser is willing to wait, which is a worse failure than the one being fixed.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );

      const settled = signOutOfStudio(fetchImpl);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(settled).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when no Studio address is configured', async () => {
    vi.resetModules();
    vi.doMock('../constants', () => ({ STUDIO_URL: '' }));
    const { signOutOfStudio: unconfigured } = await import('../utils/studioSignOut');

    const fetchImpl = vi.fn();
    await expect(unconfigured(fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
