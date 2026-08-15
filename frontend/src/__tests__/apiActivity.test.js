import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginRequest,
  endRequest,
  activeRequestCount,
  subscribeToApiActivity,
  withActivityTracking,
  trackRequest,
  resetApiActivity
} from '../lib/apiActivity';

// Mocked exactly as apiPaths.test.js does, so the REAL api module can be imported and its wrapping
// verified without a database. This is the half that cannot be unit-tested away: withActivityTracking
// can be perfect and the indicator still dead if api.js forgets to apply it.
vi.mock('../lib/supabaseClient', () => {
  const builder = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: [], error: null }),
    then: vi.fn((resolve) => resolve({ data: [], error: null }))
  };
  return {
    supabase: {
      from: vi.fn(() => builder),
      functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) }
    },
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'anon'
  };
});

beforeEach(() => {
  resetApiActivity();
});

describe('in-flight request counter', () => {
  it('counts up and back down', () => {
    expect(activeRequestCount()).toBe(0);
    beginRequest();
    beginRequest();
    expect(activeRequestCount()).toBe(2);
    endRequest();
    expect(activeRequestCount()).toBe(1);
    endRequest();
    expect(activeRequestCount()).toBe(0);
  });

  // An unbalanced end is the failure that HIDES every later request: drive the count negative once
  // and the indicator never lights again for the rest of the session, silently.
  it('never goes negative on an unbalanced end', () => {
    endRequest();
    endRequest();
    expect(activeRequestCount()).toBe(0);

    beginRequest();
    expect(activeRequestCount()).toBe(1);
  });

  it('tells subscribers about every change, and stops on unsubscribe', () => {
    const seen = [];
    const unsubscribe = subscribeToApiActivity(n => seen.push(n));

    beginRequest();
    endRequest();
    expect(seen).toEqual([1, 0]);

    unsubscribe();
    beginRequest();
    expect(seen).toEqual([1, 0]);
  });
});

describe('withActivityTracking', () => {
  it('counts an async method for exactly as long as it is outstanding', async () => {
    let release;
    const wrapped = withActivityTracking({
      save: () => new Promise(resolve => { release = resolve; })
    });

    const promise = wrapped.save();
    expect(activeRequestCount()).toBe(1);

    release('ok');
    await expect(promise).resolves.toBe('ok');
    expect(activeRequestCount()).toBe(0);
  });

  it('balances a rejected call', async () => {
    const wrapped = withActivityTracking({
      save: () => Promise.reject(new Error('nope'))
    });

    await expect(wrapped.save()).rejects.toThrow('nope');
    expect(activeRequestCount()).toBe(0);
  });

  // api.get('/nonsense') throws before it ever awaits. Without the sync arm of the wrapper that
  // begin would never be matched, and one bad path would wedge the indicator on forever.
  it('balances a method that throws synchronously', () => {
    const wrapped = withActivityTracking({
      save: () => { throw new Error('bad path'); }
    });

    expect(() => wrapped.save()).toThrow('bad path');
    expect(activeRequestCount()).toBe(0);
  });

  it('passes arguments and return values straight through', async () => {
    const wrapped = withActivityTracking({ add: async (a, b) => a + b });
    await expect(wrapped.add(2, 3)).resolves.toBe(5);
  });

  it('copies non-function properties untouched', () => {
    const wrapped = withActivityTracking({ PAGE_SIZE: 500, load: async () => null });
    expect(wrapped.PAGE_SIZE).toBe(500);
  });
});

describe('trackRequest', () => {
  // The two approve-quarantine calls invoke the Edge Function on the supabase client directly and
  // never pass the api wrapper, so they count themselves.
  it('counts a call that does not go through api', async () => {
    let release;
    const promise = trackRequest(() => new Promise(resolve => { release = resolve; }));
    expect(activeRequestCount()).toBe(1);

    release('done');
    await expect(promise).resolves.toBe('done');
    expect(activeRequestCount()).toBe(0);
  });

  it('balances a failure', async () => {
    await expect(trackRequest(() => Promise.reject(new Error('edge down')))).rejects.toThrow('edge down');
    expect(activeRequestCount()).toBe(0);
  });
});

/**
 * The wiring, not the mechanism. Everything above would pass with `export const api = apiMethods`
 * in api.js and no indicator anywhere in the app.
 */
describe('the exported api is wrapped', () => {
  it('counts a real call through api.get', async () => {
    const { api } = await import('../api');
    const seen = [];
    subscribeToApiActivity(n => seen.push(n));

    await api.get('/api/v1/cells');

    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBe(0);
    expect(activeRequestCount()).toBe(0);
  });

  it('counts a mutation through api.post', async () => {
    const { api } = await import('../api');
    const seen = [];
    subscribeToApiActivity(n => seen.push(n));

    await api.post('/api/v1/cells', { cell_name: 'Bay 4' });

    expect(seen[0]).toBe(1);
    expect(activeRequestCount()).toBe(0);
  });

  // An unhandled path throws out of the api method. It still has to balance.
  it('balances a call that throws on an unknown path', async () => {
    const { api } = await import('../api');
    await expect(api.get('/api/v1/nothing-here')).rejects.toThrow();
    expect(activeRequestCount()).toBe(0);
  });
});
