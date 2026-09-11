/**
 * Where an asset is, as opposed to how its data gets here. `device -> gateway` is the data path;
 * `device -> cell` is a location overlay. A device's effective cell is its own `cell_id`, else its
 * gateway's, else nothing; a site-wide asset has none by assertion.
 *
 * Mirror of `public.device_locations` in supabase/migrations/0001_baseline_schema.sql; the view is
 * the authority. Field names are the view's own snake_case, so a row from the view and a row
 * derived here are interchangeable.
 *
 * NULL cell_id means inherit. Unassigned is derived from the resolution running out of arms, never
 * stored.
 */

export const SCOPE_CELL = 'cell'
export const SCOPE_SITE_WIDE = 'site_wide'

/** Mirrors the devices_location_scope_valid / gateways_location_scope_valid CHECK constraints. */
export const LOCATION_SCOPES = [SCOPE_CELL, SCOPE_SITE_WIDE]

/**
 * Which arm of the resolution answered. `explicit` and `inherited` look identical once resolved,
 * but only one moves when the gateway is reassigned. `shadow` and `simulated` are read off the
 * gateway: such an asset is unfileable rather than unfiled, which keeps Unassigned a queue that
 * drains.
 */
export const SOURCE_EXPLICIT = 'explicit'
export const SOURCE_INHERITED = 'inherited'
export const SOURCE_SITE_WIDE = 'site_wide'
export const SOURCE_UNASSIGNED = 'unassigned'
export const SOURCE_SIMULATED = 'simulated'
const SOURCE_SHADOW = 'shadow'

const SOURCE_LABELS = {
  [SOURCE_EXPLICIT]: 'Set on device',
  [SOURCE_INHERITED]: 'From gateway',
  [SOURCE_SITE_WIDE]: 'Site-Wide',
  [SOURCE_UNASSIGNED]: 'Unassigned',
  [SOURCE_SIMULATED]: 'Simulated',
  [SOURCE_SHADOW]: 'Shadow'
}

/** Short badge text for a location source. */
export function locationSourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS[SOURCE_UNASSIGNED]
}

/**
 * The sources that resolve to no cell, as one set. Every consumer that reports devices with no cell
 * excludes these. `unassigned` is not in here: it also resolves to no cell, but it means nobody has
 * decided, which is what such a consumer counts.
 */
export const NON_CELL_SOURCES = new Set([SOURCE_SITE_WIDE, SOURCE_SIMULATED, SOURCE_SHADOW])

/**
 * Whether a cell can be stored against this gateway. Mirrors `gateways_synthetic_has_no_cell`:
 * `CHECK (((NOT is_simulated) AND (NOT is_shadow)) OR cell_id IS NULL)`. It also answers for a
 * device behind such a gateway, where a stored cell is accepted and then ignored because
 * `device_locations` resolves `simulated` and `shadow` first. Null-safe in the permissive
 * direction: a device with no gateway can still be given a cell.
 */
export function gatewayAcceptsCell(gateway) {
  return !(gateway?.is_simulated || gateway?.is_shadow)
}

/**
 * Why the cell picker is unavailable, as a sentence, or null when it is available. The two kinds of
 * synthetic gateway call for different actions.
 */
export function noCellReason(gateway) {
  if (gatewayAcceptsCell(gateway)) return null
  return gateway?.is_shadow
    ? 'Its gateway republishes recorded captures, so its assets belong to the Shadow lane rather than to a cell.'
    : 'Its gateway is simulated, so its assets belong to the Simulated lane rather than to a cell.'
}

/**
 * Resolve one device against its serving gateway. `gateway` may be null: a device with no gateway
 * is unassigned, not an error. Mirror of the view's two CASE expressions and its cell_mismatch
 * predicate.
 */
