import { describe, it, expect } from 'vitest';
import {
  GATEWAY_STATUS_AWAITING_BIRTH,
  GATEWAY_STATUS_PENDING_ENROLMENT,
  HEARTBEAT_STALE_MS,
  formatCountdown,
  gatewayLiveStatus,
  gatewayNeedsAttention,
  isGatewayOnline,
  isGatewayPending,
  tokenTimeRemaining
} from '../utils/gatewayStatus';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const agoMs = (ms) => new Date(NOW - ms).toISOString();
const inMs = (ms) => new Date(NOW + ms).toISOString();

describe('the two physical-gateway enrolment states', () => {
  it('recognises both as pending and nothing else', () => {
    expect(isGatewayPending({ status: GATEWAY_STATUS_PENDING_ENROLMENT })).toBe(true);
    expect(isGatewayPending({ status: GATEWAY_STATUS_AWAITING_BIRTH })).toBe(true);
    for (const status of ['ONLINE', 'OFFLINE', 'STALE', undefined, null, '']) {
      expect(isGatewayPending({ status })).toBe(false);
    }
    expect(isGatewayPending(null)).toBe(false);
  });

  it('passes a pending status through untouched', () => {
    expect(gatewayLiveStatus({ status: GATEWAY_STATUS_PENDING_ENROLMENT, last_heartbeat: null }, NOW))
      .toBe('PENDING_ENROLLMENT');
    expect(gatewayLiveStatus({ status: GATEWAY_STATUS_AWAITING_BIRTH, last_heartbeat: null }, NOW))
      .toBe('AWAITING_BIRTH');
  });

  /**
   * THE BUG THIS PINS, and the reason the short-circuit is ordered ahead of the staleness check.
   *
   * A gateway being RE-ENROLLED -- replaced hardware, a rotated credential -- carries the OLD
   * heartbeat from its previous life. Under the naive ordering that heartbeat is months stale, so
   * the badge said STALE while the truth was "waiting for its first message from the new appliance".
   * PENDING_ENROLLMENT survived by luck (its heartbeat is NULL); AWAITING_BIRTH did not.
   */
  it('does NOT downgrade a re-enrolled gateway to STALE on its old heartbeat', () => {
    const reEnrolled = {
      status: GATEWAY_STATUS_AWAITING_BIRTH,
      last_heartbeat: agoMs(HEARTBEAT_STALE_MS * 1000)
    };
    expect(gatewayLiveStatus(reEnrolled, NOW)).toBe('AWAITING_BIRTH');
    expect(isGatewayOnline(reEnrolled, NOW)).toBe(false);
  });

  it('still ages out a genuinely quiet ONLINE gateway', () => {
    // The pending short-circuit must not have broken the case it sits in front of.
    expect(gatewayLiveStatus({ status: 'ONLINE', last_heartbeat: agoMs(HEARTBEAT_STALE_MS + 1000) }, NOW))
      .toBe('STALE');
  });
});

describe('gatewayNeedsAttention', () => {
  /**
   * The Cells page turns a cell amber when a gateway in it needs attention. Before the enrolment
   * states existed the test was `live_status !== 'ONLINE'`, which flags every appliance still in its
   * box -- so ordering four gateways on a Monday lit up every cell they belong to, which is exactly
   * when the signal needs to still mean something.
   */
  it('does not flag a gateway that is merely mid-enrolment', () => {
    expect(gatewayNeedsAttention({ status: GATEWAY_STATUS_PENDING_ENROLMENT }, NOW)).toBe(false);
    expect(gatewayNeedsAttention({
      status: GATEWAY_STATUS_AWAITING_BIRTH,
      last_heartbeat: agoMs(HEARTBEAT_STALE_MS * 1000)
    }, NOW)).toBe(false);
  });

  it('flags a gateway that has gone quiet or died', () => {
    expect(gatewayNeedsAttention({ status: 'OFFLINE' }, NOW)).toBe(true);
    expect(gatewayNeedsAttention({ status: 'ONLINE', last_heartbeat: agoMs(HEARTBEAT_STALE_MS + 1) }, NOW))
      .toBe(true);
  });

  it('does not flag a healthy gateway', () => {
    expect(gatewayNeedsAttention({ status: 'ONLINE', last_heartbeat: agoMs(1000) }, NOW)).toBe(false);
  });

  it('does not flag an archived gateway, whatever its status', () => {
    // Decommissioned on purpose. The pages that show it label it ARCHIVED rather than as a fault.
    expect(gatewayNeedsAttention({ status: 'OFFLINE', is_archived: true }, NOW)).toBe(false);
  });

  it('is defensive about a missing gateway', () => {
    expect(gatewayNeedsAttention(null, NOW)).toBe(false);
  });
});

describe('enrolment token countdown', () => {
  it('reports time remaining, and does not clamp a passed deadline', () => {
    expect(tokenTimeRemaining(inMs(90_000), NOW)).toBe(90_000);
    // Negative on purpose: the modal distinguishes "expires in 4 minutes" from "expired 20 minutes
    // ago", and clamping here would erase that difference for every caller.
    expect(tokenTimeRemaining(agoMs(5_000), NOW)).toBe(-5_000);
  });

  it('returns null when there is nothing to count down', () => {
    expect(tokenTimeRemaining(null, NOW)).toBeNull();
    expect(tokenTimeRemaining('not-a-date', NOW)).toBeNull();
  });

  it('formats mm:ss and says Expired past zero', () => {
    expect(formatCountdown(90_000)).toBe('1:30');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(30 * 60_000)).toBe('30:00');
    expect(formatCountdown(0)).toBe('Expired');
    expect(formatCountdown(-1)).toBe('Expired');
    expect(formatCountdown(null)).toBe('—');
  });
});
