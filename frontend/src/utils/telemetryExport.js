/**
 * The export dialog's logic, as pure functions: who may export and for how long, which resolutions
 * cover a range, which one to offer when the chosen one does not, and what shape the CSV takes.
 *
 * Kept out of the component because the decisions here are the kind that are wrong quietly. A
 * rollup row is NOT a raw row, and one squeezed into the other's place would hand a reader
 * averages where they asked for samples (issue #160): so the file says which it holds in its first
 * line, and export_telemetry() (0279) never reads one in the other's place.
 */

import { dayWords } from './alertSuppression'
import { splitDerived } from './derivedMetric'

/**
 * Who may export readings, as export_telemetry() admits them (mirror check 90). Operators read the
 * charts and do not export: the database refuses them, and the buttons are off.
 */
export const TELEMETRY_EXPORT_ROLES = ['Administrator', 'Shopfloor_Manager']

export const mayExportReadings = (role) => TELEMETRY_EXPORT_ROLES.includes(role)

/** The hover text of an Export this session may not use, in the dashboard's denied-title form. */
export const EXPORT_DENIED_TITLE = `Requires ${TELEMETRY_EXPORT_ROLES.map(r => r.replace(/_/g, ' ')).join(' or ')}`

/** The setting that holds the longest window one export may cover, in days. */
export const EXPORT_MAX_DAYS_KEY = 'history.export_max_days'

/**
 * The longest export where the setting cannot be read or is out of its bounds, and those bounds:
 * 0278's seed, and what telemetry_export_max_days() falls back to (mirror check 91).
 */
export const EXPORT_MAX_DAYS = 14
export const EXPORT_MAX_DAYS_MIN = 1
export const EXPORT_MAX_DAYS_MAX = 366

/** Where the limit is set, as the database's refusal names it (mirror check 91). */
export const EXPORT_MAX_DAYS_PLACE = 'Settings › History'

/** The longest export in days, from the setting's stored value, as the database reads it. */
export function exportMaxDays(value) {
  return typeof value === 'number' && value >= EXPORT_MAX_DAYS_MIN && value <= EXPORT_MAX_DAYS_MAX
    ? value
    : EXPORT_MAX_DAYS
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whether [start, end) is longer than `maxDays`, as export_telemetry() measures it: in seconds, not calendar days. */
export const overExportLimit = (startMs, endMs, maxDays) => endMs - startMs > maxDays * DAY_MS

/**
 * Why a window cannot be exported, in words, or null: it is no span of time yet, or it is longer
 * than the setting allows. The long one is the database's own sentence, so a person reads the same
 * before and after (export_telemetry() rounds the window's length up to whole days).
 */
export function exportWindowProblem(startMs, endMs, maxDays) {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) {
    return 'Set both ends of the custom range to export it.'
  }
  if (!overExportLimit(startMs, endMs, maxDays)) return null
  const days = Math.ceil((endMs - startMs) / DAY_MS)
  return `An export can cover at most ${dayWords(maxDays)}, set on ${EXPORT_MAX_DAYS_PLACE}. This window is ${days} days.`
}

/** What an export says where a derived metric is among the metrics chosen. */
export const DERIVED_EXPORT_NOTE = 'A derived metric is computed when it is drawn, and is not exported. Export its inputs.'

/**
 * The metrics an export names: `names` less the derived ones, which are computed when drawn and
 * hold no reading to export (`left`, said with DERIVED_EXPORT_NOTE). export_telemetry() is as it was.
 * One rule, for every place that offers Export: pass `names` and the catalog, name `names` in the
 * export and say `left` where it is not empty.
 */
export function exportableMetrics(names, catalog) {
  const { measured, derived } = splitDerived(names, catalog)
  return { names: measured, left: derived }
}

/** The most devices and metrics one export may name, as export_telemetry() holds them (mirror check 92). */
export const EXPORT_MAX_DEVICES = 1000
export const EXPORT_MAX_METRICS = 500

/** Why a selection is too many devices or metrics for one export, in words, or null. */
export function exportSizeProblem(devices, metrics) {
  if (devices > EXPORT_MAX_DEVICES) {
    return `An export names at most ${EXPORT_MAX_DEVICES.toLocaleString()} devices, and this selection has ${devices.toLocaleString()}.`
  }
  if (metrics > EXPORT_MAX_METRICS) {
    return `An export names at most ${EXPORT_MAX_METRICS.toLocaleString()} metrics, and these devices report ${metrics.toLocaleString()}.`
  }
  return null
}

