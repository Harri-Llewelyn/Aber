import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, telemetryLowerBound, TELEMETRY_DEFAULT_WINDOW_MINUTES } from '../api';

/**
 * THE PROPERTY UNDER TEST IS "NEVER UNBOUNDED", NOT "THE DEFAULT IS 60".
 *
 * `public.telemetry` is a postgres_fdw projection: the wrapper pushes WHERE down but not LIMIT,
 * so `.range()` bounds what Supabase RETURNS, never what TimescaleDB SCANS AND SHIPS. A query
 * with no lower time bound therefore drags an asset's whole history across the wrapper before
 * the ORDER BY can start, and the symptom -- a slow database -- names nothing about the caller
 * that omitted an argument.
 *
 * So the assertion that matters is that `gte('time', ...)` is present on EVERY path out of
 * queryTelemetry, including the ones no UI code takes today. Asserting the number 60 would pass
 * just as happily if some future branch stopped calling the helper at all.
 */

const calls = { gte: [], lte: [], eq: [], in: [], range: [] };

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((...a) => { calls.eq.push(a); return builder; }),
    in: vi.fn((...a) => { calls.in.push(a); return builder; }),
    gte: vi.fn((...a) => { calls.gte.push(a); return builder; }),
    lte: vi.fn((...a) => { calls.lte.push(a); return builder; }),
    // queryLatestTelemetry ends in .limit() rather than .range(): the result is bounded by
    // series count, not paged.
    limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
    order: vi.fn(() => builder),
    range: vi.fn((...a) => { calls.range.push(a); return Promise.resolve({ data: [], error: null }); }),
    then: vi.fn((resolve) => resolve({ data: [], error: null }))
  };
  return { supabase: { from: vi.fn(() => builder), functions: { invoke: vi.fn() } } };
});

const timeBounds = () => calls.gte.filter(([col]) => col === 'time');

beforeEach(() => {
  calls.gte.length = 0;
  calls.lte.length = 0;
  calls.eq.length = 0;
  calls.in.length = 0;
  calls.range.length = 0;
});

describe('telemetryLowerBound', () => {
  it('honours an explicit `from` verbatim, however old', () => {
    // The floor catches an ABSENT bound. Overruling a stated one would silently return fewer
    // rows than the operator asked for, which is worse than a slow query.
    const from = '2020-01-01T00:00:00.000Z';
    expect(telemetryLowerBound({ fromTime: from })).toBe(from);
  });

  it('uses the caller\'s window when one is given', () => {
    const bound = Date.parse(telemetryLowerBound({ minutes: 5 }));
    expect(Date.now() - bound).toBeGreaterThanOrEqual(5 * 60000);
    expect(Date.now() - bound).toBeLessThan(6 * 60000);
  });

  it('falls back to the default window when no bound is given at all', () => {
    const bound = Date.parse(telemetryLowerBound({}));
    const expected = TELEMETRY_DEFAULT_WINDOW_MINUTES * 60000;
    expect(Date.now() - bound).toBeGreaterThanOrEqual(expected);
    expect(Date.now() - bound).toBeLessThan(expected + 60000);
  });

  it('measures back from `to` when only `to` is supplied', () => {
    // Anchoring on now instead would return an empty page for any historical `to`, which reads
    // as "this device published nothing" rather than as a missing argument.
    const to = '2026-03-01T12:00:00.000Z';
    const bound = telemetryLowerBound({ toTime: to, minutes: 30 });
    expect(bound).toBe('2026-03-01T11:30:00.000Z');
  });

  it('treats an unparseable `to` as absent rather than producing an Invalid Date', () => {
    // `new Date(NaN).toISOString()` throws, and a swallowed throw here would drop the predicate
    // entirely -- reintroducing exactly the unbounded scan this guards against.
    expect(() => telemetryLowerBound({ toTime: 'not-a-date' })).not.toThrow();
    expect(Number.isFinite(Date.parse(telemetryLowerBound({ toTime: 'not-a-date' })))).toBe(true);
  });

  it('ignores a nonsensical window instead of inverting the range', () => {
    for (const minutes of [0, -30, NaN, undefined, null, 'sixty']) {
      const bound = Date.parse(telemetryLowerBound({ minutes }));
      expect(bound).toBeLessThanOrEqual(Date.now());
    }
  });
});

describe('queryTelemetry always bounds time', () => {
  const key = 'dev200000000000400080000';

  it('bounds a device query that names no window', async () => {
    await api.get(`/api/v1/telemetry?asset_id=${key}`);
    expect(timeBounds()).toHaveLength(1);
  });

  it('bounds a query with no parameters at all', async () => {
    await api.get('/api/v1/telemetry');
    expect(timeBounds()).toHaveLength(1);
  });

  // The /latest routes read `telemetry_latest`, where the DISTINCT ON has already happened
  // remotely. They still carry a lower bound -- as a STALENESS filter now rather than a scan
  // window -- so that a machine which last reported months ago does not present that reading as
  // its current state.
  it('bounds the fleet-wide latest query', async () => {
    await api.get('/api/v1/telemetry/latest');
    expect(timeBounds()).toHaveLength(1);
  });

  it('bounds the device-scoped latest query', async () => {
    await api.get(`/api/v1/devices/${key}/telemetry/latest`);
    expect(timeBounds()).toHaveLength(1);
  });

  it('bounds a query carrying only an upper bound', async () => {
    await api.get(`/api/v1/telemetry?asset_id=${key}&to=2026-03-01T12:00:00.000Z`);
    expect(calls.lte.some(([col]) => col === 'time')).toBe(true);
    expect(timeBounds()).toHaveLength(1);
  });

  it('does not add a second bound when the caller gave `from`', async () => {
    await api.get(`/api/v1/telemetry?asset_id=${key}&from=2026-02-01T00:00:00.000Z`);
    const bounds = timeBounds();
    expect(bounds).toHaveLength(1);
    expect(bounds[0][1]).toBe('2026-02-01T00:00:00.000Z');
  });
});