export function resolveDeviceLocation(device, gateway) {
  const scope = device?.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : SCOPE_CELL
  const explicit = device?.cell_id || null
  const inherited = gateway?.cell_id || null

  // Read off the gateway and inherited rather than stored; a device with no gateway yields false
  // for both.
  const shadow = !!gateway?.is_shadow
  const simulated = !!gateway?.is_simulated

  // A site-wide asset resolves to no cell, so it must not inherit the gateway's either. Synthetic
  // and replayed assets belong to a lane, and `gateways_synthetic_has_no_cell` guarantees there is
  // no gateway cell to inherit.
  const effective = (shadow || simulated || scope === SCOPE_SITE_WIDE) ? null : (explicit || inherited)

  // Shadow before simulated, mirroring the view: a shadow gateway is necessarily simulated, so
  // testing simulated first would make the shadow lane unreachable.
  let source
  if (shadow) source = SOURCE_SHADOW
  else if (simulated) source = SOURCE_SIMULATED
  else if (scope === SCOPE_SITE_WIDE) source = SOURCE_SITE_WIDE
  else if (explicit) source = SOURCE_EXPLICIT
  else if (inherited) source = SOURCE_INHERITED
  else source = SOURCE_UNASSIGNED

  return {
    location_scope: scope,
    explicit_cell_id: explicit,
    gateway_cell_id: inherited,
    effective_cell_id: effective,
    location_source: source,
    // Filed somewhere its own gateway does not serve. Legitimate on a shared or host-run connector,
    // and also what a mis-click looks like, so it is reported rather than prevented.
    cell_mismatch: scope === SCOPE_CELL && !!explicit && !!inherited && explicit !== inherited
  }
}

/**
 * The location of a device, preferring a row already merged from `device_locations` over local
 * derivation. `location_source` is tested because the resolved cell is legitimately null for
 * site-wide and unassigned devices.
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
 * Whether an operator still has to say where this device is: true exactly when the resolution ran
 * out of arms. Site-Wide is a deliberate answer; Simulated and Shadow are unfileable.
 */
export function needsCellAssignment(device, gateway) {
  return isUnassigned(device, gateway)
}

export const UNASSIGNED_NO_GATEWAY = 'no_gateway'
export const UNASSIGNED_GATEWAY_HAS_NO_CELL = 'gateway_has_no_cell'
export const UNASSIGNED_GATEWAY_SITE_WIDE = 'gateway_site_wide'

/**
 * Why a device is unassigned, or null. The three cases call for different fixes: a remote gateway
 * with no cell is fixed once on the Gateways page; a site-wide or host-run gateway cannot supply a
 * cell by inheritance, so each device is filed individually.
 */
export function unassignedReason(device, gateway) {
  if (!isUnassigned(device, gateway)) return null
  if (!gateway) return UNASSIGNED_NO_GATEWAY
  if (gateway.location_scope === SCOPE_SITE_WIDE || gateway.deployment === 'host') return UNASSIGNED_GATEWAY_SITE_WIDE
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
 * Bucket devices by the cell they resolve to: a Map of cell id to devices. Client-side, because a
 * cell's devices cannot be embedded (an explicit override lands on the wrong card) and every
 * consumer already holds the device list. Devices resolving to no cell are omitted rather than
 * collected under a null key. Rows carrying `location_source` take the server's answer verbatim.
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
 * Overlay staged, uncommitted relocations onto a device list. It re-resolves rather than
 * overwriting the two columns: deviceLocationOf() prefers the server-supplied `location_source`, so
 * a staged device would otherwise keep its stale resolution and never move. This is also what makes
 * the Unassigned lane honest before the commit: a device whose gateway serves a cell re-inherits it
 * at the drop. `staged: true` rides along so pending renders differently from durable.
 *
 * @param devices rows as the page holds them, carrying merged `device_locations` fields
 *
 * @param gateways rows keyed by `gateway_id` or `id`
 *
 * @param staged Map of device id to { cell_id, location_scope }
 */
export function applyStagedMoves(devices, gateways, staged) {
  if (!staged || staged.size === 0) return devices || []
  const byId = new Map((gateways || []).map(g => [g.gateway_id ?? g.id, g]))
  return (devices || []).map(device => {
    const move = staged.get(device?.asset_id ?? device?.id)
    if (!move) return device
    const moved = {
      ...device,
      cell_id: move.cell_id || null,
      location_scope: move.location_scope === SCOPE_SITE_WIDE ? SCOPE_SITE_WIDE : SCOPE_CELL
    }
    const gateway = byId.get(device?.active_gateway_id ?? device?.gateway_id ?? null) || null
    return { ...moved, ...resolveDeviceLocation(moved, gateway), staged: true }
  })
}

/**
 * Resolve a whole list at once: a Map keyed by device id. For paths that hold devices and gateways
 * but no view read.
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
