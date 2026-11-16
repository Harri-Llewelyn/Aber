/**
 * Where an asset is, as opposed to how its data gets here. `device -> gateway` is the data path;
 * `device -> cell` is a location overlay. A device is in the cell it names, or it follows its
 * gateway and takes the gateway's place (its cell, its area, the whole site, or none), or it is
 * Area-Wide or Site-Wide by assertion and has no cell.
 *
 * The ISA-95 rungs above the cell: a cell files into an area (`cells.area_id`), and a device's
 * effective area is its effective cell's, unless the device is area-wide and names one itself, or
 * follows a gateway that is. The site is one setting, not a column.
 *
 * Mirror of `public.device_locations` (0001, redeclared in 0293); the view is the authority. Field
 * names are the view's own snake_case, so a row from the view and a row derived here are
 * interchangeable.
 *
 * A scope of `gateway` is a device that follows its gateway, the default for a new one. A cell scope
 * names its cell (`devices_cell_scope_names_a_cell`). Unassigned is derived from the resolution
 * running out of arms, never stored.
 */

export const SCOPE_GATEWAY = 'gateway'
export const SCOPE_CELL = 'cell'
export const SCOPE_AREA_WIDE = 'area_wide'
export const SCOPE_SITE_WIDE = 'site_wide'

/** The scopes that assert the asset has no single cell. */
export const WIDE_SCOPES = new Set([SCOPE_AREA_WIDE, SCOPE_SITE_WIDE])

/**
 * Mirrors the *_area_wide_names_its_area CHECKs: exactly the area-wide scope stores an area. A
 * gateway's scope is never `gateway`; an absent scope reads as `cell`.
 */
export function normaliseScope(scope) {
  return scope === SCOPE_GATEWAY || WIDE_SCOPES.has(scope) ? scope : SCOPE_CELL
}

/**
 * Which arm of the resolution answered. `explicit` and `followed_cell` can resolve to the same cell,
 * but only the followed arms move when the gateway does. `inherited` is the view's older name for a
 * cell the gateway supplied: nothing produces it now that a cell scope names its cell. `shadow` and
 * `simulated` are read off the gateway: such an asset is unfileable rather than unfiled, which keeps
 * Unassigned a queue that drains.
 */
export const SOURCE_EXPLICIT = 'explicit'
export const SOURCE_INHERITED = 'inherited'
export const SOURCE_FOLLOWED_CELL = 'followed_cell'
export const SOURCE_FOLLOWED_AREA = 'followed_area'
export const SOURCE_FOLLOWED_SITE = 'followed_site'
export const SOURCE_AREA_WIDE = 'area_wide'
export const SOURCE_SITE_WIDE = 'site_wide'
export const SOURCE_UNASSIGNED = 'unassigned'
export const SOURCE_SIMULATED = 'simulated'
export const SOURCE_SHADOW = 'shadow'

const SOURCE_LABELS = {
  [SOURCE_EXPLICIT]: 'Set on device',
  [SOURCE_INHERITED]: 'From gateway',
  [SOURCE_FOLLOWED_CELL]: 'From gateway',
  [SOURCE_FOLLOWED_AREA]: 'Area-Wide',
  [SOURCE_FOLLOWED_SITE]: 'Site-Wide',
  [SOURCE_AREA_WIDE]: 'Area-Wide',
  [SOURCE_SITE_WIDE]: 'Site-Wide',
  [SOURCE_UNASSIGNED]: 'Unassigned',
  [SOURCE_SIMULATED]: 'Simulated',
  [SOURCE_SHADOW]: 'Replay lane'
}

/** Short badge text for a location source. */
export function locationSourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS[SOURCE_UNASSIGNED]
}

/**
 * The sources that resolve to no cell, as one set. Every consumer that reports devices with no cell
 * excludes these. `unassigned` is not in here: it also resolves to no cell, but it means nobody has
 * decided, which is what such a consumer counts. A device that follows an Area-Wide or a Site-Wide
 * gateway is in here: its gateway decided.
 */
export const NON_CELL_SOURCES = new Set([
  SOURCE_AREA_WIDE, SOURCE_SITE_WIDE, SOURCE_FOLLOWED_AREA, SOURCE_FOLLOWED_SITE, SOURCE_SIMULATED, SOURCE_SHADOW
])

/** Whether the source is Site-Wide, by the device's own assertion or by its gateway's. */
export const isSiteWideSource = (source) => source === SOURCE_SITE_WIDE || source === SOURCE_FOLLOWED_SITE

