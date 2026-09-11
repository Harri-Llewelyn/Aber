// Sparkplug B wire identity. Every gateway and device carries an immutable `sparkplug_id`: a
// 3-character type prefix plus 21 lowercase hex characters. It is what appears in the MQTT topic
// and what keys telemetry and `asset_config`; asset names are display labels only. The column is
// GENERATED ALWAYS from the row's UUID (0001_baseline_schema.sql), so it is derived locally to save
// a round-trip. Keep in step with the SQL: 'dev' || substr(encode(uuid_send(id), 'hex'), 1, 21).

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

/**
 * The identifier a device is reachable by on the wire. Third-party hardware with a factory-preset
 * Sparkplug id cannot publish a platform-issued one, so ingestion records what it saw in
 * `reported_identity`; where set, that is the id an engineer needs.
 */
export function effectiveSparkplugId(device) {
  if (!device) return '';
  return device.reported_identity || device.sparkplug_id || deviceSparkplugId(device.id);
}
