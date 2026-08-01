/**
 * Where an asset IS, as opposed to how its data gets here.
 *
 * `device -> gateway` is a data path: it is in the Sparkplug topic and it is what telemetry is
 * keyed through. `device -> cell` is a location overlay that appears in no topic and no payload.
 * A device's effective cell is its own `cell_id` when it has one, otherwise its gateway's,
 * otherwise nothing -- and a site-wide asset has none by assertion.
 *
 * KEEP IN STEP WITH public.device_locations (supabase/migrations/20260101000036_device_location.sql).
 * The view is the authority; this is the local mirror, the same obligation utils/sparkplugId.js,
 * utils/metricGroup.js and utils/gatewayStatus.js already carry against their SQL. The returned
 * field names are deliberately the view's own snake_case rather than a second camelCase
 * vocabulary: a row read from the view and a row derived here are then interchangeable, which is
 * what lets deviceLocationOf() prefer the server's answer without any translation layer, and it
 * makes a drift between the two visible as a field that stops matching rather than as a value
 * that quietly disagrees.
 *
 * NULL cell_id MEANS INHERIT. It is not a stored "unassigned" value -- the column has no default,
 * precisely so that inheritance is the absence of a decision rather than a precedence rule
 * competing with one. Unassigned is derived from the resolution running out of arms.
 */

export const SCOPE_CELL = 'cell'
export const SCOPE_SITE_WIDE = 'site_wide'

/** Mirrors the devices_location_scope_valid / gateways_location_scope_valid CHECK constraints. */
export const LOCATION_SCOPES = [SCOPE_CELL, SCOPE_SITE_WIDE]

/**
 * Which arm of the resolution answered. `explicit` and `inherited` look identical once resolved,
 * but only one of them moves when the gateway is reassigned -- which is the whole reason the view
 * reports the source rather than just the cell.
 */
export const SOURCE_EXPLICIT = 'explicit'
export const SOURCE_INHERITED = 'inherited'
export const SOURCE_SITE_WIDE = 'site_wide'
export const SOURCE_UNASSIGNED = 'unassigned'

const SOURCE_LABELS = {
  [SOURCE_EXPLICIT]: 'Set on device',
  [SOURCE_INHERITED]: 'From gateway',
  [SOURCE_SITE_WIDE]: 'Site-Wide',
  [SOURCE_UNASSIGNED]: 'Unassigned'
}

/** Short badge text for a location source. */
export function locationSourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS[SOURCE_UNASSIGNED]
}

/**
 * Resolve one device against its serving gateway.
 *
 * `gateway` may be null -- a device with no gateway is unassigned rather than an error, which is
 * the state every auto-discovered device starts in.
 *
 * Mirror of the view's two CASE expressions and its cell_mismatch predicate.
 */
export function resolveDeviceLocation(device, gateway) {
  const scope = device?.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : SCOPE_CELL
  const explicit = device?.cell_id || null
  const inherited = gateway?.cell_id || null

  // A site-wide asset resolves to no cell at all. Its own cell_id is already NULL -- the
  // devices_site_wide_has_no_cell CHECK guarantees it -- so this is about not inheriting the
  // gateway's either.
  const effective = scope === SCOPE_SITE_WIDE ? null : (explicit || inherited)

  let source
  if (scope === SCOPE_SITE_WIDE) source = SOURCE_SITE_WIDE
  else if (explicit) source = SOURCE_EXPLICIT
  else if (inherited) source = SOURCE_INHERITED
  else source = SOURCE_UNASSIGNED

  return {
    location_scope: scope,
    explicit_cell_id: explicit,
    gateway_cell_id: inherited,
    effective_cell_id: effective,
    location_source: source,
    // Filed somewhere its own gateway does not serve. Legitimate on a shared or host-run
    // connector, and also exactly what a mis-click looks like -- so it is reported, not
    // prevented, and the explicit value still wins.
    cell_mismatch: scope === SCOPE_CELL && !!explicit && !!inherited && explicit !== inherited
  }
}

/**
 * The location of a device, preferring a row already merged from `device_locations` over local
 * derivation -- same arrangement as metricGroupOf() and the sparkplug_id helpers.
 *
 * `location_source` is the field tested rather than `effective_cell_id`, because the resolved
 * cell is legitimately null for both site-wide and unassigned devices; the source is the only
 * field that is always populated when the view has been read.
 */
export function deviceLocationOf(device, gateway) {
  if (device?.location_source) {
    return {
      location_scope: device.location_scope || SCOPE_CELL,
      explicit_cell_id: device.explicit_cell_id ?? device.cell_id ?? null,
      gateway_cell_id: device.gateway_cell_id ?? null,
      effective_cell_id: device.effective_cell_id ?? null,
      location_source: device.location_source,
      cell_mismatch: !!device.cell_mismatch
    }
  }
  return resolveDeviceLocation(device, gateway)
}