/** Whether the source is Area-Wide, by the device's own assertion or by its gateway's. */
export const isAreaWideSource = (source) => source === SOURCE_AREA_WIDE || source === SOURCE_FOLLOWED_AREA

/** Whether the source took its place from the device's gateway, so it moves when the gateway does. */
export const isFollowedSource = (source) =>
  source === SOURCE_FOLLOWED_CELL || source === SOURCE_FOLLOWED_AREA || source === SOURCE_FOLLOWED_SITE ||
  source === SOURCE_INHERITED

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
    ? 'Its gateway is the Playback gateway, so its devices are replay lanes rather than in a cell.'
    : 'Its gateway is simulated, so its assets belong to the Simulated lane rather than to a cell.'
}

/**
 * Which `followed_*` arm a device that follows `gateway` is on: the gateway's own scope first, then
 * its cell, else nothing to follow. Mirror of the view's followed arms.
 */
function followedSource(gateway) {
  if (gateway?.location_scope === SCOPE_SITE_WIDE) return SOURCE_FOLLOWED_SITE
  if (gateway?.location_scope === SCOPE_AREA_WIDE) return SOURCE_FOLLOWED_AREA
  if (gateway?.cell_id) return SOURCE_FOLLOWED_CELL
  return SOURCE_UNASSIGNED
}

/**
 * Resolve one device against its serving gateway. `gateway` may be null: a device with no gateway
 * is unassigned, not an error. `cellsById` is optional and only feeds the area: a cell-scoped
 * device's area is its effective cell's, which is a lookup the view does with a join. Mirror of the
 * view's three CASE expressions and its cell_mismatch predicate.
 */
export function resolveDeviceLocation(device, gateway, cellsById) {
  const scope = normaliseScope(device?.location_scope)
  const explicit = device?.cell_id || null
  const inherited = gateway?.cell_id || null
  const ownArea = device?.area_id || null
  const following = scope === SCOPE_GATEWAY

  // Read off the gateway and inherited rather than stored; a device with no gateway yields false
  // for both.
  const shadow = !!gateway?.is_shadow
  const simulated = !!gateway?.is_simulated

  // A wide-scoped asset resolves to no cell, so it must not inherit the gateway's either. Synthetic
  // and replayed assets belong to a lane, and `gateways_synthetic_has_no_cell` guarantees there is
  // no gateway cell to inherit.
  const wide = scope === SCOPE_SITE_WIDE || scope === SCOPE_AREA_WIDE
  const effective = (shadow || simulated || wide) ? null : following ? inherited : (explicit || inherited)

  // Shadow before simulated, mirroring the view: a shadow gateway is necessarily simulated, so
  // testing simulated first would make the shadow lane unreachable.
  let source
  if (shadow) source = SOURCE_SHADOW
  else if (simulated) source = SOURCE_SIMULATED
  else if (scope === SCOPE_SITE_WIDE) source = SOURCE_SITE_WIDE
  else if (scope === SCOPE_AREA_WIDE) source = SOURCE_AREA_WIDE
  else if (following) source = followedSource(gateway)
  else if (explicit) source = SOURCE_EXPLICIT
  else if (inherited) source = SOURCE_INHERITED
  else source = SOURCE_UNASSIGNED

  // The area: the asset's own for area-wide, the gateway's for a device that follows an Area-Wide
  // one, the effective cell's otherwise, none for the lanes and a Site-Wide gateway's followers.
  let effectiveArea = null
  if (source === SOURCE_AREA_WIDE) effectiveArea = ownArea
  else if (source === SOURCE_FOLLOWED_AREA) effectiveArea = gateway?.area_id || null
  else if (effective) effectiveArea = cellOf(cellsById, effective)?.area_id || null

  return {
    location_scope: scope,
    explicit_cell_id: explicit,
    gateway_cell_id: inherited,
    effective_cell_id: effective,
    location_source: source,
    // Filed somewhere its own gateway does not serve. Legitimate on a shared or host-run connector,
    // and also what a mis-click looks like, so it is reported rather than prevented.
    cell_mismatch: scope === SCOPE_CELL && !!explicit && !!inherited && explicit !== inherited,
    explicit_area_id: ownArea,
    effective_area_id: effectiveArea
  }
}

/** A cell row by id from a Map or an array, keyed by `cell_id` or `id`; null when absent. */
function cellOf(cellsById, cellId) {
  if (!cellsById || !cellId) return null
  if (cellsById instanceof Map) return cellsById.get(cellId) || null
  return (cellsById || []).find(c => (c.cell_id ?? c.id) === cellId) || null
}

