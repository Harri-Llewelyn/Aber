/**
 * A device's lifecycle status, and how it is drawn.
 *
 * ONE DEFINITION FOR EVERY RENDER SITE. The Overview map, the Devices table and the context
 * drawer each derived this independently, and they disagreed: the map ran a client-side rule
 * engine over the latest telemetry while the table read `status` off the row, so the same machine
 * could be a red chip on one tab and a green badge on the other.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT WAS REMOVED, AND WHY IT WAS WRONG
 *
 * The map used to evaluate `Systems/TEMPERATURE > 80.0`, `Controller/EXECUTION === 'INTERRUPTED'`
 * and `Controller/EMERGENCY_STOP === 'TRIGGERED'` and paint an "Alarm" state from them. Four
 * things were wrong with it, and only the first is obvious:
 *
 *   1. THE THRESHOLD WAS A LITERAL. `metric_catalog` carries `max_temp_threshold` per device and
 *      the devices publish it, and nothing read it -- so a machine declaring a 65 degC limit sat
 *      green at 70, and one declaring 120 went red at 85. A number that looks like configuration
 *      and behaves like a constant is worse than no number.
 *   2. IT WAS CLIENT-SIDE AND EPHEMERAL. No persistence, no history, no acknowledgement, no
 *      notification. Closing the tab meant the condition had never happened.
 *   3. IT WAS METRIC-NAME EXACT. Only a device publishing that literal MTConnect name was ever
 *      evaluated; the robot, the tool changer, the BMS zone and the KPI aggregator could not
 *      raise it at all, silently.
 *   4. IT CONFLATED TWO AXES. Process condition ("this machine is too hot") and connectivity
 *      lifecycle ("this machine is talking to us") are different questions with different
 *      audiences, and one dot cannot answer both.
 *
 * Threshold and condition alerting belongs in Grafana, which has evaluation intervals, state
 * history, silences and notification policies -- none of which a React render pass has. What is
 * left here is the question this dashboard is actually authoritative for: what the platform knows
 * about the device, from the database.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * The three lifecycle states, in the order of precedence they are resolved in.
 *
 * QUARANTINED outranks OFFLINE because it is the more actionable of the two and the one an
 * operator can do something about: a quarantined device is waiting to be admitted, and its status
 * column would otherwise read OFFLINE -- which says "this went away" about something that has
 * never been let in.
 */
export const DEVICE_STATUS = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  QUARANTINED: 'QUARANTINED',
};

/**
 * Resolve a device row to one of DEVICE_STATUS.
 *
 * Reads ONLY database-backed fields. `is_quarantined` is set by ingestion when a device announces
 * itself unrecognised; `status` is written from the Sparkplug lifecycle -- DBIRTH sets ONLINE,
 * DDEATH and the liveness watchdog set OFFLINE. Telemetry values are deliberately not consulted.
 *
 * ARCHIVED IS NOT ONE OF THESE, and that is deliberate rather than an omission. Archiving is a
 * separate axis -- a decommissioned machine still has a last known lifecycle state -- and the
 * render sites draw it as its own badge alongside this one. Folding it in would make a
 * decommissioned device indistinguishable from one that merely went quiet.
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
 * The chip class for a device on the shopfloor map, alert state included (issue #34).
 *
 * WHY RED IS ALLOWED HERE AND NOWHERE ELSE IN THIS FILE. `deviceStatusChipClass` above will never
 * return a danger treatment, and deviceStatus.test.js asserts that for every status: red on this
 * dashboard would assert a PROCESS CONDITION it has no authority over, which is the whole reason
 * threshold alerting was moved to Grafana. That rule is unchanged and this does not weaken it.
 *
 * An alert is the one case that is not a derivation. Grafana evaluated its own rules against the
 * historian, posted the verdict to grafana-alert-webhook, and it landed in `device_alerts`. Painting
 * that red RELAYS a judgement rather than making one -- so this takes an alert, never a threshold,
 * and there is no code path here that can turn a telemetry value into a colour.
 *
 * PRECEDENCE, AND EACH STEP EARNS ITS PLACE:
 *   1. archived  -- a decommissioned machine reads inert whatever else is true of it. An alert
 *                   still firing against something taken out of service is noise about a decision
 *                   already made, and OverviewTab already dimmed archived rows for this reason.
 *   2. alerting  -- above status, because an OFFLINE device with a firing alert is the most urgent
 *                   thing on the page, not the least. Grey would bury it.
 *   3. status    -- the existing online/quarantined/offline treatment, unchanged.
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
 * The status dot's colour for a device, alert state included (issue #34).
 *
 * The Cells and Gateways pages list their devices as a dot and a name rather than as chips, so
 * this is the same decision as deviceChipClass() rendered in the other idiom -- same precedence,
 * same reason red is permitted, stated once above. Two helpers rather than one because the two
 * surfaces genuinely take different values (a class, a colour), and collapsing them would mean a
 * caller mapping one to the other at every site.
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
 * The dot colour, as a CSS custom property reference.
 *
 * Returned as a token rather than a literal so the two themes stay in step -- these are read into
 * inline styles, which the stylesheet's light-mode block cannot reach.
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
 * The tile roll-up for a cell or lane: the state of the devices resolving to it.
 *
 * `attention` when anything there is waiting to be admitted, `normal` when at least one device is
 * live, `idle` when nothing is. Archived devices are skipped -- a decommissioned machine is not a
 * fault and must not colour its whole cell.
 *
 * THERE IS NO LONGER A WORST-STATE-WINS 'alarm'. A tile cannot report a process condition it has
 * no authority over; it reports whether the cell is talking to the platform.
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
