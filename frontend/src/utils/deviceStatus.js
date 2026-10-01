/**
 * A device's lifecycle status, and how it is drawn: one definition for every render site (the
 * Site Map, the Devices table and the context drawer). It reads only what the platform knows about
 * the device, from the database; threshold and condition alerting belongs in Grafana.
 */
import { isNeverSeen, isProvisioningOverdue } from './deviceProvisioning';

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
 * `is_quarantined` (set by ingestion) and `status` (DBIRTH sets ONLINE, as does DDATA after a
 * watchdog timeout; DDEATH and the liveness watchdog set OFFLINE). Archived is a separate axis
 * drawn as its own badge, so a decommissioned device is distinguishable from one that went quiet.
 */
export function deviceLifecycleStatus(device) {
  if (!device) return DEVICE_STATUS.OFFLINE;
  if (device.is_quarantined) return DEVICE_STATUS.QUARANTINED;
  // Anything that is not the string ONLINE is offline. Defaulting the other way would paint a row
  // with a null status -- a device provisioned but never seen -- as running.
  return device.status === DEVICE_STATUS.ONLINE ? DEVICE_STATUS.ONLINE : DEVICE_STATUS.OFFLINE;
}

/** Chip class for the Site Map. */
export function deviceStatusChipClass(status) {
  if (status === DEVICE_STATUS.ONLINE) return 'chip-success';
  if (status === DEVICE_STATUS.QUARANTINED) return 'chip-warning';
  return 'chip-offline';
}

/**
 * The chip class for a device on the Site Map, alert state included.
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

/**
 * The badge one device wears: the lifecycle state, plus the distinction the three states cannot
 * draw between a device that went quiet and one never heard from. Read `first_dbirth_at`, which is
 * write-once, so the answer does not flicker with the last message. `tone` is a <Badge> tone;
 * `badgeClass` is the same choice as a CSS class.
 *
 * Not a fourth DEVICE_STATUS: the rollup, the map chip and the cell tile ask whether the cell is
 * talking to the platform, and for that question the two are one answer. `status` here is that
 * answer, and `overdue` (deviceProvisioning.js) changes only how loudly the badge is drawn.
 */
export function deviceStatusBadge(device) {
  if (isNeverSeen(device)) {
    const overdue = isProvisioningOverdue(device);
    return {
      label: 'AWAITING FIRST BIRTH',
      status: DEVICE_STATUS.OFFLINE,
      awaitingBirth: true,
      overdue,
      badgeClass: overdue ? 'badge-warning' : 'badge-neutral',
      tone: overdue ? 'warning' : 'neutral',
      title: overdue
        ? 'Awaiting first birth — provisioned more than 24h ago and has never sent a Sparkplug B '
          + 'DBIRTH. Check that the device is powered, reachable and publishing under the Sparkplug '
          + 'ID this platform issued it'
        : 'Awaiting first birth — registered here and has never sent a Sparkplug B DBIRTH. Nothing '
          + 'is wrong yet: the device has not connected for the first time',
    };
  }

  const status = deviceLifecycleStatus(device);
  return {
    label: status,
    status,
    awaitingBirth: false,
    overdue: false,
    badgeClass: deviceStatusBadgeClass(status),
    tone: status === DEVICE_STATUS.ONLINE ? 'success' : status === DEVICE_STATUS.QUARANTINED ? 'warning' : 'neutral',
    title: deviceStatusTitle(status),
  };
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
