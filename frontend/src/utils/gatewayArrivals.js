/**
 * What arrives from a gateway, as its drawer says it: three figures Prometheus holds for the
 * gateway's edge node, read once a minute into `gateway_arrivals` (0303), and when each of its
 * devices last sent a reading, read live from the historian. The two are read on their own, so a
 * historian outage leaves the three figures standing.
 *
 * A figure with no fresh answer is not observed, never the last value: the view blanks a row older
 * than ARRIVAL_FRESH_MINUTES, and a read that failed is the same as no answer.
 */

import { formatCount, formatRate } from './systemFigures';
import { formatDateTime, formatRelative } from './format';

/**
 * The `gateway_arrivals` columns the drawer reads, in the order it shows them. Mirror check 121
 * (scripts/check-mirror-drift.mjs) holds this list to the table and to the collector's query.
 */
export const ARRIVAL_COLUMNS = Object.freeze([
  'messages_per_second',
  'sequence_gaps_last_hour',
  'messages_missed_last_hour',
]);

/**
 * How old Prometheus's answer may be, in minutes, before the figure reads not observed. The view
 * says the same in SQL; mirror check 122 holds the two equal.
 */
export const ARRIVAL_FRESH_MINUTES = 3;

/** How often the drawer reads again. The figures change once a minute. */
export const ARRIVALS_POLL_MS = 15000;

/** What a figure with no value says, in words. */
export const NOT_OBSERVED = 'Not observed';

/** The help beside each row and beside the device list, each about 35 words. */
export const ARRIVAL_HELP = Object.freeze({
  messages_per_second:
    'Sparkplug messages from this gateway that the ingestion service acted on, per second, averaged '
    + 'over the last 5 minutes. Read from Prometheus once a minute.',
  sequence_gaps_last_hour:
    'Times in the last hour that a message\'s sequence number skipped ahead: at least one message from '
    + 'this gateway never arrived. Each gap asks the gateway to send its birth again.',
  messages_missed_last_hour:
    'How many messages those gaps skipped over. A lower bound: a gap of more than 255 messages wraps '
    + 'the 8-bit sequence number and is undercounted.',
  unobserved: `${NOT_OBSERVED}: Prometheus gave no answer in the last ${ARRIVAL_FRESH_MINUTES} minutes.`,
  last_reading:
    'When each device last sent a reading, from the historian. Not observed means the historian could '
    + 'not be read. The figures in Arriving do not need it.',
});

/** A finite number, or null: NULL, a string and NaN are not figures. */
const figure = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The three figures of one settled read of `gateway_arrivals`, each a number or null. A read that
 * failed, and a gateway with no row, have none.
 *
 * @param {PromiseSettledResult} result `Promise.allSettled()`'s entry for api.gatewayArrivals().
 * @returns {{ perSecond: ?number, gaps: ?number, missed: ?number, observedAt: ?string }}
 */
export function arrivalFigures(result) {
  const row = result?.status === 'fulfilled' ? result.value : null;
  return {
    perSecond: figure(row?.messages_per_second),
    gaps: figure(row?.sequence_gaps_last_hour),
    missed: figure(row?.messages_missed_last_hour),
    observedAt: row?.observed_at || null,
  };
}

/** Whether a count reads as at least one: `increase()` extrapolates, so 0.4 is none and 6.98 is 7. */
export const hasCount = (v) => v !== null && Math.round(v) >= 1;

/**
 * The group heading's words while it is closed: the rate, and whether messages are going missing,
 * with the warning tone when a gap was counted. "Not observed" when no figure was.
 *
 * @returns {{ text: string, tone: (string|undefined) }}
 */
export function arrivalSummary({ perSecond, gaps }) {
  const parts = [];
  if (perSecond !== null) parts.push(`${formatRate(perSecond)} messages/s`);
  if (gaps !== null) parts.push(hasCount(gaps) ? `${formatCount(gaps)} ${Math.round(gaps) === 1 ? 'gap' : 'gaps'}` : 'no gaps');
  if (parts.length === 0) return { text: NOT_OBSERVED, tone: undefined };
  return { text: parts.join(' · '), tone: hasCount(gaps) ? 'warning' : undefined };
}

/**
 * The devices' last readings of one settled read of gateway_devices_last_reading(), as a Map of
 * device id to the time (an ISO string, or null for a device with no reading). Null when the read
 * failed: the historian could not be reached, which is not the same as no reading.
 *
 * @param {PromiseSettledResult} result
 * @returns {?Map<string, ?string>}
 */
export function lastReadings(result) {
  if (result?.status !== 'fulfilled' || !Array.isArray(result.value)) return null;
  return new Map(result.value.map(r => [r.device_id, r.last_reading_at || null]));
}

/**
 * What the device list says beside one device: when it last sent a reading, that it has none, or
 * that the historian could not be read. Null for a device the read did not list (an archived one,
 * or one added since), and before the first read.
 *
 * @param {?Map} readings lastReadings()'s answer, or null when the read failed.
 * @param {string} deviceId
 * @param {number} [now]
 * @returns {?{ text: string, title: string, kind: string }}
 */
export function deviceLastReading(readings, deviceId, now = Date.now()) {
  if (readings === null) {
    return { text: 'Last reading not observed', title: 'Not observed: the historian could not be read.', kind: 'unobserved' };
  }
  if (!readings.has(deviceId)) return null;
  const at = readings.get(deviceId);
  if (!at) return { text: 'No reading yet', title: 'The historian holds no reading from this device.', kind: 'none' };
  return { text: `Last reading ${formatRelative(at, now)}`, title: formatDateTime(at), kind: 'read' };
}
