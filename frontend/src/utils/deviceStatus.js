/**
 * A device's lifecycle status, and how it is drawn: one definition for every render site (the
 * Overview map, the Devices table and the context drawer).
 *
 * The map used to run a client-side rule engine over the latest telemetry with literal
 * thresholds, no persistence and exact metric names, and conflated process condition with
 * connectivity lifecycle. Threshold and condition alerting belongs in Grafana; what is left here
 * is what the platform knows about the device, from the database.
 */

/**
 * The three lifecycle states, in the order of precedence they are resolved in. QUARANTINED
 * outranks OFFLINE: a quarantined device is waiting to be admitted, and OFFLINE would say "this
 * went away" about something never let in.
 */
export const DEVICE_STATUS = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  QUARANTINED: 'QUARANTINED',
};

/**
 * Resolve a device row to one of DEVICE_STATUS. Reads only database-backed fields:
 * `is_quarantined` (set by ingestion) and `status` (DBIRTH sets ONLINE; DDEATH and the liveness
 * watchdog set OFFLINE). Archived is a separate axis drawn as its own badge, so a decommissioned
 * device is distinguishable from one that went quiet.
 */
export function deviceLifecycleStatus(device) {
  if (!device) return DEVICE_STATUS.OFFLINE;
  if (device.is_quarantined) return DEVICE_STATUS.QUARANTINED;
  // Anything that is not the string ONLINE is offline. Defaulting the other way would paint a row
  // with a null status -- a device provisioned but never seen -- as running.
  return device.status === DEVICE_STATUS.ONLINE ? DEVICE_STATUS.ONLINE : DEVICE_STATUS.OFFLINE;
}

/** Chip class for the shopfloor map. */
export function deviceStatusChipClass(status) {
  if (status === DEVICE_STATUS.ONLINE) return 'chip-success';
  if (status === DEVICE_STATUS.QUARANTINED) return 'chip-warning';
  return 'chip-offline';
}

/**
 * The chip class for a device on the shopfloor map, alert state included.
 *
 * Red is allowed here and nowhere else in this file: `deviceStatusChipClass` never returns a
 * danger treatment, because this dashboard has no authority over process conditions. An alert is
 * Grafana's verdict, posted to grafana-alert-webhook and landed in `platform_alerts`, so painting
 * it red relays a judgement rather than making one.
 *
 * Precedence: archived (a decommissioned machine reads inert), then alerting (an OFFLINE device
 * with a firing alert is the most urgent thing on the page), then status.
 *
 * @param {object} device  a device row
 * @param {object|null} alert  the worst alert firing on it -- see utils/deviceAlerts.js
 */
export function deviceChipClass(device, alert) {
  if (device?.is_archived) return 'chip-offline';
  if (alert) return 'chip-danger';
  return deviceStatusChipClass(deviceLifecycleStatus(device));
}
/**
 * The status dot's colour for a device, alert state included: the same decision as
 * deviceChipClass() rendered as a colour rather than a class, for the Cells and Gateways pages.
 */
export function deviceDotColor(device, alert) {
  if (device?.is_archived) return 'var(--text-muted)';
  if (alert) return 'var(--danger)';
  return deviceStatusDotColor(deviceLifecycleStatus(device));
}
/** Badge class for the Devices table and the context drawer. */
export function deviceStatusBadgeClass(status) {
  if (status === DEVICE_STATUS.ONLINE) return 'badge-online';
  if (status === DEVICE_STATUS.QUARANTINED) return 'badge-warning';
  return 'badge-neutral';
}

/**
 * The dot colour, as a CSS custom property reference, so the two themes stay in step in inline
 * styles the stylesheet's light-mode block cannot reach.
 */
export function deviceStatusDotColor(status) {
  if (status === DEVICE_STATUS.ONLINE) return 'var(--success)';
  if (status === DEVICE_STATUS.QUARANTINED) return 'var(--warning)';
  return 'var(--text-muted)';
}

/** Hover text explaining what the state means and where it came from. */
export function deviceStatusTitle(status) {
  if (status === DEVICE_STATUS.ONLINE) {
    return 'Online — the device has sent a Sparkplug B DBIRTH and has not since gone quiet';
  }
  if (status === DEVICE_STATUS.QUARANTINED) {
    return 'Quarantined — announced itself under an id nobody registered. Its telemetry is being '
      + 'dropped until an Administrator approves it';
  }
  return 'Offline — a Sparkplug B DDEATH was received, or the liveness watchdog timed the device out';
}

/**
 * The tile roll-up for a cell or lane. `attention` when anything there is waiting to be admitted,
 * `normal` when at least one device is live, `idle` when nothing is. Archived devices are
 * skipped. There is no 'alarm': a tile reports whether the cell is talking to the platform.
 */
export function rollupDeviceStatus(devices = []) {
  let sawQuarantined = false;
  let sawOnline = false;

  for (const device of devices) {
    if (device?.is_archived) continue;
    const status = deviceLifecycleStatus(device);
    if (status === DEVICE_STATUS.QUARANTINED) sawQuarantined = true;
    else if (status === DEVICE_STATUS.ONLINE) sawOnline = true;
  }

  if (sawQuarantined) return 'attention';
  return sawOnline ? 'normal' : 'idle';
}
