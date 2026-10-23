import { describe, it, expect } from 'vitest';
import {
  deviceSparkplugId,
  gatewaySparkplugId,
  isSparkplugId,
  deviceIds,
  deviceIdentifiers,
  deviceIdKey,
  sparkplugGroupProblem,
  SPARKPLUG_ID_LENGTH
} from '../utils/sparkplugId';

// These must stay in step with the generated column in
// supabase/migrations/0001_baseline_schema.sql: 'dev' || substr(encode(uuid_send(id), 'hex'), 1,
// 21). If the two diverge, the UI queries telemetry for a device that does not exist.
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

  describe('deviceIds', () => {
    const ISSUED = 'devccd1994488054c11ae66e';

    it('gives a device that publishes its own id both, the issued one first', () => {
      // A vendor device with a factory-preset id cannot be made to publish an issued one. Its
      // readings are still stored under the issued id.
      expect(deviceIds({
        id: UUID, sparkplug_id: ISSUED,
        reported_identity: 'Vendor_Press_07', identity_source: 'reported_identity'
      })).toEqual({ issued: ISSUED, published: 'Vendor_Press_07' });
    });

    it('gives a device addressed by its Factory+ Instance_UUID its UUID as the published id', () => {
      expect(deviceIds({ id: UUID, sparkplug_id: ISSUED, identity_source: 'instance_uuid' }))
        .toEqual({ issued: ISSUED, published: UUID });
    });

    it('drops an id the device once reported when it now publishes its issued one', () => {
      expect(deviceIds({
        id: UUID, sparkplug_id: ISSUED,
        reported_identity: 'Vendor_Press_07', identity_source: 'sparkplug_id'
      })).toEqual({ issued: ISSUED, published: null });
    });

    it('falls back to the reported id for a device not born since the source was recorded', () => {
      expect(deviceIds({ id: UUID, sparkplug_id: ISSUED, reported_identity: 'Vendor_Press_07' }))
        .toEqual({ issued: ISSUED, published: 'Vendor_Press_07' });
      expect(deviceIds({ id: UUID, sparkplug_id: ISSUED, identity_source: null }))
        .toEqual({ issued: ISSUED, published: null });
    });

    it('gives no published id when the reported one is the issued one', () => {
      // A device re-quarantined behind the wrong gateway records the id it published, its own.
      expect(deviceIds({ id: UUID, sparkplug_id: ISSUED, reported_identity: ISSUED }).published)
        .toBeNull();
    });

    it('derives the issued id from the UUID when the row was fetched without the column', () => {
      expect(deviceIds({ id: UUID }).issued).toBe(ISSUED);
      expect(deviceIds({ asset_id: UUID }).issued).toBe(ISSUED);
    });

    it('is empty for a missing device', () => {
      expect(deviceIds(null)).toEqual({ issued: '', published: null });
    });
  });

  describe('deviceIdentifiers', () => {
    it('names a device by its UUID, its issued id and the id it publishes under', () => {
      expect(deviceIdentifiers({
        asset_id: UUID, sparkplug_id: 'devccd1994488054c11ae66e',
        reported_identity: 'Vendor_Press_07', identity_source: 'reported_identity'
      })).toEqual([UUID, 'devccd1994488054c11ae66e', 'Vendor_Press_07']);
    });

    it('keeps an id the device reported once, which a link may still carry', () => {
      expect(deviceIdentifiers({
        asset_id: UUID, sparkplug_id: 'devccd1994488054c11ae66e',
        reported_identity: 'Vendor_Press_07', identity_source: 'sparkplug_id'
      })).toContain('Vendor_Press_07');
    });

    it('is empty for a missing device', () => {
      expect(deviceIdentifiers(undefined)).toEqual([]);
    });
  });

  // A capture records the id on the wire, which may be a device's UUID in either letter case.
  describe('deviceIdKey', () => {
    it('keys a UUID in lower case, so a capture of one in upper case finds its device', () => {
      expect(deviceIdKey(UUID.toUpperCase())).toBe(UUID);
      expect(new Set(deviceIdentifiers({ asset_id: UUID }).map(deviceIdKey)).has(deviceIdKey(UUID.toUpperCase()))).toBe(true);
    });

    it('keeps any other id as it is, since an own id is matched exactly', () => {
      expect(deviceIdKey('Vendor_Press_07')).toBe('Vendor_Press_07');
      expect(deviceIdKey('devccd1994488054c11ae66e')).toBe('devccd1994488054c11ae66e');
    });
  });
});

// The same rule as gateways_sparkplug_group_format: not empty, and none of / + #.
describe('sparkplugGroupProblem', () => {
  it('accepts a group that is one topic level', () => {
    for (const group of ['Aber', 'Plant-B', 'site 7', 'a.b_c']) {
      expect(sparkplugGroupProblem(group)).toBeNull();
    }
  });

  it('refuses an empty group, and says so', () => {
    expect(sparkplugGroupProblem('')).toBe('A Sparkplug group cannot be empty.');
    expect(sparkplugGroupProblem(undefined)).toBe('A Sparkplug group cannot be empty.');
  });

  it('refuses a separator or a wildcard, naming each one found', () => {
    const refusal = (chars) => `A Sparkplug group is one level of the topic, so it cannot contain ${chars}.`;
    expect(sparkplugGroupProblem('a/b')).toBe(refusal('/'));
    expect(sparkplugGroupProblem('a+b')).toBe(refusal('+'));
    expect(sparkplugGroupProblem('#')).toBe(refusal('#'));
    expect(sparkplugGroupProblem('a/b#')).toBe(refusal('/ or #'));
  });
});
