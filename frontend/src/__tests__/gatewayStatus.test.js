import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  gatewayLiveStatus,
  gatewayDisplayStatus,
  isGatewayOnline,
  formatHeartbeat,
  formatUptime
} from '../utils/gatewayStatus';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const agoMs = (ms) => new Date(NOW - ms).toISOString();

describe('gateway heartbeat freshness', () => {
  it('treats a recent heartbeat as fresh', () => {
    expect(isHeartbeatStale(agoMs(30_000), NOW)).toBe(false);
    expect(gatewayLiveStatus({ status: 'ONLINE', last_heartbeat: agoMs(30_000) }, NOW)).toBe('ONLINE');
    expect(isGatewayOnline({ status: 'ONLINE', last_heartbeat: agoMs(30_000) }, NOW)).toBe(true);
  });

  it('downgrades an ONLINE gateway to STALE once the heartbeat ages out', () => {
    const gateway = { status: 'ONLINE', last_heartbeat: agoMs(HEARTBEAT_STALE_MS + 1000) };
    expect(isHeartbeatStale(gateway.last_heartbeat, NOW)).toBe(true);
    expect(gatewayLiveStatus(gateway, NOW)).toBe('STALE');
    expect(isGatewayOnline(gateway, NOW)).toBe(false);
  });

  it('keeps an explicit OFFLINE status regardless of heartbeat age', () => {
    expect(gatewayLiveStatus({ status: 'OFFLINE', last_heartbeat: agoMs(1000) }, NOW)).toBe('OFFLINE');
  });

  it('does not invent staleness for a gateway that has never reported', () => {
    expect(isHeartbeatStale(null, NOW)).toBe(false);
    expect(gatewayLiveStatus({ status: 'ONLINE', last_heartbeat: null }, NOW)).toBe('ONLINE');
    expect(formatHeartbeat(null, NOW)).toBe('Never');
  });

  it('formats heartbeat age relative to now', () => {
    expect(formatHeartbeat(agoMs(12_000), NOW)).toBe('12s ago');
    expect(formatHeartbeat(agoMs(5 * 60_000), NOW)).toBe('5m ago');
    expect(formatHeartbeat(agoMs(3 * 3_600_000), NOW)).toBe('3h ago');
  });

  it('is defensive about unparseable timestamps', () => {
    expect(formatHeartbeat('not-a-date', NOW)).toBe('Never');
    expect(isHeartbeatStale('not-a-date', NOW)).toBe(false);
  });
});

describe('the Playback gateway status', () => {
  const playback = (fields) => ({ is_shadow: true, ...fields });

  it('reads PLAYING_BACK while its heartbeat is fresh', () => {
    expect(gatewayDisplayStatus(playback({ status: 'ONLINE', last_heartbeat: agoMs(30_000) }), NOW)).toBe('PLAYING_BACK');
  });

  it('reads IDLE when offline, stale or never heard from, never OFFLINE or STALE', () => {
    expect(gatewayDisplayStatus(playback({ status: 'OFFLINE' }), NOW)).toBe('IDLE');
    expect(gatewayDisplayStatus(playback({ status: 'ONLINE', last_heartbeat: agoMs(HEARTBEAT_STALE_MS + 1) }), NOW)).toBe('IDLE');
    expect(gatewayDisplayStatus(playback({}), NOW)).toBe('IDLE');
  });

  it('leaves every other gateway on its live status', () => {
    const stale = { status: 'ONLINE', last_heartbeat: agoMs(HEARTBEAT_STALE_MS + 1) };
    expect(gatewayDisplayStatus(stale, NOW)).toBe(gatewayLiveStatus(stale, NOW));
    expect(gatewayDisplayStatus({ status: 'OFFLINE' }, NOW)).toBe('OFFLINE');
  });
});

describe('formatUptime', () => {
  it('formats a duration at every scale, never a date', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(720)).toBe('12m');
    expect(formatUptime(3 * 3600 + 300)).toBe('3h 5m');
    expect(formatUptime(2 * 86400 + 4 * 3600)).toBe('2d 4h');
    expect(formatUptime(40 * 86400)).toBe('40d 0h');
  });

  it('is null for a missing or invalid value', () => {
    expect(formatUptime(null)).toBeNull();
    expect(formatUptime(undefined)).toBeNull();
    expect(formatUptime(-1)).toBeNull();
    expect(formatUptime('abc')).toBeNull();
  });
});