/**
 * The location of a device, preferring a row already merged from `device_locations` over local
 * derivation. `location_source` is tested because the resolved cell is legitimately null for
 * wide-scoped and unassigned devices.
 */
export function deviceLocationOf(device, gateway, cellsById) {
  if (device?.location_source) {
    return {
      location_scope: normaliseScope(device.location_scope),
      explicit_cell_id: device.explicit_cell_id ?? device.cell_id ?? null,
      gateway_cell_id: device.gateway_cell_id ?? null,
      effective_cell_id: device.effective_cell_id ?? null,
      location_source: device.location_source,
      cell_mismatch: !!device.cell_mismatch,
      explicit_area_id: device.explicit_area_id ?? device.area_id ?? null,
      effective_area_id: device.effective_area_id ?? null
    }
  }
  return resolveDeviceLocation(device, gateway, cellsById)
}

export function isUnassigned(device, gateway) {
  return deviceLocationOf(device, gateway).location_source === SOURCE_UNASSIGNED
}

/**
 * Whether an operator still has to say where this device is: true exactly when the resolution ran
 * out of arms. Site-Wide and Area-Wide are deliberate answers; Simulated and Shadow are unfileable.
 */
export function needsCellAssignment(device, gateway) {
  return isUnassigned(device, gateway)
}

export const UNASSIGNED_NO_GATEWAY = 'no_gateway'
export const UNASSIGNED_GATEWAY_HAS_NO_CELL = 'gateway_has_no_cell'

/**
 * Why a device is unassigned, or null. A device follows its gateway, so the two cases are the two
 * things it can lack: a gateway, or a location on the gateway it has. Any gateway can be located on
 * the Gateways page, a host-run one and a Site-Wide one included.
 */
export function unassignedReason(device, gateway) {
  if (!isUnassigned(device, gateway)) return null
  if (!gateway) return UNASSIGNED_NO_GATEWAY
  return UNASSIGNED_GATEWAY_HAS_NO_CELL
}

const UNASSIGNED_HINTS = {
  [UNASSIGNED_NO_GATEWAY]: 'It has no gateway to follow — assign one, or choose a cell, Area-Wide or Site-Wide for this device.',
  [UNASSIGNED_GATEWAY_HAS_NO_CELL]: 'Its gateway has no location — set one on the Gateways page, or choose one for this device.'
}

/**
 * Where a device that follows `gateway` is now, as the forms say it under Follow Gateway: "Area-Wide
 * in Assembly, from AssemblyFlow", or "Unassigned: AssemblyFlow has no location". `cells` and `areas`
 * are the lists the page holds, as the API gives them (`cell_id`, `cell_name`, `area_id`,
 * `area_name`); a name they lack reads as the thing itself, so the line never names a blank.
 */
export function followedPlaceLine(gateway, { cells = [], areas = [] } = {}) {
  if (!gateway) return 'Unassigned: it has no gateway'
  const from = gateway.gateway_name || gateway.name || 'its gateway'
  const areaName = (id) => areas.find(a => (a.area_id ?? a.id) === id)?.area_name || 'an area'
  const place = followedSource(gateway)
  if (place === SOURCE_FOLLOWED_SITE) return `Site-Wide, from ${from}`
  if (place === SOURCE_FOLLOWED_AREA) return `Area-Wide in ${areaName(gateway.area_id)}, from ${from}`
  if (place === SOURCE_FOLLOWED_CELL) {
    const cell = cells.find(c => (c.cell_id ?? c.id) === gateway.cell_id)
    const area = cell?.area_id ? ` in ${areaName(cell.area_id)}` : ''
    return `Cell ${cell?.cell_name || 'its cell'}${area}, from ${from}`
  }
  return `Unassigned: ${from} has no location`
}

/** What fixes a device whose Follow Gateway line says Unassigned. */
export function followedPlaceFix(gateway) {
  return gateway
    ? 'Set a location on the gateway, or choose one for this device.'
    : 'Assign a gateway that has a location, or choose one for this device.'
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
 * Bucket cells by area: a Map of area id to cells, with cells filed in no area under `null`. The
 * null bucket is the Areas page's queue, so it is kept rather than dropped.
 */
export function groupCellsByArea(cells) {
  const byArea = new Map()
  for (const cell of cells || []) {
    const areaId = cell?.area_id || null
    if (!byArea.has(areaId)) byArea.set(areaId, [])
    byArea.get(areaId).push(cell)
  }
  return byArea
}
