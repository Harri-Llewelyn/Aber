/**
 * A device's place in the Unified Namespace, as public.device_uns_paths answers it (0214): its path
 * below the root, or why it has none. The bridge publishes from the same rows, so a page shows the
 * topic the bridge uses. Why one view: supabase/README.md, "Each device shows its place in the
 * Unified Namespace (0214)".
 */
import { readFlag, readSetting } from '../config'
import { SOURCE_SHADOW } from './cellResolution'

/**
 * Whether the bridge publishes (ingestion.unsMqttEnabled). Absent reads as off, the chart's default,
 * and the pages then read nothing. Read per call, so a test can set it.
 */
export const unsBridgeOn = () => readFlag('VITE_UNS_MQTT_ENABLED', false)

/** The root every topic sits under (ingestion.unsMqttTopicRoot), trimmed of slashes as the bridge trims it. */
export const unsTopicRoot = () => readSetting('VITE_UNS_MQTT_TOPIC_ROOT', 'uns').replace(/^\/+|\/+$/g, '') || 'uns'

/** The view's rows keyed by device id, or null when they could not be read. */
export const unsPathIndex = (rows) => (Array.isArray(rows) ? new Map(rows.map(r => [r.device_id, r])) : null)

/** The topic a device's readings are published under, `<root>/<path>`, or null when it has none. */
export const unsTopicOf = (row) => (row?.uns_path ? `${unsTopicRoot()}/${row.uns_path}` : null)

const UNSAFE = /[/+#]/

/** Which name on the device's path a topic cannot carry, and where it is changed. */
function unsafeName({ device, cell, area }) {
  if (UNSAFE.test(device?.asset_name || '')) return 'its name contains /, + or #. Rename it in Edit Details.'
  if (UNSAFE.test(cell?.cell_name || '')) return "its cell's name contains /, + or #. Rename the cell on the Cells page."
  if (UNSAFE.test(area?.area_name || '')) return "its area's name contains /, + or #. Rename the area on the Areas page."
  return "the site's name contains /, + or #. Change it on the Settings page, under Site."
}

/**
 * One sentence per reason the view gives, saying what fixes it. The keys are the view's reasons;
 * mirror check 27 (scripts/check-mirror-drift.mjs) holds the two sets together.
 */
const SKIP_SENTENCES = {
  site_unset: () => 'the site has no name yet. Set one on the Settings page, under Site.',
  lane: ({ source }) => (source === SOURCE_SHADOW
    ? 'it is a replay lane, a recording of a device, not a place on the plant.'
    : 'it is a simulated device, not a place on the plant.'),
  unassigned: () => 'nothing says where it is. Put it in a cell in Edit Details, or make it Area-Wide or Site-Wide.',
  cell_unfiled: () => 'its cell is in no area. Put the cell in an area on the Cells page.',
  unsafe_name: unsafeName,
}

export const UNS_SKIP_REASONS = Object.keys(SKIP_SENTENCES)

/**
 * Why a device is not in the Unified Namespace, in words. `context` is `{ device, cell, area,
 * source }`: the device row, its cell and area as the page holds them, and its location_source.
 */
export function unsSkipSentence(reason, context = {}) {
  const says = SKIP_SENTENCES[reason]
  return `Not in the Unified Namespace: ${says ? says(context) : 'its place could not be worked out.'}`
}

/**
 * The subscription filter for everything beneath an area or a cell, `<root>/<enterprise>/<site>/
 * <area>/#` or `.../<cell>/#`, cut from the paths of the devices in it. Null while none of them has
 * one. Devices under more than one Sparkplug group make the enterprise `+`.
 */
export function unsFilterFor(index, { areaId, cellId }) {
  if (!index) return null
  const depth = cellId ? 4 : 3
  const heads = [...index.values()]
    .filter(r => r.uns_path && (cellId ? r.cell_id === cellId : r.area_id === areaId))
    .map(r => r.uns_path.split('/').slice(0, depth))
  if (heads.length === 0) return null
  const enterprise = new Set(heads.map(h => h[0])).size === 1 ? heads[0][0] : '+'
  return [unsTopicRoot(), enterprise, ...heads[0].slice(1), '#'].join('/')
}

/**
 * How many devices' topics renaming this area, cell or device moves: those with a path that names
 * it. A skipped device has no topic to move.
 */
export function unsTopicsMoved(index, { areaId, cellId, deviceId }) {
  if (!index) return 0
  return [...index.values()].filter(r => r.uns_path && (
    deviceId ? r.device_id === deviceId : cellId ? r.cell_id === cellId : r.area_id === areaId
  )).length
}
