/**
 * The appliance-health helpers on the Gateways page. Each, broken, is wrong in the quiet direction:
 * a zero reading and an unreported one must not render the same (every column is NULL on a host-run
 * gateway); an expired CA must read as expired rather than as a negative day count; and
 * CERT_EXPIRY_WARN_DAYS mirrors the Grafana rule's threshold so the UI warning and the alert agree.
 */
import { describe, it, expect } from 'vitest';
import {
  CERT_EXPIRY_WARN_DAYS,
  certExpiryDays,
  formatCertExpiry,
  holdsOlderRoot,
  isCertExpiring,
  formatBytes,
} from '../utils/gatewayStatus';

const NOW = Date.parse('2026-08-24T12:00:00Z');
const inDays = (d) => new Date(NOW + d * 86_400_000).toISOString();

describe('a gateway that has not been given the published root', () => {
  // The question between the two halves of a rotation: the root is re-issued and published, and
  // the broker's leaf must not be switched to it until every appliance has converged onto it.
  it('is one whose reported expiry is behind the platform root', () => {
    expect(holdsOlderRoot(inDays(30), inDays(395))).toBe(true);
  });

  it('is not one that has the same root, or one an hour of clock skew apart', () => {
    expect(holdsOlderRoot(inDays(395), inDays(395))).toBe(false);
    expect(holdsOlderRoot(inDays(395), inDays(395.2))).toBe(false);
  });

  it('is never one that reported nothing, or a platform that publishes nothing', () => {
    // Unknown is not behind. A gateway on an older bundle reports no expiry at all, and colouring
    // it as out of date would send somebody looking for a rotation that never happened.
    expect(holdsOlderRoot(null, inDays(395))).toBe(false);
    expect(holdsOlderRoot(inDays(30), null)).toBe(false);
    expect(holdsOlderRoot(inDays(30), undefined)).toBe(false);
    expect(holdsOlderRoot('not-a-date', inDays(395))).toBe(false);
  });

  it('is never one ahead of the platform, which is a leaf re-issued early', () => {
    expect(holdsOlderRoot(inDays(400), inDays(30))).toBe(false);
  });
});

describe('certificate expiry', () => {
  it('reports whole days remaining, and negative once it has passed', () => {
    expect(Math.round(certExpiryDays(inDays(90), NOW))).toBe(90);
    expect(Math.round(certExpiryDays(inDays(-3), NOW))).toBe(-3);
  });

  it('says EXPIRED rather than printing a negative number', () => {
    expect(formatCertExpiry(inDays(-3), NOW)).toBe('EXPIRED 3d ago');
    expect(formatCertExpiry(inDays(400), NOW)).toBe('in 400d');
    expect(formatCertExpiry(inDays(0.5), NOW)).toBe('expires today');
  });

  it('treats an unreported certificate as absent, not as expired', () => {
    // The distinction that matters most: a gateway that has not told us is not one whose
    // certificate has gone, and null becomes "Not set" rather than a warning colour.
    expect(certExpiryDays(null, NOW)).toBeNull();
    expect(formatCertExpiry(null, NOW)).toBeNull();
    expect(isCertExpiring(null, NOW)).toBe(false);
    expect(formatCertExpiry('not-a-date', NOW)).toBeNull();
  });

  it('warns on the same horizon the Grafana rule fires on', () => {
    expect(CERT_EXPIRY_WARN_DAYS).toBe(30);
    expect(isCertExpiring(inDays(CERT_EXPIRY_WARN_DAYS - 1), NOW)).toBe(true);
    expect(isCertExpiring(inDays(CERT_EXPIRY_WARN_DAYS + 1), NOW)).toBe(false);
    // Already gone is still inside the window; it is this condition found late, not a new one.
    expect(isCertExpiring(inDays(-10), NOW)).toBe(true);
  });
});

describe('byte formatting', () => {
  it('uses binary units, matching what df on the appliance reports', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(6_423_183_360)).toBe('6.0 GiB');
    // 48.83 GiB. Above 10 the fraction is dropped, so this rounds rather than truncating.
    expect(formatBytes(52_428_288_000)).toBe('49 GiB');
  });

  it('keeps zero distinguishable from unreported', () => {
    // A full disk and a silent appliance are opposite problems.
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes('nonsense')).toBeNull();
  });
});
