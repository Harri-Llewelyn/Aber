import { describe, it, expect } from 'vitest';
import {
  deviceSparkplugId,
  gatewaySparkplugId,
  isSparkplugId,
  effectiveSparkplugId,
  SPARKPLUG_ID_LENGTH
} from '../utils/sparkplugId';

// These must stay in step with the generated column in
// supabase/migrations/20260101000014_sparkplug_identity.sql:
//   'dev' || substr(encode(uuid_send(id), 'hex'), 1, 21)
// If the two ever diverge, the UI silently queries telemetry for a device that does not exist.
describe('sparkplug wire identifiers', () => {
  const UUID = 'ccd19944-8805-4c11-ae66-ea0d2c50f40c';

  it('derives a device id as the prefix plus 21 unhyphenated hex characters', () => {
    expect(deviceSparkplugId(UUID)).toBe('devccd1994488054c11ae66e');
    expect(deviceSparkplugId(UUID)).toHaveLength(SPARKPLUG_ID_LENGTH);
  });

  it('derives a gateway id from the same UUID with the gateway prefix', () => {
    expect(gatewaySparkplugId(UUID)).toBe('gwyccd1994488054c11ae66e');
  });

  it('normalises uppercase UUIDs, since the SQL side emits lowercase hex', () => {
    expect(deviceSparkplugId(UUID.toUpperCase())).toBe(deviceSparkplugId(UUID));
  });

  it('returns empty for anything that is not a UUID rather than fabricating an id', () => {
    expect(deviceSparkplugId('Simulated_CNC_01')).toBe('');
    expect(deviceSparkplugId(null)).toBe('');
    expect(deviceSparkplugId(undefined)).toBe('');
  });

  it('validates the wire format', () => {
    expect(isSparkplugId('devccd1994488054c11ae66e')).toBe(true);
    expect(isSparkplugId('gwyccd1994488054c11ae66e')).toBe(true);
    // One character short -- the truncation case the format check exists to catch.
    expect(isSparkplugId('devccd1994488054c11ae66')).toBe(false);
    // Right length, wrong alphabet.
    expect(isSparkplugId('devccd1994488054c11ae66z')).toBe(false);
    expect(isSparkplugId('Simulated_CNC_01')).toBe(false);
    expect(isSparkplugId(null)).toBe(false);
  });

  describe('effectiveSparkplugId', () => {
    it('prefers what the device actually published over the id it was issued', () => {
      // A vendor device with a factory-preset id cannot be made to publish an issued one.
      expect(effectiveSparkplugId({
        id: UUID,
        sparkplug_id: 'devccd1994488054c11ae66e',
        reported_identity: 'devaaaaaaaaaaaaaaaaaaaaa'
      })).toBe('devaaaaaaaaaaaaaaaaaaaaa');
    });

    it('falls back to the stored issued id', () => {
      expect(effectiveSparkplugId({ id: UUID, sparkplug_id: 'devccd1994488054c11ae66e' }))
        .toBe('devccd1994488054c11ae66e');
    });

    it('derives from the UUID when the row was fetched without the column', () => {
      expect(effectiveSparkplugId({ id: UUID })).toBe('devccd1994488054c11ae66e');
    });

    it('is empty for a missing device', () => {
      expect(effectiveSparkplugId(null)).toBe('');
    });
  });
});