const countWords = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * What the Area tab's export covers, as the dialog's first line opens: the area, then the machines
 * behind its charts and the cells they are in. `cellCounts` holds the machine count of each cell
 * that has a machine reporting the metric: "Boardroom · 14 machines in 3 cells".
 */
export function areaExportScope(areaName, cellCounts) {
  const machines = cellCounts.reduce((sum, n) => sum + n, 0)
  return `${areaName} · ${countWords(machines, 'machine', 'machines')} in ${countWords(cellCounts.length, 'cell', 'cells')}`
}

/**
 * What the Area tab's dialog says the file leaves out. A cell's chart is a mean or a total of its
 * machines' readings, a fold and not a reading, so the file holds the machines' own readings and
 * none of those. A device that is Area-Wide is in no cell and in no chart, so it is not in the file.
 */
export function areaExportNote(areaWide = 0) {
  const base = "The cells' means and totals are not in the file. It holds each machine's own readings."
  if (!areaWide) return base
  return `${base} ${countWords(areaWide, 'Area-Wide device is', 'Area-Wide devices are')} in no cell, so ${areaWide === 1 ? 'it is' : 'they are'} not in the file.`
}

/** What the Metric tab's export covers: "23 devices", or "23 of 40 devices" where a filter narrows what reports the metric. */
export function metricExportScope(listed, reporting) {
  return listed === reporting
    ? countWords(listed, 'device', 'devices')
    : `${listed.toLocaleString()} of ${countWords(reporting, 'device', 'devices')}`
}

/** What the Metric tab's dialog says where the tab pages: the file holds every device listed, not the page shown. */
export function metricExportNote(listed, pageSize) {
  return `The file holds all ${countWords(listed, 'device', 'devices')} the tab lists, not only the ${pageSize} on this page.`
}

/** The short form, for a line that is already long: "over the 14-day export limit". */
export const overLimitShort = (maxDays) => `over the ${maxDays}-day export limit`

/**
 * The four choices the picker offers, finest first.
 *
 * `relation` matches the `relation` column of `public.telemetry_horizons` (archived migration 0111).
 * `param` is what goes on the wire as export_telemetry()'s `resolution`, which is `raw` for raw:
 * `null` here means the choice that is not a rollup.
 *
 * ORDER IS LOAD-BEARING. bestResolutionFor() walks this array and takes the first that covers the
 * range, which is the FINEST one that does -- the offer that loses the least detail. Reversing it
 * would silently start offering hourly averages to someone a minute rollup would have served.
 */
export const EXPORT_RESOLUTIONS = [
  { key: 'raw', param: null, relation: 'telemetry',    label: 'Raw samples', short: 'raw',
    note: 'Every reading as published.' },
  { key: '1m',  param: '1m', relation: 'telemetry_1m', label: '1 minute',    short: '1-minute buckets',
    note: 'Averaged per minute.' },
  { key: '5m',  param: '5m', relation: 'telemetry_5m', label: '5 minutes',   short: '5-minute buckets',
    note: 'Averaged per five minutes.' },
  { key: '1h',  param: '1h', relation: 'telemetry_1h', label: '1 hour',      short: '1-hour buckets',
    note: 'Averaged per hour.' }
]

const RAW_RESOLUTION = EXPORT_RESOLUTIONS[0]

/** The entry for a key, falling back to raw so an unknown key can never select a rollup. */
export function resolutionByKey(key) {
  return EXPORT_RESOLUTIONS.find(r => r.key === key) || RAW_RESOLUTION
}

/**
 * Does this resolution hold data going back to `from`?
 *
 * THREE-VALUED ON PURPOSE. `null` means "not known" -- the horizons query failed, or the stack has
 * no such relation -- and is not the same as `false`. A caller must not warn on the strength of a
 * lookup that never answered, because the export itself may well succeed; the dialog would be
 * refusing on its own ignorance.
 *
 * A relation present but empty (`oldest` null in the row, absent from the map here) is `null` too,
 * for the same reason: an empty stack covers nothing at any resolution, so there is no better
 * resolution to offer and nothing useful to say beyond what the export's own result will say.
 */
