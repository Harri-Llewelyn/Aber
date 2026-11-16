/**
 * The rail's signal for one page. A page can have several conditions to flag, one for each thing the
 * viewer can act on there: Devices has the devices with a firing alert and the devices awaiting
 * onboarding approval. Each is a part, `{ tone, count, note, tabNote? }`, kept by its own name; the
 * page's signal is built from its parts, so no number is ever the sum of two conditions.
 *
 *   tone      `danger` or `warning`.
 *   count     what the badge shows.
 *   note      the words, carried on the item's title and label.
 *   tabNote   the words on the page's tab that carries this part, when they are shorter than `note`
 *             ("3 waiting"). Defaults to `note`.
 *
 * The page's own row shows its most urgent part's tone and count, and names every part in its note,
 * so the colour and the number are never the only signal.
 */

import { countedAlerts } from './alertSuppression';

/** Most urgent first. */
const URGENCY = { danger: 0, warning: 1 };

/** The parts in the order they are shown: the most urgent first, a tie keeping the order given. */
export function orderedParts(parts = {}) {
  return Object.entries(parts)
    .map(([key, part], i) => ({ key, part, i }))
    .sort((a, b) => (URGENCY[a.part.tone] ?? 2) - (URGENCY[b.part.tone] ?? 2) || a.i - b.i)
    .map(({ key, part }) => ({ key, ...part }));
}

/**
 * A page's signal from its parts, or null with none: the most urgent part's tone and count, and a
 * note that names every part, most urgent first ("2 devices with a firing alert · 1 device awaiting
 * zero-touch onboarding approval").
 */
export function signalFromParts(parts = {}) {
  const list = orderedParts(parts);
  if (list.length === 0) return null;
  return {
    tone: list[0].tone,
    count: list[0].count,
    note: list.map((p) => p.note).join(' · '),
    parts,
  };
}

/** The key of the part the page's own row leads with, or null. */
export const leadKey = (signal) => orderedParts(signal?.parts)[0]?.key ?? null;

/**
 * How many devices (or gateways) have a firing alert nobody is on: unacknowledged, and with no
 * suppression window over it. Counted by subject, not by alert, so a device with three alerts is
 * one. An alert names its subject by the issued Sparkplug id and the nullable `entity_id`, and two
 * alerts that share either are one subject, as `alertIndex()` finds a device by both. A row with
 * neither is counted on its own: it names nothing to merge it with.
 *
 * @param {Array} alerts The firing alerts `usePlatformAlerts` keeps, as the counter reads them.
 * @param {'device'|'gateway'} kind `entity_type`; a row without one is a device's.
 */
export function countAlertedSubjects(alerts = [], kind = 'device') {
  const parent = new Map();
  const find = (k) => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };
  for (const alert of countedAlerts(alerts)) {
    if ((alert?.entity_type ?? 'device') !== kind) continue;
    const keys = [alert.sparkplug_id, alert.entity_id].filter(Boolean);
    if (keys.length === 0) keys.push(`fingerprint:${alert.fingerprint ?? alert.id}`);
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) parent.set(find(k), find(keys[0]));
  }
  return new Set([...parent.keys()].map(find)).size;
}
