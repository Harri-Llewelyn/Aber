/**
 * Area plans: the drawing an area carries, and the places cells take on it.
 *
 * A place is two fractions of the plan's viewBox (`plan_x` across, `plan_y` down, 0..1), so it
 * survives the plan being redrawn at any size. Distances are measured in units of the plan's
 * shorter side, so one spacing setting means the same on a wide plan and a tall one. Mirror of
 * `public.plan_distance()` and `place_cell_in_its_area()` in
 * supabase/migrations/0001_baseline_schema.sql; the trigger is the authority and the checks here
 * only refuse earlier.
 */

/** The outline drawn for an area with no plan: 4:3, as the default box in the database. */
export const DEFAULT_PLAN_ASPECT = 4 / 3

/** The seeded default of `site_map.min_pin_spacing`, used until the setting has loaded. */
export const DEFAULT_MIN_PIN_SPACING = 0.08
export const MIN_PIN_SPACING_SETTING = 'site_map.min_pin_spacing'

/** The bucket's limit, mirrored so an oversized file is refused before the upload. */
export const AREA_PLAN_MAX_BYTES = 5 * 1024 * 1024

/** Width over height of an area's plan, falling back to the default outline. */
export function planAspect(area) {
  const aspect = Number(area?.plan_aspect)
  return Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_PLAN_ASPECT
}

/** True when both fractions are numbers: the cell has a place on its area's plan. */
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
 * already in the area; the one being placed is excluded by id, and archived cells do not hold
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

/** The bounds of `areas.plan_aspect`, numeric(8,4); a plan outside them is refused before the upload. */
const PLAN_ASPECT_MIN = 0.0001
const PLAN_ASPECT_MAX = 9999.9999

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Absolute CSS units to px, as a browser sizes an SVG viewport. Relative units and percentages say nothing about shape. */
const PX_PER_UNIT = { '': 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 }

/** The text of an uploaded plan, decoded by its byte-order mark: an SVG saved as UTF-16 is still an SVG. */
export function decodeSvgBytes(buffer) {
  const bytes = new Uint8Array(buffer)
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  return new TextDecoder(encoding).decode(buffer)
}

/**
 * What a browser will make of an SVG plan: `{ aspect }`, width over height, or `{ problem }`
 * saying why the file is refused. The document is parsed as the browser parses it, so the check
 * fails where the plan would: XML that is not well-formed is a broken image, a root outside the
 * SVG namespace draws nothing, `viewBox` is case-sensitive, and the fallback to width and height
 * honours their units. Without any stated size the browser renders 300x150 and every place on the
 * plan would move with the window. The aspect is rounded to the column's four places.
 */
export function readSvgPlan(text) {
  if (typeof text !== 'string' || !text.trim()) return { problem: 'The file is empty.' }
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || doc.getElementsByTagName('parsererror').length) {
    return { problem: 'The file is not well-formed XML, so a browser cannot draw it.' }
  }
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    return { problem: 'The root element is not an SVG (is xmlns="http://www.w3.org/2000/svg" on it?), so a browser draws nothing.' }
  }
  let aspect = null
  const viewBox = root.getAttribute('viewBox')
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) aspect = parts[2] / parts[3]
  }
  if (aspect === null) {
    const width = parseLength(root.getAttribute('width'))
    const height = parseLength(root.getAttribute('height'))
    if (width > 0 && height > 0) aspect = width / height
  }
  if (aspect === null) {
    return { problem: 'The SVG states no size: give it a viewBox (or width and height) so places on it stay put.' }
  }
  const rounded = Number(aspect.toFixed(4))
  if (rounded < PLAN_ASPECT_MIN || rounded > PLAN_ASPECT_MAX) {
    return { problem: `The plan's proportions (${Number(aspect.toPrecision(3))} wide for every 1 tall) are beyond what an area plan can hold (${PLAN_ASPECT_MIN} to ${PLAN_ASPECT_MAX}).` }
  }
  return { aspect: rounded }
}

/** A length attribute in px, or null for a relative unit, a percentage, or no length at all. */
function parseLength(value) {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value || '')
  if (!m) return null
  const perUnit = PX_PER_UNIT[m[2].toLowerCase()]
  return perUnit === undefined ? null : Number(m[1]) * perUnit
}

/** Where an area's plan is stored: one folder per area, so the policy can name the area. */
export function areaPlanPath(area, stamp = Date.now()) {
  return `${area.area_id ?? area.id}/plan-${stamp}.svg`
}