export function coversRange(horizons, relation, from) {
  if (!horizons || !(relation in horizons)) return null
  const oldest = horizons[relation]
  if (!(oldest instanceof Date) || Number.isNaN(oldest.getTime())) return null
  const start = from instanceof Date ? from : new Date(from)
  if (Number.isNaN(start.getTime())) return null
  // `<=`: a horizon exactly at the range start covers it. The bound the export reads is inclusive
  // (`time >= from`), so the row at that instant is returned.
  return oldest.getTime() <= start.getTime()
}

/**
 * The finest resolution that covers the whole range, or null if none does (or nothing is known).
 *
 * Finest rather than furthest-reaching: a range starting 100 days back is served by the 1-minute
 * rollup at 180 days, and offering the hourly one instead would throw away 59 buckets in 60 for no
 * reason. Derived from the horizons the database reported rather than from the order of the
 * retention settings, because a stack may have rollups disabled, empty, or retained out of the
 * order the defaults imply.
 */
export function bestResolutionFor(horizons, from) {
  return EXPORT_RESOLUTIONS.find(r => coversRange(horizons, r.relation, from) === true) || null
}

/**
 * The columns every export carries, one row per reading: its time, device, metric, value and unit.
 * A raw reading is the reading as published. A rollup's row is its bucket: the time is the bucket's
 * start and the value its average, or its last value for a text or a flag, which have no average.
 */
export const EXPORT_COLUMNS = ['time', 'device', 'metric', 'value', 'unit']

/**
 * The rows of export_telemetry()'s document as the file carries them. `nameOf` maps a device's
 * Sparkplug id to the name the dashboard shows; a device it does not know keeps its id.
 */
export function exportRows(document, nameOf = new Map()) {
  return (document?.rows ?? []).map(([time, assetId, metric, value, unit]) => ({
    time, device: nameOf.get(assetId) ?? assetId, metric, value, unit
  }))
}

/**
 * A `#` comment row carrying `text` in the first column and, with `secondText`, the second.
 *
 * Every column is present and empty but those, because downloadCSV takes the UNION of the rows'
 * keys: a comment row with keys of its own would add columns to the file.
 */
export function commentRow(text, secondText = '') {
  const row = Object.fromEntries(EXPORT_COLUMNS.map(c => [c, '']))
  row[EXPORT_COLUMNS[0]] = text
  if (secondText) row[EXPORT_COLUMNS[1]] = secondText
  return row
}

/**
 * The provenance line every export carries, naming the resolution that produced it.
 *
 * IN THE FILE, NOT ONLY IN THE DIALOG: the dialog is gone the moment it is dismissed and the file
 * is what gets forwarded to someone else. Without it a rollup export is indistinguishable from a
 * raw one that happened to be sparse, and the point of offering a rollup is that the reader asked
 * for samples and is getting buckets.
 */
export function provenanceRow(resolutionKey) {
  const entry = resolutionByKey(resolutionKey)
  return resolutionKey === 'raw'
    ? commentRow('# RESOLUTION: raw samples (public.telemetry)', '# every reading as published')
    : commentRow(`# RESOLUTION: ${entry.short} (public.${entry.relation})`,
      '# aggregated, NOT individual readings; time is the bucket start and value its average, or its last value for a text or a flag')
}

/**
 * The comment rows that follow the provenance line when the file is not the window asked for: raw
 * begins after the window starts (`read_from`), or the rows end before it does (`truncated`,
 * `read_to`). The file is what gets forwarded, so it says so itself.
 */
export function noticeRows(document, askedFrom, maxRows) {
  const rows = []
  if (document?.resolution === 'raw' && Date.parse(document.read_from) > Date.parse(askedFrom)) {
    rows.push(commentRow(`# STARTS AT ${document.read_from}`, '# raw readings before it have been dropped; a rollup still holds them'))
  }
  if (document?.truncated) {
    rows.push(commentRow(
      `# TRUNCATED at ${maxRows} rows`,
      `# the rows end at ${document.read_to}; narrow the window, choose fewer devices or metrics, or a coarser resolution`
    ))
  }
  return rows
}