/** The cell a device should be displayed under, or null for site-wide and unassigned. */
export function effectiveCellId(device, gateway) {
  return deviceLocationOf(device, gateway).effective_cell_id
}

export function isSiteWide(device, gateway) {
  return deviceLocationOf(device, gateway).location_source === SOURCE_SITE_WIDE
}

export function isUnassigned(device, gateway) {
  return deviceLocationOf(device, gateway).location_source === SOURCE_UNASSIGNED
}

/**
 * Whether an operator still has to say where this device is.
 *
 * True exactly when the resolution ran out of arms. Site-Wide is NOT included: it is the
 * deliberate answer to this question, not an unanswered one -- which is the distinction that
 * keeps the Unassigned lane a queue that can actually drain.
 */
export function needsCellAssignment(device, gateway) {
  return isUnassigned(device, gateway)
}

export const UNASSIGNED_NO_GATEWAY = 'no_gateway'
export const UNASSIGNED_GATEWAY_HAS_NO_CELL = 'gateway_has_no_cell'
export const UNASSIGNED_GATEWAY_SITE_WIDE = 'gateway_site_wide'

/**
 * Why a device is unassigned, or null if it is not.
 *
 * The three cases call for different fixes, which is why they are not collapsed. A physical
 * gateway with no cell is fixed once on the Gateways page and every device behind it follows;
 * a site-wide or virtual gateway can never supply a cell by inheritance, so each of its devices
 * has to be filed individually. Telling an operator to "assign the gateway a cell" when the
 * gateway is a host-run proxy is advice that cannot be taken.
 */
export function unassignedReason(device, gateway) {
  if (!isUnassigned(device, gateway)) return null
  if (!gateway) return UNASSIGNED_NO_GATEWAY
  if (gateway.location_scope === SCOPE_SITE_WIDE || gateway.is_virtual) return UNASSIGNED_GATEWAY_SITE_WIDE
  return UNASSIGNED_GATEWAY_HAS_NO_CELL
}

const UNASSIGNED_HINTS = {
  [UNASSIGNED_NO_GATEWAY]: 'No gateway assigned — pick a cell for this device, or assign it a gateway.',
  [UNASSIGNED_GATEWAY_HAS_NO_CELL]: 'Its gateway is not assigned to a cell — set one on the Gateways page, or pick a cell for this device.',
  [UNASSIGNED_GATEWAY_SITE_WIDE]: 'Its gateway is a host-level proxy with no cell of its own — pick a cell for this device, or mark it Site-Wide.'
}

/** Actionable one-liner for an unassigned device, or null. */
export function unassignedHint(device, gateway) {
  const reason = unassignedReason(device, gateway)
  return reason ? UNASSIGNED_HINTS[reason] : null
}

/**
 * Bucket devices by the cell they resolve to, returning a Map of cell id -> devices.
 *
 * This is what "the devices in this cell" means now, and it is deliberately a client-side
 * grouping rather than a field on the cells payload. A cell's devices cannot be embedded --
 * `cells?select=*,gateways(devices(...))` returns them by inheritance only, so an explicit
 * override lands on the wrong card -- and having the cells endpoint fetch every device to
 * bucket them server-side made every consumer read the device list twice, since all of them
 * already load it for their own purposes. Overview polls at 3s, so that was the expensive one.
 *
 * Devices resolving to no cell -- site-wide and unassigned -- are omitted rather than collected
 * under a null key. They belong to no card, and the two are different states that must not be
 * merged into one "everything else" bucket.
 *
 * Rows are expected to carry `location_source` from `device_locations` (api.js merges it), in
 * which case deviceLocationOf() takes the server's answer verbatim.
 */
export function groupDevicesByCell(devices) {
  const byCell = new Map()
  for (const device of devices || []) {
    const cellId = deviceLocationOf(device).effective_cell_id
    if (!cellId) continue
    if (!byCell.has(cellId)) byCell.set(cellId, [])
    byCell.get(cellId).push(device)
  }
  return byCell
}

/**
 * Resolve a whole list at once, returning a Map keyed by device id.
 *
 * Callers that already loaded `device_locations` should merge that instead; this is for the
 * paths that hold devices and gateways but no view read -- optimistic updates, and any test or
 * component rendering fixtures.
 */
export function resolveDeviceLocations(devices, gateways) {
  const byId = new Map((gateways || []).map(g => [g.gateway_id ?? g.id, g]))
  const out = new Map()
  for (const device of devices || []) {
    const gatewayId = device?.active_gateway_id ?? device?.gateway_id ?? null
    out.set(device?.asset_id ?? device?.id, resolveDeviceLocation(device, byId.get(gatewayId) || null))
  }
  return out
}
