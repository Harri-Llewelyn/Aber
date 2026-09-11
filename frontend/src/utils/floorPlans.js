/**
 * Floors and floor plans: the rows of `area_floors` and the places cells take on them.
 *
 * A place is two fractions of the plan's viewBox (`plan_x` across, `plan_y` down, 0..1), so it
 * survives the plan being redrawn at any size. Distances are measured in units of the plan's
 * shorter side, so one spacing setting means the same on a wide plan and a tall one. Mirror of
 * `public.plan_distance()` and `place_cell_on_its_floor()` in
 * supabase/migrations/0098_a_floor_is_a_row_and_a_cell_has_a_place_on_it.sql; the trigger is
 * the authority and the checks here only refuse earlier.
 */

/** The outline drawn for a floor with no plan: 4:3, as the default box in the database. */
export const DEFAULT_PLAN_ASPECT = 4 / 3

/** The seeded default of `site_map.min_pin_spacing`, used until the setting has loaded. */
export const DEFAULT_MIN_PIN_SPACING = 0.08
export const MIN_PIN_SPACING_SETTING = 'site_map.min_pin_spacing'

/** The bucket's limit, mirrored so an oversized file is refused before the upload. */
export const FLOOR_PLAN_MAX_BYTES = 5 * 1024 * 1024

/** Top-down, as a building reads: highest level first, ground, then basements. */
export function sortFloors(floors) {
  return [...(floors || [])].sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
}

/**
 * The floor a view opens on: level 0, else the lowest level above ground, else the highest
 * basement. Null with no floors.
 */
export function groundFloor(floors) {
  const list = floors || []
  if (list.length === 0) return null
  const exact = list.find(f => f.level === 0)
  if (exact) return exact
  const above = list.filter(f => f.level > 0).sort((a, b) => a.level - b.level)
  if (above.length) return above[0]
  return list.slice().sort((a, b) => b.level - a.level)[0]
}

/** A Map of area id to that area's floors, top-down, from rows carrying `area_id`. */
export function floorsByArea(floors) {
  const byArea = new Map()
  for (const floor of floors || []) {
    const areaId = floor?.area_id || null
    if (!areaId) continue
    if (!byArea.has(areaId)) byArea.set(areaId, [])
    byArea.get(areaId).push(floor)
  }
  for (const [areaId, list] of byArea) byArea.set(areaId, sortFloors(list))
  return byArea
}

/** Width over height of a floor's plan, falling back to the default outline. */
export function floorAspect(floor) {
  const aspect = Number(floor?.plan_aspect)
  return Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_PLAN_ASPECT
}

/** True when both fractions are numbers: the cell has a place on its floor's plan. */
export function isPlaced(cell) {
  return Number.isFinite(Number(cell?.plan_x)) && Number.isFinite(Number(cell?.plan_y))
    && cell?.plan_x !== null && cell?.plan_y !== null && cell?.plan_x !== '' && cell?.plan_y !== ''
}

/** Distance between two places in units of the plan's shorter side. Mirrors plan_distance(). */
export function planDistance(a, b, aspect = DEFAULT_PLAN_ASPECT) {
  const dx = Number(a.x ?? a.plan_x) - Number(b.x ?? b.plan_x)
  const dy = Number(a.y ?? a.plan_y) - Number(b.y ?? b.plan_y)
  const k = aspect > 0 ? aspect : DEFAULT_PLAN_ASPECT
  return k >= 1 ? Math.hypot(dx * k, dy) : Math.hypot(dx, dy / k)
}

/**
 * The nearest placed cell closer than `minSpacing` to `place`, or null. `others` are the cells
 * already on the floor; the one being placed is excluded by id, and archived cells do not hold
 * their ground.
 */
export function nearestConflict(place, others, aspect, minSpacing = DEFAULT_MIN_PIN_SPACING, selfId = null) {
  let best = null
  let bestDistance = Infinity
  for (const other of others || []) {
    if (!isPlaced(other) || other.is_archived) continue
    if (selfId && (other.cell_id ?? other.id) === selfId) continue
    const d = planDistance(place, other, aspect)
    if (d < minSpacing && d < bestDistance) { best = other; bestDistance = d }
  }
  return best
}

/** Fractions 0..1 of an element's box for a pointer event, clamped. */
export function planFractionsFromEvent(event, element) {
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const clamp = (v) => Math.min(1, Math.max(0, v))
  return {
    x: Number(clamp((event.clientX - rect.left) / rect.width).toFixed(4)),
    y: Number(clamp((event.clientY - rect.top) / rect.height).toFixed(4))
  }
}

/** A place as a person reads it: "50% across, 35% down"; null when unplaced. */
export function formatPlace(cell) {
  if (!isPlaced(cell)) return null
  return `${Math.round(Number(cell.plan_x) * 100)}% across, ${Math.round(Number(cell.plan_y) * 100)}% down`
}

/** `.svg` by name or by type; the bucket's MIME allow-list is the control. */
export function isSvgFile(file) {
  if (!file) return false
  return /\.svg$/i.test(file.name || '') || file.type === 'image/svg+xml'
}

/**
 * Width over height from an SVG document's viewBox, or from its width and height attributes,
 * or null when the drawing states neither. Without one the browser renders 300x150 and every
 * place on the plan would move with the window, so such a file is refused at upload.
 */
export function svgAspectFromText(text) {
  if (typeof text !== 'string') return null
  const open = /<svg\b[^>]*>/i.exec(text)
  if (!open) return null
  const attrs = open[0]
  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)
    return m ? m[1].trim() : null
  }
  const viewBox = attr('viewBox')
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return round(parts[2] / parts[3])
  }
  const width = parseLength(attr('width'))
  const height = parseLength(attr('height'))
  if (width > 0 && height > 0) return round(width / height)
  return null
}

function parseLength(value) {
  if (!value || /%$/.test(value)) return null
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

function round(n) {
  return Number(n.toFixed(4))
}

/** Where a floor's plan is stored: one folder per floor, so the policy can name the floor. */
export function floorPlanPath(floor, stamp = Date.now()) {
  return `${floor.area_id}/${floor.floor_id ?? floor.id}/plan-${stamp}.svg`
}

/** The next unused level in a direction, for the Add floor form's default. */
export function nextLevel(floors, direction = 1) {
  const levels = (floors || []).map(f => f.level).filter(Number.isInteger)
  if (levels.length === 0) return 0
  return direction < 0 ? Math.min(...levels) - 1 : Math.max(...levels) + 1
}
