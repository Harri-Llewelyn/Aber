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
