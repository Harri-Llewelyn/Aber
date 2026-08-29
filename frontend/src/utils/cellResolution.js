/**
 * Where an asset IS, as opposed to how its data gets here.
 *
 * `device -> gateway` is a data path: it is in the Sparkplug topic and it is what telemetry is
 * keyed through. `device -> cell` is a location overlay that appears in no topic and no payload.
 * A device's effective cell is its own `cell_id` when it has one, otherwise its gateway's,
 * otherwise nothing -- and a site-wide asset has none by assertion.
 *
 * KEEP IN STEP WITH public.device_locations (supabase/migrations/0001_baseline_schema.sql).
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
 *
 * `shadow` and `simulated` are read off the GATEWAY rather than the device (migration 0059). They
 * are not places, and that is the point: an asset whose telemetry is generated or replayed is not
 * unfiled, it is unfileable, and every hint unassignedHint() can offer is advice that cannot be
 * taken for one. Keeping them out of Unassigned is what keeps Unassigned a queue that drains.
 */
export const SOURCE_EXPLICIT = 'explicit'
export const SOURCE_INHERITED = 'inherited'
export const SOURCE_SITE_WIDE = 'site_wide'
export const SOURCE_UNASSIGNED = 'unassigned'
export const SOURCE_SIMULATED = 'simulated'
export const SOURCE_SHADOW = 'shadow'

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
 * The sources that resolve to NO cell, as one set rather than four inequalities.
 *
 * Every consumer that reports "devices with no cell" has to exclude these, and every one of them
 * had its own hand-written list -- which is how Site-Wide ended up correctly excluded from the
 * Cells banner and the Devices filter while a third caller quietly counted it. Adding a lane
 * should not require finding those call sites again.
 *
 * `unassigned` is NOT in here: it also resolves to no cell, but it is the one that MEANS "nobody
 * has decided", which is exactly what such a consumer is trying to count.
 */
export const NON_CELL_SOURCES = new Set([SOURCE_SITE_WIDE, SOURCE_SIMULATED, SOURCE_SHADOW])

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

  // Read off the gateway, and inherited rather than stored -- devices carry no copy, which is what
  // makes "no simulated device on a real gateway" true by construction instead of by trigger.
  // A device with no gateway yields false for both and falls through to the arms below.
  const shadow = !!gateway?.is_shadow
  const simulated = !!gateway?.is_simulated

  // A site-wide asset resolves to no cell at all. Its own cell_id is already NULL -- the
  // devices_site_wide_has_no_cell CHECK guarantees it -- so this is about not inheriting the
  // gateway's either. Synthetic and replayed assets resolve to no cell for a different reason:
  // they belong to a lane rather than to the plant, and gateways_synthetic_has_no_cell (0059)
  // guarantees there is no gateway cell for them to inherit in the first place.
  const effective = (shadow || simulated || scope === SCOPE_SITE_WIDE) ? null : (explicit || inherited)

  // SHADOW BEFORE SIMULATED, mirroring the view. A shadow gateway is necessarily simulated -- 0056
  // refuses a playback target that is not, and a CHECK states it -- so testing simulated first
  // would make the shadow lane unreachable without any arm being individually wrong.
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

/** Telemetry generated rather than observed -- a simulator, or a playback target. */
export function isSimulatedAsset(device, gateway) {
  const source = deviceLocationOf(device, gateway).location_source
  return source === SOURCE_SIMULATED || source === SOURCE_SHADOW
}

/**
 * A replay lane: real readings, recorded from a real machine, republished under a stand-in.
 *
 * Narrower than isSimulatedAsset() on purpose. "Invented" and "recorded from your own plant" are
 * both synthetic in provenance and opposite in truth, and a caller asking whether a number ever
 * happened wants this one.
 */
export function isShadowAsset(device, gateway) {
  return deviceLocationOf(device, gateway).location_source === SOURCE_SHADOW
}

/**
 * Whether an operator still has to say where this device is.
 *
 * True exactly when the resolution ran out of arms. Site-Wide is NOT included: it is the
 * deliberate answer to this question, not an unanswered one -- which is the distinction that
 * keeps the Unassigned lane a queue that can actually drain. Simulated and Shadow are excluded
 * for a stronger reason (0059): they are not unfiled but unfileable, and every hint
 * unassignedHint() can offer is advice that cannot be taken for one.
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
 * The three cases call for different fixes, which is why they are not collapsed. A REMOTE gateway
 * with no cell is fixed once on the Gateways page and every device behind it follows; a site-wide
 * or HOST-RUN gateway can never supply a cell by inheritance, so each of its devices has to be
 * filed individually. Telling an operator to "assign the gateway a cell" when the gateway is a
 * host-run proxy is advice that cannot be taken -- which is why this asks where the connector runs
 * rather than what `is_virtual` used to mean (roadmap 15).
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
 * Bucket devices by the cell they resolve to, returning a Map of cell id -> devices.
 *
 * This is what "the devices in this cell" means now, and it is deliberately a client-side
 * grouping rather than a field on the cells payload. A cell's devices cannot be embedded --
 * `cells?select=*,gateways(devices(...))` returns them by inheritance only, so an explicit
 * override lands on the wrong card -- and having the cells endpoint fetch every device to
 * bucket them server-side made every consumer read the device list twice, since all of them
 * already load it for their own purposes. Overview polls at 3s, so that was the expensive one.
 *
 * Devices resolving to no cell -- shadow, simulated, site-wide and unassigned -- are omitted rather
 * than collected under a null key. They belong to no card, and the four are different states that
 * must not be merged into one "everything else" bucket.
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
 * Overlay a set of staged, uncommitted relocations onto a device list.
 *
 * Rearrange mode stages drops and applies them as one transaction (migration 0033), so between
 * the drop and the Apply there is a view of the shopfloor that exists only in the browser. This
 * builds it.
 *
 * IT RE-RESOLVES RATHER THAN JUST OVERWRITING THE TWO COLUMNS, and that is the whole subtlety.
 * api.js merges `device_locations` onto every device row, and deviceLocationOf() PREFERS that
 * server-supplied `location_source` over local derivation -- correctly, because the server is the
 * authority. A staged device still carries the server's answer about where it used to be, so
 * setting `cell_id` alone leaves every consumer (groupDevicesByCell, the lane filters) reading
 * the stale resolution and the chip does not move. The view fields have to be recomputed from the
 * staged values, which is exactly what resolveDeviceLocation() does.
 *
 * THIS IS ALSO WHAT MAKES THE UNASSIGNED LANE HONEST BEFORE THE COMMIT RATHER THAN AFTER IT.
 * Dropping onto Unassigned stages `cell_id: null` with cell scope, and a device whose gateway
 * serves a cell then re-inherits that cell and visibly springs back the moment it is dropped --
 * not once a write has completed. Unassigned is the resolution running out of arms, so it is not
 * settable, and a staged view that showed the device sitting in the lane would be telling the one
 * lie this location model exists to avoid.
 *
 * `staged: true` rides along so the caller can render pending differently from durable. With
 * immediate writes the tile did not move until the reload landed; now it moves at once, and
 * without that distinction an operator cannot tell what is already saved.
 *
 * @param devices  rows as the page holds them, carrying merged `device_locations` fields
 * @param gateways rows keyed by `gateway_id` or `id`
 * @param staged   Map of device id -> { cell_id, location_scope }
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
