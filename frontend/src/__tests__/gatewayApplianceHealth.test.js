/**
 * The appliance-health helpers on the Gateways page (migration 0035).
 *
 * WHY EACH OF THESE IS WORTH A TEST. Every one of them, broken, is wrong in the quiet direction --
 * a plausible number on a page an operator acts on:
 *
 *   * A ZERO READING AND AN UNREPORTED ONE MUST NOT RENDER THE SAME. Every column here is NULL on a
 *     virtual gateway and on any appliance running a bundle older than 0035. "0 B free" and "we
 *     have not been told" call for opposite responses, and the second is the common case.
 *   * AN EXPIRED CA MUST READ AS EXPIRED. It is the failure the whole item exists for, and a signed
 *     day count ("in -3d") is a number somebody has to decode at the moment they are least likely
 *     to bother.
 *   * THE WARNING WINDOW MUST MATCH THE ALERT. CERT_EXPIRY_WARN_DAYS mirrors the `lt 30` threshold
 *     in the Grafana rule; a UI warning on a different horizon sends an operator looking for a rule
 *     that has not fired.
 */
import { describe, it, expect } from 'vitest';
import {
  CERT_EXPIRY_WARN_DAYS,
  certExpiryDays,
  formatCertExpiry,
  isCertExpiring,
  formatBytes,
} from '../utils/gatewayStatus';

const NOW = Date.parse('2026-08-24T12:00:00Z');
const inDays = (d) => new Date(NOW + d * 86_400_000).toISOString();

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
    // THE DISTINCTION THAT MATTERS MOST. A gateway that has not told us is not a gateway whose
    // certificate has gone -- and null is what the panel turns into "Not set" rather than a
    // warning colour.
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
