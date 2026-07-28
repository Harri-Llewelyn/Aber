import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  gatewayLiveStatus,
  isGatewayOnline,
  formatHeartbeat
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
