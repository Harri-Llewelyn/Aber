// Sparkplug B identities. Every gateway and device carries an immutable, issued `sparkplug_id`: a
// 3-character type prefix plus 21 lowercase hex characters. It keys telemetry and `asset_config`;
// asset names are display labels only. A device that cannot publish it keeps its own id in the
// topic (deviceIds() below). The column is GENERATED ALWAYS from the row's UUID
// (0001_baseline_schema.sql), so it is derived locally to save a round-trip. Keep in step with the
// SQL: 'dev' || substr(encode(uuid_send(id), 'hex'), 1, 21).

import { isUuid } from './isUuid';

export const SPARKPLUG_ID_LENGTH = 24;
const DEVICE_ID_PREFIX = 'dev';
const GATEWAY_ID_PREFIX = 'gwy';

const HEX_CHARS = 21;
const SPARKPLUG_ID_REGEX = /^(dev|gwy)[0-9a-f]{21}$/;

function derive(prefix, uuid) {
  if (!isUuid(uuid)) return '';
  return prefix + uuid.toLowerCase().replace(/-/g, '').slice(0, HEX_CHARS);
}

/** The wire identifier for a device, derived from its UUID primary key. */
export function deviceSparkplugId(uuid) {
  return derive(DEVICE_ID_PREFIX, uuid);
}

/** The wire identifier for an edge gateway, derived from its UUID primary key. */
export function gatewaySparkplugId(uuid) {
  return derive(GATEWAY_ID_PREFIX, uuid);
}

/** True for a well-formed device or gateway wire identifier. */
export function isSparkplugId(val) {
  return typeof val === 'string' && SPARKPLUG_ID_REGEX.test(val);
}

// `devices.identity_source`: which id ingestion last resolved the device by (ingestion.py).
const SOURCE_SPARKPLUG_ID = 'sparkplug_id';
const SOURCE_INSTANCE_UUID = 'instance_uuid';

/**
 * A device's two Sparkplug ids. `issued` is its `sparkplug_id`, which readings, exports, the AAS
 * shell and i3X are keyed on. `published` is the id in its topic when that is another one, else
 * null. It follows `identity_source`: the UUID for `instance_uuid`, none for `sparkplug_id`, and
 * otherwise `reported_identity`, which covers a device not born since the column was recorded.
 */
export function deviceIds(device) {
  if (!device) return { issued: '', published: null };
  const uuid = device.id || device.asset_id || '';
  const issued = device.sparkplug_id || deviceSparkplugId(uuid);
  const source = device.identity_source;
  const published = source === SOURCE_SPARKPLUG_ID ? null
    : source === SOURCE_INSTANCE_UUID ? uuid
      : device.reported_identity;
  return { issued, published: published && published !== issued ? published : null };
}

/**
 * Every id a device answers to: its UUID, its issued and published ids, and an id it reported once,
 * which stays on the row after the device starts publishing its issued one. For search, and for a
 * link that names a device by any of them.
 */
export function deviceIdentifiers(device) {
  if (!device) return [];
  const { issued, published } = deviceIds(device);
  const ids = [device.asset_id || device.id, issued, published, device.reported_identity];
  return [...new Set(ids.filter(Boolean))];
}

/**
 * A device id as a lookup key: a UUID in lower case, since ingestion resolves a UUID in any letter
 * case, and any other id as it is. For matching an id a capture recorded against
 * deviceIdentifiers().
 */
export function deviceIdKey(id) {
  return isUuid(id) ? id.toLowerCase() : id;
}

/**
 * The characters a Sparkplug group may not contain. A group is one level of the topic,
 * spBv1.0/<group>/<type>/<node>, so a separator or a wildcard would address something else.
 * Mirrors gateways_sparkplug_group_format, with the empty string (check-mirror-drift.mjs, 1b).
 */
export const SPARKPLUG_GROUP_FORBIDDEN = '/+#';

/** Why `value` cannot be a gateway's Sparkplug group, as a sentence, or null when it can be. */
export function sparkplugGroupProblem(value) {
  const group = typeof value === 'string' ? value : '';
  if (group === '') return 'A Sparkplug group cannot be empty.';
  const found = [...SPARKPLUG_GROUP_FORBIDDEN].filter(c => group.includes(c));
  if (found.length) {
    return `A Sparkplug group is one level of the topic, so it cannot contain ${found.join(' or ')}.`;
  }
  return null;
}
