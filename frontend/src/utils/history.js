/**
 * The History page's arithmetic: the window it opens on, the resolution the row cap picks or the
 * one chosen, its address, a chart's buckets and series, and the words a chart says. Pure, so each
 * rule is unit-tested; frontend/README.md, "History and its chart".
 */
import {
  COVERAGE_LARGE_MAX_HOURS, COVERAGE_MAX_DEVICES, COVERAGE_ROLLUP_MINUTES, COVERAGE_SMALL_SELECTION, HISTORY_CHANGE_READINGS,
  HISTORY_GROUP_READ_ROWS, HISTORY_MAX_CHANGES, HISTORY_MAX_ROWS, HISTORY_RESOLUTIONS, HOUR_OF_DAY_MAX_ROWS,
} from '../api'
import { encodeList } from '../hooks/useUrlState'
import { modelledMetricsAcross, schemasForDevice } from './deviceTags'
import { datatypeLabel } from './sparkplugDatatype'
import { modelledConstraints } from './payloadConformance'
import { deviceIdentifiers, deviceIds } from './sparkplugId'
import { SOURCE_SIMULATED, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED, groupDevicesByCell } from './cellResolution'
import { areaWideInService, inServiceDevices } from './inService'
import { DERIVED_MAX_MINUTES, derivedInputCount, derivedReportedBy } from './derivedMetric'
import {
  SPAN_IDS, TIME_PRESETS, bandWords, calendarTicks, clockWords, localDay, rollingWindow, windowToQuery,
} from './timeWindow'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The rolling ranges and spans History offers: all of them, and no All time. */
export const HISTORY_RANGES = TIME_PRESETS
export const HISTORY_SPANS = SPAN_IDS

/** The window History opens on, Last 24 hours. */
export const DEFAULT_HISTORY_WINDOW = rollingWindow('24h', HISTORY_RANGES)

/** How often History may read again by itself, in seconds; 0 is off. Each read redraws every chart. */
export const HISTORY_REFRESH_EVERY = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
]

/** Why the timer is off for a window that has ended: nothing new can arrive in it. */
export const ENDED_WINDOW_REASON = 'This window has ended, so nothing new can arrive in it. Refresh still reads it again.'

/**
 * How many buckets of `minutes` the read lays over [start, end): from the bucket holding `start`,
 * on the epoch grid the rollups use, so a window opening inside a bucket counts that bucket.
 */
export function bucketCount(startMs, endMs, minutes) {
  const width = minutes * MINUTE
  const first = Math.floor(startMs / width) * width
  return Math.max(0, Math.ceil((endMs - first) / width))
}

/**
 * The finest resolution whose rows (buckets times series) fit the row cap, with `perRead` the
 * series one read carries: all of them. When no resolution fits them all, the coarsest, with as
 * many series a read as fit there. Null when one series does not fit even at the coarsest.
 */
export function pickResolution(startMs, endMs, series, {
  resolutions = HISTORY_RESOLUTIONS, maxRows = HISTORY_MAX_ROWS,
} = {}) {
  const n = Math.max(1, series)
  for (const r of resolutions) {
    if (bucketCount(startMs, endMs, r.minutes) * n <= maxRows) return { ...r, perRead: n }
  }
  const coarsest = resolutions[resolutions.length - 1]
  const buckets = bucketCount(startMs, endMs, coarsest.minutes)
  if (buckets < 1 || buckets > maxRows) return null
  return { ...coarsest, perRead: Math.floor(maxRows / buckets) }
}

/** The Buckets control's choices: Auto, the finest that fits (pickResolution), then each resolution. */
export const HISTORY_BUCKETS = ['auto', ...HISTORY_RESOLUTIONS.map(r => r.id)]

/** Why a resolution finer than Auto's is off: its rows would pass the row cap. */
export const TOO_MANY_BUCKETS = 'Too many buckets for this window: choose fewer metrics or a shorter window.'

/**
 * The resolution a read takes for `bucket`, one of HISTORY_BUCKETS: Auto's pick, or the one chosen
 * when it is as coarse as Auto's or coarser, with every series in one read. A finer one would pass
 * the row cap, so the read takes Auto's pick and `refused` names the one chosen. `resolution` is
 * null when one series does not fit even at the coarsest.
 */
export function resolutionFor(startMs, endMs, series, bucket = 'auto', options = {}) {
  const resolutions = options.resolutions ?? HISTORY_RESOLUTIONS
  const auto = pickResolution(startMs, endMs, series, options)
  const at = resolutions.findIndex(r => r.id === bucket)
  if (!auto || at < 0) return { resolution: auto, refused: null }
  const autoAt = resolutions.findIndex(r => r.id === auto.id)
  if (at < autoAt) return { resolution: auto, refused: resolutions[at] }
  if (at === autoAt) return { resolution: auto, refused: null }
  return { resolution: { ...resolutions[at], perRead: Math.max(1, series) }, refused: null }
}

/**
 * The Buckets control's options for Auto's pick `auto`: Auto, then each resolution, on when it is
 * as coarse as Auto's pick or coarser. With no pick, only Auto is on.
 */
export function bucketOptions(auto) {
  const autoAt = auto ? HISTORY_RESOLUTIONS.findIndex(r => r.id === auto.id) : HISTORY_RESOLUTIONS.length
  return [
    { value: 'auto', label: 'Auto buckets', on: true },
    ...HISTORY_RESOLUTIONS.map((r, i) => ({ value: r.id, label: r.words, on: i >= autoAt })),
  ]
}

/**
 * A metric's kind before it is read, from its catalog datatype: text (String, Text, UUID), flag
 * (Boolean), or number (the numeric types, DateTime and the rest); null when the catalog does not
 * know the metric.
 */
export function datatypeKind(code) {
  if (code === null || code === undefined) return null
  if (code === 11) return 'flag'
  if (code === 12 || code === 14 || code === 15) return 'text'
  return 'number'
}

/**
 * The order of History's groups, by Sparkplug datatype code: Double and Float, then the integers,
 * then Boolean, then String and Text. Any other datatype follows by its code, then Other.
 */
const GROUP_ORDER = [10, 9, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14]

/** The group of the metrics the catalog does not know. */
export const OTHER_GROUP = 'Other'

/**
 * `names` grouped by their catalog datatype, each group named as the Metrics page names the type
 * ("Double", "Boolean") and in GROUP_ORDER, the names in each in the order given: `[{ key, label,
 * names }]`. A name the catalog does not know is in Other, last.
 */
export function metricGroups(names, catalog) {
  const code = new Map((catalog || []).map(m => [m.name, m.datatype]))
  const groups = new Map()
  for (const name of names) {
    const c = code.get(name)
    const known = c !== null && c !== undefined
    const key = known ? String(c) : 'other'
    if (!groups.has(key)) {
      const at = GROUP_ORDER.indexOf(c)
      groups.set(key, { key, label: known ? datatypeLabel(c) : OTHER_GROUP, names: [], rank: !known ? Infinity : at >= 0 ? at : 100 + c })
    }
    groups.get(key).names.push(name)
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank).map(({ rank, ...g }) => g)
}

/** The narrowest a text chart's bucket is drawn under Auto, in pixels, so its words stay readable. */
export const TEXT_BUCKET_MIN_PX = 3

/** The chart width assumed when there is none to measure yet. */
export const DEFAULT_CHART_PX = 960

/**
 * Auto's pick for text charts `widthPx` wide: the finest resolution whose buckets are each at least
 * TEXT_BUCKET_MIN_PX across and whose rows fit the row cap, or the coarsest when none is that wide.
 */
export function readableResolution(startMs, endMs, series, widthPx, {
  resolutions = HISTORY_RESOLUTIONS, maxRows = HISTORY_MAX_ROWS, minPx = TEXT_BUCKET_MIN_PX,
} = {}) {
  const wide = resolutions.filter(r => bucketCount(startMs, endMs, r.minutes) * minPx <= widthPx)
  return pickResolution(startMs, endMs, series, { resolutions: wide.length ? wide : resolutions.slice(-1), maxRows })
}

/**
 * The reads a window takes: groups of metrics, each at one resolution. A Buckets choice reads every
 * metric at it. Under Auto, or when the choice is too fine (`refused`), text metrics (`textNames`)
 * read apart at readableResolution() for charts `widthPx` wide, flagged `text`, and the rest at
 * pickResolution() for their own number. `problem` when one series does not fit even at 1 day.
 *
 * Each group's `changes` are its text and flag metrics (`stateNames`), whatever the buckets: they
 * also take the change read (telemetry_changes(), 0254), which draws every change while raw
 * telemetry holds the window and the cap allows, and marks the group's buckets otherwise.
 */
export function readPlan(startMs, endMs, {
  names, textNames = new Set(), stateNames = new Set(), bucket = 'auto', widthPx = DEFAULT_CHART_PX,
}) {
  const withChanges = (g) => ({ ...g, changes: g.names.filter(n => stateNames.has(n)) })
  const { resolution: chosen, refused } = resolutionFor(startMs, endMs, names.length, bucket)
  if (!chosen) return { problem: true, groups: [], refused: null }
  if (bucket !== 'auto' && !refused) return { groups: names.length ? [withChanges({ names, resolution: chosen })] : [], refused: null, chosen }
  const text = names.filter(n => textNames.has(n))
  const rest = names.filter(n => !textNames.has(n))
  const groups = []
  if (rest.length) groups.push({ names: rest, resolution: pickResolution(startMs, endMs, rest.length) })
  if (text.length) groups.push({ names: text, resolution: readableResolution(startMs, endMs, text.length, widthPx), text: true })
  if (groups.some(g => !g.resolution)) return { problem: true, groups: [], refused: null }
  return { groups: groups.map(withChanges), refused, chosen }
}

/** `list` in groups of at most `size`, in order. */
export function inReads(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)))
  return out
}

// ------------------------------------------------------------------------------------------------
// The address: /history and /history/overview for Overview, /history/device for the device
// picker, /history/device/<id> for one device's charts.
// ------------------------------------------------------------------------------------------------

/** The tab History opens on: the bare page path, and any path it does not know. */
export const DEFAULT_HISTORY_TAB = 'overview'

/**
 * The tab and device a path's segments name. `/history/device` is the picker and
 * `/history/device/<id>` names a device by its UUID or Sparkplug id; every other path is the
 * Overview, so a link to the bare page lands on it.
 */
export function historyPath(segments) {
  const [, tab, id] = segments
  if (tab !== 'device') return { tab: DEFAULT_HISTORY_TAB, deviceId: '' }
  let deviceId = ''
  if (id) {
    try { deviceId = decodeURIComponent(id) } catch { deviceId = '' }
  }
  return { tab: 'device', deviceId }
}

/** The path of one device's charts, the picker's when `deviceId` is empty. */
export const deviceHistoryPath = (deviceId) =>
  (deviceId ? `/history/device/${encodeURIComponent(deviceId)}` : '/history/device')

/** The Overview's own path. */
export const OVERVIEW_PATH = '/history/overview'

/**
 * The Overview's address at window `win`, with the devices ticked (`device`, their telemetry keys)
 * when there are any.
 */
export function overviewAddress(win, { devices = [] } = {}) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(windowToQuery(win, DEFAULT_HISTORY_WINDOW))) if (v) query.set(k, v)
  if (devices.length) query.set('device', encodeList(devices))
  const q = query.toString().replace(/%2C/gi, ',')
  return `${OVERVIEW_PATH}${q ? `?${q}` : ''}`
}

/**
 * The address of a device's charts, or the picker's, keeping the window shown now, and the metrics
 * chosen (`metric`) and the bucket choice (`bucket`) when they are not the defaults. The next
 * device keeps the metrics it has.
 */
export function pickedAddress(deviceId, win, { metrics = [], bucket = 'auto' } = {}) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(windowToQuery(win, DEFAULT_HISTORY_WINDOW))) if (v) query.set(k, v)
  if (metrics.length) query.set('metric', encodeList(metrics))
  if (bucket && bucket !== 'auto') query.set('bucket', bucket)
  // A list reads with its commas, as useUrlList writes it.
  const q = query.toString().replace(/%2C/gi, ',')
  return `${deviceHistoryPath(deviceId)}${q ? `?${q}` : ''}`
}

// ------------------------------------------------------------------------------------------------
// Which devices, and which of their metrics
// ------------------------------------------------------------------------------------------------

/**
 * The devices History offers: every device but a quarantined one, whose readings are held until it
 * is approved. Each carries the names and ids of the cell and area it sits in, and they are sorted by name.
 */
export function historyDevices(devices, cells, areas) {
  const cellById = new Map(cells.map(c => [c.cell_id ?? c.id, c]))
  const areaById = new Map(areas.map(a => [a.area_id ?? a.id, a]))
  return devices
    .filter(d => !d.is_quarantined)
    .map(d => {
      const cell = cellById.get(d.effective_cell_id) || null
      const area = areaById.get(d.effective_area_id ?? cell?.area_id) || null
      return {
        ...d, cell_name: cell ? (cell.cell_name ?? cell.name ?? null) : null, area_name: area ? (area.area_name ?? area.name ?? null) : null,
        cell_id: cell ? (cell.cell_id ?? cell.id) : null, area_id: area ? (area.area_id ?? area.id) : null,
      }
    })
    .sort((a, b) => String(a.asset_name).localeCompare(String(b.asset_name)))
}

/** Whether a device matches what was typed: its name, an id it answers to, its cell or its area. */
export function deviceMatches(device, text) {
  const needle = String(text ?? '').trim().toLowerCase()
  if (!needle) return true
  return [device.asset_name, device.cell_name, device.area_name, ...deviceIdentifiers(device)]
    .some(v => String(v ?? '').toLowerCase().includes(needle))
}

/**
 * The metrics a device reports: those its last birth declared and those its schemas model, by
 * name. A metric it stopped declaring is still charted while a schema models it. With the `catalog`,
 * each derived metric whose inputs it reports is among them too, all of them (a derived metric applies
 * to every device that reports all its inputs); nothing else changes.
 */
export function deviceMetrics(device, schemas, catalog = null) {
  const declared = Array.isArray(device?.last_birth_metrics) ? device.last_birth_metrics : []
  const modelled = modelledMetricsAcross(schemasForDevice(device, schemas)) || new Set()
  const measured = [...new Set([...declared, ...modelled])].filter(Boolean)
  const derived = catalog ? derivedReportedBy(new Set(measured), catalog) : []
  return [...new Set([...measured, ...derived])].sort((a, b) => a.localeCompare(b))
}

/**
 * Each metric's valid range, the schemas' `minimum` and `maximum` (the widest where several model
 * it), as a Map of name to `{ minimum, maximum }`; empty when a schema cannot be read.
 */
export function validRanges(device, schemas) {
  try {
    const { metrics } = modelledConstraints(schemasForDevice(device, schemas).map(s => s.schema_definition))
    return new Map([...metrics].map(([name, c]) => [name, { minimum: c.minimum, maximum: c.maximum }]))
  } catch {
    return new Map()
  }
}

// ------------------------------------------------------------------------------------------------
// A chart's data
// ------------------------------------------------------------------------------------------------

/** The start of each bucket of [start, end), in seconds, as uPlot's x values. */
export function bucketStarts(startMs, endMs, minutes) {
  const width = minutes * MINUTE
  const out = []
  for (let t = Math.floor(startMs / width) * width; t < endMs; t += width) out.push(t / 1000)
  return out
}

/**
 * One series' rows laid on `starts`. `avg`, `min` and `max` are null where the read returned no
 * row; `carried` marks a bucket with no reading. A flag charts as 1 and 0, and a state, which no
 * line can draw, keeps its text in `states`. `last` is each bucket's last value as it was read: a
 * number, true or false, or a state's text. `kind` is what the series holds: number, flag, state,
 * or none for a series with no row at all.
 */
export function chartSeries(rows, starts) {
  const at = new Map()
  for (const r of rows) at.set(Math.round(Date.parse(r.bucket_ts) / 1000), r)
  const has = (pick) => rows.some(r => pick(r) !== null && pick(r) !== undefined)
  const kind = has(r => r.avg_double) || has(r => r.last_double) ? 'number'
    : has(r => r.last_bool) ? 'flag'
      : has(r => r.last_string) ? 'state' : 'none'
  const flag = (r) => (r.last_bool === null || r.last_bool === undefined ? null : r.last_bool ? 1 : 0)
  const pick = {
    avg: (r) => (kind === 'flag' ? flag(r) : r.avg_double ?? null),
    min: (r) => (kind === 'flag' ? flag(r) : r.min_double ?? null),
    max: (r) => (kind === 'flag' ? flag(r) : r.max_double ?? null),
  }
  const last = (r) => (kind === 'number' ? r.last_double : kind === 'flag' ? r.last_bool : r.last_string) ?? null
  const series = { kind, avg: [], min: [], max: [], carried: [], states: [], last: [] }
  for (const x of starts) {
    const r = at.get(x)
    series.avg.push(r ? pick.avg(r) : null)
    series.min.push(r ? pick.min(r) : null)
    series.max.push(r ? pick.max(r) : null)
    series.carried.push(r ? Boolean(r.is_carried) : false)
    series.states.push(r ? r.last_string ?? null : null)
    series.last.push(r ? last(r) : null)
  }
  return series
}

// ------------------------------------------------------------------------------------------------
// Every change of a text or a flag: telemetry_changes() (0254)
// ------------------------------------------------------------------------------------------------

/** What a change read says of a series, as telemetry_changes() names it in `read`. */
export const CHANGE_READS = Object.freeze({
  changes: 'changes', changeCap: 'change_cap', readingCap: 'reading_cap', retention: 'retention',
})

const isValue = (v) => v !== null && v !== undefined

/**
 * A change read's row as a chart draws it, or null when the row is not every change. `starts` are
 * in seconds: the window's start when a value was carried in, each change, then where the last run
 * stops, the window's end or now. The series on them is shaped as chartSeries() shapes one, a flag
 * as 1 and 0, so a flag steps at each change. `runs` are each value's real stretch, `exact`, the
 * one carried in from before the window marked carried up to the first reading in it.
 */
export function changeSeries(row, { start, end, now }) {
  if (row?.read !== CHANGE_READS.changes) return null
  const flag = (row.val_bool || []).some(isValue) || isValue(row.carried_bool)
  const kind = flag ? 'flag' : (row.val_string || []).some(isValue) || isValue(row.carried_string) ? 'state' : 'none'
  const values = (flag ? row.val_bool : row.val_string) || []
  const stop = Math.min(end, now)
  const points = []
  const carried = flag ? row.carried_bool : row.carried_string
  if (isValue(carried)) points.push({ ms: start, value: carried, carried: true })
  ;(row.change_ts || []).forEach((ts, i) => {
    const ms = Math.max(start, Date.parse(ts))
    if (ms < stop) points.push({ ms, value: values[i] ?? null, carried: false })
  })
  // Each value holds until the next change; one that starts and stops at once draws nothing.
  const held = points.filter((p, i) => (i + 1 < points.length ? points[i + 1].ms : stop) > p.ms)
  const runs = []
  held.forEach((p, i) => {
    const to = i + 1 < held.length ? held[i + 1].ms : stop
    const last = runs[runs.length - 1]
    if (!isValue(p.value)) return
    if (last && last.state === p.value && last.endMs === p.ms) {
      last.endMs = to
      last.to = i + 1
    } else {
      runs.push({ state: p.value, from: i, to: i + 1, startMs: p.ms, endMs: to, carried: p.carried ? [{ startMs: p.ms, endMs: to }] : [], exact: true })
    }
  })
  if (held.length) held.push({ ...held[held.length - 1], ms: stop })
  const number = (v) => (kind === 'flag' && isValue(v) ? (v ? 1 : 0) : null)
  const line = held.map(p => number(p.value))
  return {
    starts: held.map(p => p.ms / 1000),
    series: {
      kind,
      avg: line,
      min: line,
      max: line,
      carried: held.map(p => p.carried),
      states: held.map(p => (kind === 'state' ? p.value : null)),
      last: held.map(p => p.value),
      runs,
      changes: runs.filter(r => r.carried.length === 0).length,
    },
  }
}

/**
 * The run under the pointer at `t`, in milliseconds: the one holding it, unless a run thinner than
 * twice `slackMs` lies within `slackMs` of it, which is taken instead, the nearest first. A change
 * of a few seconds is drawn far wider than its time, and is the run worth finding.
 */
export function runNear(runs, t, slackMs = 0) {
  const at = runs.find(r => t >= r.startMs && t < r.endMs) ?? null
  if (!(slackMs > 0)) return at
  const away = (r) => (t < r.startMs ? r.startMs - t : t >= r.endMs ? t - r.endMs : 0)
  const thin = runs.filter(r => r.endMs - r.startMs < 2 * slackMs && away(r) <= slackMs)
  return thin.length ? thin.reduce((best, r) => (away(r) < away(best) ? r : best)) : at
}

/**
 * A bucket series with the change read's marks laid on its buckets: `marked`, how many values each
 * bucket held, 0 where it held one or none. A flag's bucket that held both runs from false to true,
 * as a number's band runs from its lowest to its highest reading.
 */
export function markBuckets(series, starts, row) {
  const at = new Map((row?.marked_ts || []).map((ts, i) => [Math.round(Date.parse(ts) / 1000), row.marked_values?.[i] ?? 2]))
  if (!at.size) return series
  const marked = starts.map(x => at.get(x) ?? 0)
  if (series.kind !== 'flag') return { ...series, marked }
  return {
    ...series,
    marked,
    min: series.min.map((v, i) => (marked[i] > 1 && isValue(v) ? 0 : v)),
    max: series.max.map((v, i) => (marked[i] > 1 && isValue(v) ? 1 : v)),
  }
}

/** Each marked bucket of a series as a stretch of the window, clipped to it and to now, with its last value. */
export function markedStretches(series, starts, { start, end, now, minutes }) {
  const width = minutes * MINUTE
  const stop = Math.min(end, now)
  return (series.marked || []).flatMap((n, i) => {
    const from = Math.max(start, starts[i] * 1000)
    const to = Math.min(stop, starts[i] * 1000 + width)
    return n > 1 && to > from ? [{ startMs: from, endMs: to, values: n, last: series.last[i] }] : []
  })
}

/**
 * Which read a state chart shows, in words: "every change", or "the last value in each 5-minute
 * bucket" with the reason the change read gave. Null when no change read answered for it.
 */
export function readWords(row, resolution) {
  if (!row) return null
  if (row.read === CHANGE_READS.changes) return 'every change'
  const each = `the last value in each ${resolution.words.replace(/s$/, '')}`
  if (row.read === CHANGE_READS.changeCap) return `${each}, past the ${HISTORY_MAX_CHANGES.toLocaleString()}-change cap`
  if (row.read === CHANGE_READS.readingCap) return `${each}, past the ${HISTORY_CHANGE_READINGS.toLocaleString()}-reading cap`
  if (row.read === CHANGE_READS.retention) {
    const kept = Date.parse(row.raw_from)
    const day = Number.isFinite(kept) ? new Date(kept).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
    return `${each}, older than raw retention${day ? ` (kept from ${day})` : ''}`
  }
  return each
}

/**
 * The status line's part for the state charts, `states` being each one's kind (text or flag) and
 * read in words: "text and flags show every change" when any does, else the first chart's read.
 * `words` is that read, so a chart reading otherwise can say its own. Null for no state chart.
 */
export function stateReadLine(states) {
  if (!states.length) return null
  const kinds = new Set(states.map(s => s.kind))
  const noun = kinds.has('text') && kinds.has('flag') ? 'text and flags' : kinds.has('flag') ? 'flags' : 'text'
  const words = states.some(s => s.words === 'every change') ? 'every change' : states[0].words
  return { line: `${noun} ${noun === 'text' ? 'shows' : 'show'} ${words}`, words }
}

/**
 * The newest bucket a reading arrived in, never a carried one: its index and the last value read
 * in it. Null when no reading arrived in the window.
 */
export function latestReading(series) {
  for (let i = series.last.length - 1; i >= 0; i--) {
    if (!series.carried[i] && series.last[i] !== null && series.last[i] !== undefined) return { i, value: series.last[i] }
  }
  return null
}

// ------------------------------------------------------------------------------------------------
// A state's runs, and its key
// ------------------------------------------------------------------------------------------------

/** The most values a state chart's key names; the rest are counted as others. */
export const STATE_KEY_MAX = 6

/**
 * A state series as runs of one value across the window, each with its stretch in milliseconds,
 * clipped to the window and to now, and `carried`, the stretches inside it with no reading.
 */
export function stateRuns(series, starts, { start, end, now, minutes }) {
  const width = minutes * MINUTE
  const stop = Math.min(end, now)
  const runs = []
  series.states.forEach((state, i) => {
    const from = Math.max(start, starts[i] * 1000)
    const to = Math.min(stop, starts[i] * 1000 + width)
    if (state === null || !(to > from)) return
    let run = runs[runs.length - 1]
    if (!run || run.state !== state || run.to !== i) {
      run = { state, from: i, to: i, startMs: from, endMs: from, carried: [] }
      runs.push(run)
    }
    run.to = i + 1
    run.endMs = to
    if (series.carried[i]) {
      const held = run.carried[run.carried.length - 1]
      if (held && held.endMs === from) held.endMs = to
      else run.carried.push({ startMs: from, endMs: to })
    }
  })
  return runs
}

/** Each value's time across `runs` and its share of the time that has a value, most first. */
export function stateShares(runs) {
  const time = new Map()
  for (const r of runs) time.set(r.state, (time.get(r.state) || 0) + r.endMs - r.startMs)
  const total = [...time.values()].reduce((a, b) => a + b, 0)
  return [...time]
    .map(([state, ms]) => ({ state, ms, share: total > 0 ? ms / total : 0 }))
    .sort((a, b) => b.ms - a.ms || String(a.state).localeCompare(String(b.state)))
}

/**
 * The key under a state chart: the `max` values with the most time, most first, and the rest as
 * one `others` entry, null when there is none.
 */
export function stateKey(shares, max = STATE_KEY_MAX) {
  const rest = shares.slice(max)
  const others = rest.length
    ? { count: rest.length, ms: rest.reduce((a, s) => a + s.ms, 0), share: rest.reduce((a, s) => a + s.share, 0) }
    : null
  return { shown: shares.slice(0, max), others }
}

/**
 * The hue a state's value is drawn in, 0 to 359, from its text alone, so a value has the same
 * colour on every chart, device, refresh and session, and a value never seen before has one too.
 * djb2 over the text's code points, then murmur3's finaliser, since djb2 alone moves with the last
 * character and would put PICK_BIN_A and PICK_BIN_B a degree apart. Two values can still land on
 * near hues; each box keeps its name.
 */
export function stateHue(text) {
  let h = 5381
  for (const ch of String(text)) h = (Math.imul(h, 33) + ch.codePointAt(0)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) % 360
}

/** A share in words: a whole percentage, or "<1%" for a sliver that is there. */
export const shareWords = (share) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`)

/** The key's words: "RUNNING 62%, IDLE 30%, 3 others 8%". */
export function keyWords({ shown, others }) {
  const parts = shown.map(s => `${s.state} ${shareWords(s.share)}`)
  if (others) parts.push(`${others.count} other${others.count === 1 ? '' : 's'} ${shareWords(others.share)}`)
  return parts.join(', ')
}

/** A stretch of time in words: "35 min", "2 h 5 min", "3 d 4 h". */
export function durationWords(ms) {
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 1) return 'under 1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`
}

/** A moment in words at `minutes` buckets: its date and clock time, or its date alone for a day bucket. */
export function momentWords(ms, minutes) {
  const d = new Date(ms)
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return minutes >= 1440 ? day : `${day} ${clockWords(d)}`
}

const secondsWords = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** A moment to the second, "2 Nov 10:05:12": a change's own time, which no bucket rounds. */
export function momentSecondsWords(ms) {
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${secondsWords(d)}`
}

/** A stretch in words to the second under a minute, "35 s", and as durationWords() says it after. */
export const spanWords = (ms) => (ms < 59500 ? `${Math.max(1, Math.round(ms / 1000))} s` : durationWords(ms))

/**
 * A run under the pointer in words: "2 Nov 10:05 – 10:40 · RUNNING, 35 min", and how much of it was
 * carried forward: all of it, or "20 min carried forward". A run of every change (`exact`) is told
 * to the second: "2 Nov 10:05:12 – 10:05:47 · false, 35 s".
 */
export function runWords(run, minutes) {
  const sameDay = new Date(run.startMs).toDateString() === new Date(run.endMs).toDateString()
  const length = run.endMs - run.startMs
  const held = run.carried.reduce((a, c) => a + c.endMs - c.startMs, 0)
  const carried = held <= 0 ? '' : held >= length ? ', carried forward' : `, ${durationWords(held)} carried forward`
  if (run.exact) {
    const to = sameDay ? secondsWords(new Date(run.endMs)) : momentSecondsWords(run.endMs)
    return `${momentSecondsWords(run.startMs)} – ${to} · ${run.state}, ${spanWords(length)}${carried}`
  }
  const to = minutes < 1440 && sameDay ? clockWords(new Date(run.endMs)) : momentWords(run.endMs, minutes)
  return `${momentWords(run.startMs, minutes)} – ${to} · ${run.state}, ${durationWords(length)}${carried}`
}

/**
 * A marked bucket under the pointer in words: its stretch, how many values it held, and the last,
 * which is the one its box shows: "2 Nov 10:05 – 10:10 · 3 values in this bucket, RUNNING last".
 */
export function markWords(mark, minutes, kind = 'state') {
  const sameDay = new Date(mark.startMs).toDateString() === new Date(mark.endMs).toDateString()
  const to = minutes < 1440 && sameDay ? clockWords(new Date(mark.endMs)) : momentWords(mark.endMs, minutes)
  const held = kind === 'flag' ? 'both values' : `${mark.values} values`
  return `${momentWords(mark.startMs, minutes)} – ${to} · ${held} in this bucket, ${valueWords(kind, mark.last)} last`
}

/**
 * The line a carried bucket is drawn on: its value where the bucket was carried, and at the
 * readings either side of a carried run, so the dashed part meets the solid one. The solid line is
 * `avg` where nothing was carried.
 */
export function splitCarried(series) {
  const { avg, carried } = series
  const read = avg.map((v, i) => (carried[i] ? null : v))
  const held = avg.map((v, i) => (carried[i] || carried[i - 1] || carried[i + 1] ? v : null))
  return { read, held }
}

/** Where now falls across [start, end), 0 to 1, or null when the window does not reach past it. */
export function nowFraction(startMs, endMs, nowMs) {
  if (!(endMs > startMs) || !(nowMs > startMs) || nowMs >= endMs) return null
  return (nowMs - startMs) / (endMs - startMs)
}

// ------------------------------------------------------------------------------------------------
// Words
// ------------------------------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })

/** A reading in words: four significant figures, with the unit after it. */
export function readingWords(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const text = NUMBER.format(value)
  return unit ? `${text} ${unit}` : text
}

/** A value as its chart says it: a reading with its unit, true or false, or a state's text. */
export function valueWords(kind, value, unit) {
  if (kind === 'flag') return value ? 'true' : 'false'
  if (kind === 'state') return String(value)
  return readingWords(value, unit)
}

/**
 * The chart head's latest reading, while the pointer is elsewhere: "Latest 21.3 °C · 2 Nov 12:40",
 * the time being the bucket's, since a bucket is not a reading's timestamp. "No reading in this
 * window" when only carried buckets hold a value, and null when nothing does.
 */
export function latestWords(series, starts, minutes, unit) {
  if (series.kind === 'none') return null
  if (series.runs) {
    // Every change: the value now, and since when it has held.
    const run = series.runs[series.runs.length - 1]
    const read = run && run.carried.reduce((a, c) => a - (c.endMs - c.startMs), run.endMs - run.startMs) > 0
    if (!read) return 'No reading in this window'
    const since = run.carried.length ? 'since before this window' : `since ${momentSecondsWords(run.startMs)}`
    return `Latest ${valueWords(series.kind, run.state, unit)} · ${since}`
  }
  const latest = latestReading(series)
  if (!latest) return 'No reading in this window'
  return `Latest ${valueWords(series.kind, latest.value, unit)} · ${momentWords(starts[latest.i] * 1000, minutes)}`
}

/** The chart's title: the metric's name, then its unit in brackets when it has one. */
export const chartTitle = (metric, unit) => (unit ? `${metric} (${unit})` : metric)

/**
 * The text a screen reader is given for a chart: the metric, the window, the resolution, the
 * latest reading and its bucket (as the chart head says it), the lowest and highest, a state's
 * share of the time in each value, how many buckets carried a value forward, and the valid range
 * where the schema declares one. `span` (`{ start, end, now }`, in milliseconds) places a state's
 * runs.
 */
export function chartSummary({ metric, unit, windowText, resolution, series, validRange, starts, span, read = null, derived = false }) {
  const head = `${chartTitle(metric, unit)}${derived ? ', a derived metric' : ''}, ${windowText}, ${series.runs ? 'every change' : read ?? `in ${resolution.words}`}.`
  const shown = series.avg.map((v, i) => i).filter(i => series.avg[i] !== null)
  if (series.kind === 'none' || (series.kind !== 'state' && shown.length === 0)) {
    return `${head} No readings in this window, and none before it.`
  }
  const parts = [head]
  const word = (v) => valueWords(series.kind, v, unit)
  if (series.runs) {
    const latest = latestWords(series, starts, resolution.minutes, unit)
    const last = series.runs[series.runs.length - 1]
    if (latest.startsWith('Latest ')) parts.push(`${latest.replace(' · ', ', ')}.`)
    else parts.push(last ? `No reading in this window; ${word(last.state)} is carried forward from before it.` : `${latest}.`)
    parts.push(`${series.changes} change${series.changes === 1 ? '' : 's'} in this window.`)
    const key = stateKey(stateShares(series.runs))
    if (key.shown.length) parts.push(`Time in each value: ${keyWords(key)}.`)
    return parts.join(' ')
  }
  const latest = latestReading(series)
  if (latest) {
    parts.push(`Latest ${word(latest.value)}, in the bucket from ${momentWords(starts[latest.i] * 1000, resolution.minutes)}.`)
  } else {
    const held = [...series.last].reverse().find(v => v !== null)
    parts.push(held === undefined ? 'No reading in this window.' : `No reading in this window; ${word(held)} is carried forward from before it.`)
  }
  if (series.kind === 'number') {
    const lows = series.min.filter(v => v !== null)
    const highs = series.max.filter(v => v !== null)
    parts.push(`Lowest ${word(Math.min(...lows))}, highest ${word(Math.max(...highs))}.`)
  }
  if (series.kind === 'state' && span) {
    const key = stateKey(stateShares(stateRuns(series, starts, { ...span, minutes: resolution.minutes })))
    if (key.shown.length) parts.push(`Time in each value: ${keyWords(key)}.`)
  }
  const total = series.carried.length
  const held = series.carried.filter(Boolean).length
  if (held > 0) {
    parts.push(`${held} of ${total} bucket${total === 1 ? '' : 's'} had no reading and carry the last one forward.`)
  }
  const mixed = (series.marked || []).filter(n => n > 1).length
  if (mixed > 0) parts.push(`${mixed} of ${total} bucket${total === 1 ? '' : 's'} held more than one value, and show the last.`)
  const range = validRangeWords(validRange, unit)
  if (range) parts.push(`${range}.`)
  return parts.join(' ')
}

/** "Valid range 0 to 100 kW", "Valid range at least 0 kW", or null when the schema sets neither. */
export function validRangeWords(validRange, unit) {
  const lo = validRange?.minimum ?? null
  const hi = validRange?.maximum ?? null
  if (lo === null && hi === null) return null
  if (lo !== null && hi !== null) return `Valid range ${readingWords(lo)} to ${readingWords(hi, unit)}`
  return lo !== null ? `Valid range at least ${readingWords(lo, unit)}` : `Valid range at most ${readingWords(hi, unit)}`
}

// ------------------------------------------------------------------------------------------------
// Colours, from the theme's tokens
// ------------------------------------------------------------------------------------------------

/** `color` at `alpha`: a `#rgb` or `#rrggbb` token as rgba, any other form as it is. */
export function withAlpha(color, alpha) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim())
  if (!hex) return color
  const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1]
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * What a chart is painted with, read from the theme's tokens on `<html>` (App.css), so a canvas
 * follows the theme as the page's CSS does. `read` is the token lookup, for a test.
 */
export function chartPalette(read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name)) {
  const token = (name) => String(read(name) || '').trim()
  const line = token('--accent')
  return {
    line,
    band: withAlpha(line, 0.18),
    text: token('--text-muted'),
    grid: token('--border'),
    range: token('--warning'),
    font: `11px ${token('--font-mono') || 'monospace'}`,
  }
}

// ------------------------------------------------------------------------------------------------
// The Overview: where readings arrived, a lane per device in the Site Map's groups
// ------------------------------------------------------------------------------------------------

/** About how many pixels one coverage block takes: the read asks for one block per this many. */
export const COVERAGE_BLOCK_PX = 4

/**
 * The block widths a small selection may take, in minutes, finest first. From 5 minutes each is a
 * whole number of the 5-minute device rollup's buckets, and from an hour of the hourly one's, so
 * telemetry_coverage() sums the widest rollup that divides it. Nothing is finer than the 5-minute
 * rollup: under it, only telemetry_1m could answer, whose real-time tail walks raw telemetry.
 */
export const COVERAGE_BLOCKS = Object.freeze([5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080])

/** The longest window that still takes 5-minute blocks for a large selection: a day, a day crossing a clock change. */
export const LARGE_FIVE_MINUTE_HOURS = 26

/** Why a large selection does not show a window longer than COVERAGE_LARGE_MAX_HOURS. */
export const TOO_LONG_FOR_MANY = `With more than ${COVERAGE_SMALL_SELECTION} devices, Overview shows 7 days at most. `
  + `Search for a cell, or for up to ${COVERAGE_SMALL_SELECTION} devices, to see a longer window.`

/**
 * The block width a read of `devices` devices takes over [start, end), in minutes, for a strip
 * `widthPx` wide; null when the window is too long for that many (TOO_LONG_FOR_MANY).
 *
 * - Up to COVERAGE_SMALL_SELECTION devices: the finest of COVERAGE_BLOCKS whose blocks number at
 *   most one per COVERAGE_BLOCK_PX of the strip; the widest when none does.
 * - More: the device rollups' own widths, never summed on the historian. 5 minutes up to
 *   LARGE_FIVE_MINUTE_HOURS, then 1 hour up to COVERAGE_LARGE_MAX_HOURS, which the strip may draw
 *   narrower than COVERAGE_BLOCK_PX.
 */
export function coverageBlock(startMs, endMs, widthPx, devices = 1, { blocks = COVERAGE_BLOCKS, px = COVERAGE_BLOCK_PX } = {}) {
  if (devices > COVERAGE_SMALL_SELECTION) {
    const hours = (endMs - startMs) / HOUR
    if (hours <= LARGE_FIVE_MINUTE_HOURS) return COVERAGE_ROLLUP_MINUTES[0]
    return hours <= COVERAGE_LARGE_MAX_HOURS ? COVERAGE_ROLLUP_MINUTES[1] : null
  }
  const most = Math.max(1, Math.floor(widthPx / px))
  return blocks.find(m => bucketCount(startMs, endMs, m) <= most) ?? blocks[blocks.length - 1]
}

/** The devices one coverage read carries: the function's bound. */
export const COVERAGE_PER_READ = COVERAGE_MAX_DEVICES

/** A PostgreSQL interval as the read returns it ("01:00:00", "1 day 02:00:00") in minutes, or null. */
export function intervalMinutes(text) {
  const m = /^(?:(\d+) days? ?)?(\d+):(\d{2}):(\d{2})$/.exec(String(text ?? '').trim())
  return m ? Number(m[1] || 0) * 1440 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60 : null
}

/**
 * The block width a read came back in, in minutes: `asked` unless the rows say another. A window
 * older than the 5-minute device rollup reaches is read in hours (telemetry_coverage(), 0245).
 */
export function readWidth(rows, asked) {
  const width = intervalMinutes(rows[0]?.block_width)
  return width && width > 0 ? width : asked
}

/** A coverage bound as milliseconds: an instant, or -Infinity and Infinity for PostgreSQL's infinities. */
export function coverageTime(value) {
  if (value === '-infinity') return -Infinity
  if (value === 'infinity') return Infinity
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The coverage read's rows as the page draws them: a Map of each key in `keys` to its counts, all
 * 0 where no row came back, and what the rollup has counted, `{ from, to, complete }` in ms (the
 * narrowest across the parts read).
 */
export function coverageCounts(rows, keys, length) {
  const counts = new Map(keys.map(k => [k, new Array(length).fill(0)]))
  let from = -Infinity
  let to = Infinity
  let complete = true
  for (const r of rows) {
    if (counts.has(r.asset_id) && Array.isArray(r.counts)) counts.set(r.asset_id, r.counts.slice(0, length).concat(new Array(Math.max(0, length - r.counts.length)).fill(0)))
    const f = coverageTime(r.computed_from)
    const t = coverageTime(r.computed_to)
    if (f !== null) from = Math.max(from, f)
    if (t !== null) to = Math.min(to, t)
    if (r.complete === false) complete = false
  }
  return { counts, counted: { from, to, complete } }
}

/**
 * The stretches of [start, end) the rollup has not counted, as fractions: before `counted.from`,
 * and from `counted.to` up to now (a stretch after now is the future, hatched as such). Each
 * `{ lo, hi }`; none when the whole window is counted.
 */
export function uncountedStretches(counted, { start, end, now }) {
  const span = end - start
  const f = (ms) => Math.min(1, Math.max(0, (ms - start) / span))
  const out = []
  if (counted.from > start) out.push({ lo: 0, hi: f(counted.from) })
  const reach = Math.min(end, now)
  if (counted.to < reach) out.push({ lo: f(Math.max(counted.to, start)), hi: f(reach) })
  return out.filter(s => s.hi > s.lo)
}

/**
 * The note above the lanes when part of the window is older than the rollup has counted: "Coverage
 * before 3 Oct is still being computed" while the backfill runs, "Coverage is kept from 3 Oct" once it
 * has reached the oldest readings counted. Null when the window starts inside what is counted.
 */
export function uncountedWords(counted, startMs) {
  if (!(counted.from > startMs)) return null
  const day = new Date(counted.from).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return counted.complete ? `Coverage is kept from ${day}` : `Coverage before ${day} is still being computed`
}

/** A block width in words: "5-minute blocks", "1-hour blocks", "2-day blocks". */
export function blockWords(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080}-week blocks`
  if (minutes % 1440 === 0) return `${minutes / 1440}-day blocks`
  if (minutes % 60 === 0) return `${minutes / 60}-hour blocks`
  return `${minutes}-minute blocks`
}

/** The groups that are lanes of their own on the Site Map, in its order, keyed by location source. */
const OVERVIEW_LANES = [
  { key: SOURCE_SITE_WIDE, label: 'Site-Wide' },
  { key: SOURCE_SIMULATED, label: 'Simulated' },
  { key: SOURCE_UNASSIGNED, label: 'Unassigned' },
]

/** The group of cells filed in no area, named as the Site Map's tray is. */
export const UNFILED_GROUP = 'Unfiled — in no area yet'

/** An area's group of the devices that serve the whole area. */
export const AREA_WIDE_GROUP = 'Area-Wide'

const nameOf = (row, own) => String(row[own] ?? row.name ?? '')
const inNameOrder = (own) => (a, b) => nameOf(a, own).localeCompare(nameOf(b, own))

/**
 * The Overview's groups, each device where the Site Map places it: every area in service, in name
 * order, holding a group for each of its cells in service and one for its Area-Wide devices; the
 * cells in no area under UNFILED_GROUP; then Site-Wide, Simulated and Unassigned. Only devices in
 * service are placed (inServiceDevices()), and a group with none is left out. Each is
 * `{ key, label, devices, groups? }`, an area's `devices` being all its groups', in name order.
 */
export function overviewGroups(devices, cells = [], areas = []) {
  const live = inServiceDevices(devices).slice().sort(inNameOrder('asset_name'))
  const byCell = groupDevicesByCell(live)
  const liveCells = cells.filter(c => !c.is_archived).slice().sort(inNameOrder('cell_name'))
  const cellGroup = (c) => {
    const id = c.cell_id ?? c.id
    return { key: `cell:${id}`, label: nameOf(c, 'cell_name'), devices: byCell.get(id) || [] }
  }
  const filled = (groups) => groups.filter(g => g.devices.length > 0)
  const parent = (key, label, groups) => ({ key, label, devices: groups.flatMap(g => g.devices), groups })

  const out = []
  for (const area of areas.filter(a => !a.is_archived).slice().sort(inNameOrder('area_name'))) {
    const id = area.area_id ?? area.id
    const groups = filled([
      ...liveCells.filter(c => c.area_id === id).map(cellGroup),
      { key: `area-wide:${id}`, label: AREA_WIDE_GROUP, devices: areaWideInService(id, live, []).devices },
    ])
    if (groups.length) out.push(parent(`area:${id}`, nameOf(area, 'area_name'), groups))
  }
  const unfiled = filled(liveCells.filter(c => !c.area_id).map(cellGroup))
  if (unfiled.length) out.push(parent('unfiled', UNFILED_GROUP, unfiled))
  for (const lane of OVERVIEW_LANES) {
    const laneDevices = live.filter(d => d.location_source === lane.key)
    if (laneDevices.length) out.push({ key: lane.key, label: lane.label, devices: laneDevices })
  }
  return out
}

/** Every group's key, each area's groups after it. */
export const groupKeys = (groups) => groups.flatMap(g => [g.key, ...(g.groups || []).map(s => s.key)])

/** The most lanes Overview opens on a first visit. Past it, every group starts closed. */
export const OVERVIEW_OPEN_LANES_MAX = 200

/**
 * Which groups this browser's viewer opened or closed on Overview, `{ key: open }`. Not in the
 * address: a shared link opens as a first visit does.
 */
export const OVERVIEW_GROUPS_KEY = 'aber_history_overview_groups'

/** The viewer's choices, or none where storage is refused or holds something else. */
export function readOverviewGroups() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(OVERVIEW_GROUPS_KEY) || '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter(([, open]) => typeof open === 'boolean'))
  } catch {
    return {}
  }
}

export function writeOverviewGroups(choices) {
  try {
    if (Object.keys(choices).length) window.localStorage.setItem(OVERVIEW_GROUPS_KEY, JSON.stringify(choices))
    else window.localStorage.removeItem(OVERVIEW_GROUPS_KEY)
  } catch {
    // Refused storage: the groups open as on a first visit.
  }
}

/**
 * Whether a group is open: as its viewer last left it, else open while the page would draw at most
 * OVERVIEW_OPEN_LANES_MAX lanes (`lanes`, one a device) with every group open.
 */
export const groupIsOpen = (key, choices, lanes) =>
  (typeof choices[key] === 'boolean' ? choices[key] : lanes <= OVERVIEW_OPEN_LANES_MAX)

/** A device's telemetry key, which the coverage read names it by: its issued Sparkplug id. */
export const telemetryKey = (device) => deviceIds(device).issued

/** Several strips' counts as one: their sum in each block. */
export function mergeCounts(lists, length) {
  const out = new Array(length).fill(0)
  for (const counts of lists) counts?.forEach((n, i) => { out[i] += n })
  return out
}

/** How many shades a strip steps through, lightest to darkest; a block with none takes no shade. */
export const COVERAGE_STEPS = 4

/** Each block's shade: 0 for none, else 1 to `steps` by its count against the strip's busiest block. */
export function coverageSteps(counts, steps = COVERAGE_STEPS) {
  const most = counts.reduce((m, n) => Math.max(m, n), 0)
  return counts.map(n => (n > 0 ? Math.max(1, Math.ceil((n / most) * steps)) : 0))
}

/** A strip's shades as runs of one shade, `[{ from, to, step }]` by block index, `to` exclusive; none for 0. */
export function coverageRuns(steps) {
  const runs = []
  steps.forEach((step, i) => {
    const run = runs[runs.length - 1]
    if (run && run.step === step && run.to === i) run.to = i + 1
    else if (step > 0) runs.push({ from: i, to: i + 1, step })
  })
  return runs
}

/** The key's words: each end of the shades, a block with none, and a block the rollups have not counted yet. */
export const COVERAGE_KEY = Object.freeze({
  fewer: 'Fewer readings', more: 'More readings', none: 'No readings', uncounted: 'Not counted yet',
})

/**
 * Where a strip's readings stop inside the window: "No readings since 15:00" once a whole block has
 * passed with none after the last that had some, the moment that block's start, with its date when
 * it is not today. "No readings in this window" when none came and all of it so far is counted.
 * Only what the rollup has counted (`counted`, coverageCounts()) is read: a block after it is not
 * counted yet, never empty. Null otherwise.
 */
export function readingsStopWords(counts, starts, minutes, { start, end, now, counted = { from: -Infinity, to: Infinity } }) {
  const width = minutes * MINUTE
  const reach = Math.min(end, now, counted.to)
  if (!(reach > start)) return null
  let last = counts.length - 1
  while (last >= 0 && !(counts[last] > 0)) last--
  if (last < 0) return counted.from > start ? null : 'No readings in this window'
  const stop = starts[last] * 1000 + width
  if (stop + width > reach) return null
  const at = new Date(stop)
  return `No readings since ${localDay(at) === localDay(new Date(now)) ? clockWords(at) : momentWords(stop, 1)}`
}

/**
 * A block under the pointer in words, as the Audit Trail names a marker: its stretch, then how many
 * readings arrived, "No readings", "Not counted yet" where the rollups have not reached it, or "No
 * readings yet" after now: "10:05–10:10 · 412 readings". The day goes first on a window longer
 * than one, and a block a day or longer is its day.
 */
export function blockReadoutWords(startMs, minutes, n, { spanMs = 0, counted = { from: -Infinity, to: Infinity }, now = Date.now() } = {}) {
  const endMs = startMs + minutes * MINUTE
  const stretch = minutes >= 1440
    ? momentWords(startMs, 1440)
    : `${spanMs > DAY ? momentWords(startMs, 1) : clockWords(new Date(startMs))}–${clockWords(new Date(endMs))}`
  const what = n > 0 ? `${n.toLocaleString()} ${n === 1 ? 'reading' : 'readings'}`
    : startMs >= now ? 'No readings yet'
      : startMs < counted.from || endMs > counted.to ? 'Not counted yet'
        : COVERAGE_KEY.none
  return `${stretch} · ${what}`
}

/** A strip's text for a screen reader: how many of its blocks had readings, and where they stop. */
export function coverageSummary(name, counts, stopWords) {
  const had = counts.filter(n => n > 0).length
  return `${name}: readings in ${had} of ${counts.length} blocks.${stopWords ? ` ${stopWords}.` : ''}`
}

/** A selection box's size in words: "3 devices · 10:05 – 14:20, 4 h 15 min" (bandWords()). */
export const boxWords = (count, start, end, now = Date.now()) =>
  `${count} ${count === 1 ? 'device' : 'devices'} · ${bandWords(start, end, now)}`

/**
 * The Overview's time axis: a calendar window's own ticks (calendarTicks()), else five evenly
 * spaced, labelled with the clock (to the second under an hour) inside a day, the date and clock up
 * to three days, and the date beyond, as the Audit Trail's axis is. Each `{ f, label }`, `f` a
 * fraction of [start, end].
 */
export function axisTicks(win, startMs, endMs) {
  const span = endMs - startMs
  if (!(span > 0)) return []
  if (win?.kind === 'calendar') {
    return calendarTicks(win.span, new Date(startMs), new Date(endMs))
      .map(({ at, label }) => ({ f: (at.getTime() - startMs) / span, label }))
      .filter(t => t.f >= 0 && t.f <= 1)
  }
  const label = (d) => (span < HOUR
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : span <= DAY ? clockWords(d) : momentWords(d.getTime(), span <= 3 * DAY ? 1 : 1440))
  return [0, 0.25, 0.5, 0.75, 1].map(f => ({ f, label: label(new Date(startMs + span * f)) }))
}

// ------------------------------------------------------------------------------------------------
// The Cell tab: one metric across a cell's machines, on one scale, and by the hour of the day
// ------------------------------------------------------------------------------------------------

/** The Cell tab's id among History's tabs, and its path: `/history/cell` picks a cell. */
export const CELL_TAB = 'cell'
export const CELL_PATH = '/history/cell'

/** The path of one cell's tab, the picker's when `cellId` is empty. */
export const cellHistoryPath = (cellId) => (cellId ? `${CELL_PATH}/${encodeURIComponent(cellId)}` : CELL_PATH)

/** The cell a path's segments name, `/history/cell/<id>`; empty for the picker and for any other path. */
export function cellIdFrom(segments) {
  const [, tab, id] = segments
  if (tab !== CELL_TAB || !id) return ''
  try { return decodeURIComponent(id) } catch { return '' }
}

/** The address of a cell's tab at window `win`, with the metric chosen when there is one. */
export function cellAddress(cellId, win, { metric = '' } = {}) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(windowToQuery(win, DEFAULT_HISTORY_WINDOW))) if (v) query.set(k, v)
  if (metric) query.set('metric', metric)
  const q = query.toString()
  return `${cellHistoryPath(cellId)}${q ? `?${q}` : ''}`
}

/**
 * The cells the Cell tab offers, archived ones too as the device picker offers archived devices, each as
 * `{ cell_id, name, area_name, is_archived, machines }`, `machines` being its devices in service, in name order.
 */
export function historyCells(cells, devices, areas = []) {
  const byCell = groupDevicesByCell(inServiceDevices(devices))
  const areaName = new Map(areas.map(a => [a.area_id ?? a.id, a.area_name ?? a.name]))
  return (cells || [])
    .map(c => {
      const id = c.cell_id ?? c.id
      return {
        cell_id: id, name: String(c.cell_name ?? c.name ?? ''), area_id: c.area_id ?? null, area_name: areaName.get(c.area_id) ?? null,
        is_archived: Boolean(c.is_archived), machines: byCell.get(id) || [],
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Each metric the cell's machines report, as `{ name, count }`, `count` being how many do, in name
 * order. A machine reports a metric when its last birth declared it or a schema of it models it
 * (deviceMetrics()).
 */
export function cellMetrics(machines, schemas, catalog = null) {
  const counts = new Map()
  for (const d of machines) for (const m of deviceMetrics(d, schemas, catalog)) counts.set(m, (counts.get(m) || 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The metric the tab opens on: the one most machines report, the first by name among equals. A
 * measured metric is preferred to a derived one (`derived: true` on the entry), which has no hour-of-day
 * grid and no export: a tab opens on one only when the machines report nothing else.
 */
export function defaultCellMetric(metrics) {
  const measured = metrics.filter(m => !m.derived)
  return (measured.length ? measured : metrics).reduce((best, m) => (!best || m.count > best.count ? m : best), null)?.name ?? ''
}

/** What a shared scale adds above and below the data, as a fraction of its span. */
const SCALE_PAD = 0.08

/**
 * One y scale for every number series in `list`: the lowest minimum to the highest maximum across
 * all of them, padded so a line does not run along an edge. Null when none holds a number, and uPlot
 * then scales a chart by itself. A flat metric is padded by a tenth of its value, or 1.
 */
export function sharedScale(list) {
  let low = Infinity
  let high = -Infinity
  for (const s of list) {
    if (s?.kind !== 'number') continue
    for (const v of s.min) if (isValue(v) && v < low) low = v
    for (const v of s.max) if (isValue(v) && v > high) high = v
  }
  if (!(low <= high)) return null
  const pad = high > low ? (high - low) * SCALE_PAD : Math.max(Math.abs(high) * 0.1, 1)
  return [low - pad, high + pad]
}

/** The words for a machine that does not report the metric chosen. */
export const silentWords = (name, metric) => `${name} does not report ${metric}.`

/**
 * The status line of the machines' charts: how many are charted, in which buckets, how many do not
 * report the metric, how many parts the read took, and what the text and flag charts show. `noun`
 * is what a chart is of: the Metric tab's are devices.
 */
export function multiplesWords({ shown, silent, resolution, reads = 1, stateLine = null, noun = 'machine' }) {
  const count = `${shown} ${shown === 1 ? noun : `${noun}s`}`
  const apart = silent ? `, ${silent} ${silent === 1 ? 'does' : 'do'} not report it` : ''
  const parts = reads > 1 ? `, read in ${reads} parts` : ''
  return `${count}, in ${resolution.words}${apart}${parts}${stateLine ? `; ${stateLine}` : ''}`
}

// ------------------------------------------------------------------------------------------------
// Derived metrics: computed from the minutes (derived_series(), 0282)
// ------------------------------------------------------------------------------------------------

/**
 * Why `devices` devices of the derived metrics `names` cannot be read over [startMs, endMs) at
 * `minutes`-minute buckets, or null. A derived series is read from the minutes at every bucket width, so
 * what it costs is the window and the devices, not the bucket: past DERIVED_MAX_MINUTES minutes of input
 * (devices times inputs times the window's minutes) the database refuses it before reading anything.
 */
export function derivedReadProblem(startMs, endMs, minutes, devices, names, catalog) {
  const inputs = derivedInputCount(names, catalog)
  if (!inputs || !devices) return null
  const window = bucketCount(startMs, endMs, minutes) * minutes
  if (devices * inputs * window <= DERIVED_MAX_MINUTES) return null
  return `A derived metric is computed from the minutes, and this window has too many of them for ${devices === 1 ? 'it' : `${devices.toLocaleString()} devices`}. Choose a shorter window${devices === 1 ? '' : ' or fewer devices'}.`
}

/**
 * Each group's rows of derived_series() folded as telemetry_carried_by_group() folds them, so
 * groupSeries() draws both: the mean of the group's devices that have a value in a bucket, their total
 * only where EVERY device of the group has one, and how many had a reading and not a carried value.
 * `groups` are `{ key, keys }`, `keys` being the group's devices as they were asked for; `rows` carry
 * the device in `asset_id`. Rows come back in the shape that function returns, in bucket order.
 */
export function foldByGroup(rows, groups) {
  const groupOf = new Map()
  for (const g of groups) for (const k of g.keys) groupOf.set(k, g.key)
  const sizes = new Map(groups.map(g => [g.key, g.keys.length]))
  const cells = new Map()
  for (const r of rows) {
    const key = groupOf.get(r.asset_id)
    if (key === undefined || r.avg_double === null || r.avg_double === undefined) continue
    const id = `${key}\n${r.bucket_ts}`
    if (!cells.has(id)) cells.set(id, { group_key: key, bucket_ts: r.bucket_ts, sum: 0, with_value: 0, measured: 0 })
    const c = cells.get(id)
    c.sum += r.avg_double
    c.with_value += 1
    if (!r.is_carried) c.measured += 1
  }
  return [...cells.values()]
    .sort((a, b) => (a.group_key < b.group_key ? -1 : a.group_key > b.group_key ? 1 : Date.parse(a.bucket_ts) - Date.parse(b.bucket_ts)))
    .map(c => ({
      group_key: c.group_key,
      bucket_ts: c.bucket_ts,
      mean_double: c.sum / c.with_value,
      total_double: c.with_value === sizes.get(c.group_key) ? c.sum : null,
      members: sizes.get(c.group_key),
      with_value: c.with_value,
      measured: c.measured,
    }))
}

// ------------------------------------------------------------------------------------------------
// The hour-of-day heatmap: a row a machine, a column an hour, coloured by the mean at that hour
// ------------------------------------------------------------------------------------------------

/** The hours of the day, the heatmap's columns. */
export const HOURS_OF_DAY = Object.freeze(Array.from({ length: 24 }, (_, h) => h))

/** The browser's time zone, an IANA name, which the hours are read in; UTC where it cannot say. */
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/**
 * Whether telemetry_hour_of_day() will read `machines` over [start, end): one hourly bucket for each
 * hour for each machine, at most HOUR_OF_DAY_MAX_ROWS. Otherwise `problem`, in words, naming the
 * longest window those machines allow.
 */
export function hourOfDayPlan(startMs, endMs, machines) {
  const hours = bucketCount(startMs, endMs, 60)
  if (machines < 1 || hours * machines <= HOUR_OF_DAY_MAX_ROWS) return { hours }
  const longest = Math.floor(HOUR_OF_DAY_MAX_ROWS / machines / 24)
  const problem = longest >= 1
    ? `The heatmap reads every hour of the window for each machine, so for ${machines} machines it covers at most ${longest} ${longest === 1 ? 'day' : 'days'}. Choose a shorter window.`
    : `${machines} machines are too many for the heatmap. It reads every hour of the window for each machine.`
  return { hours, problem }
}

/** An hour as the heatmap names it: "14:00–15:00", the day's last "23:00–00:00". */
export const hourWords = (hour) => `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`

/** How many shades the heatmap steps through: Overview's ramp, lightest to darkest. */
export const HEAT_STEPS = COVERAGE_STEPS

/**
 * The rows of telemetry_hour_of_day() laid on the machines asked for: a Map of each key in `keys`
 * to its 24 hours, each `{ value, days }` or null where the hour has no value, and the lowest and
 * highest value across every machine, null with none. One scale across all of them, so an outlier
 * shows against the others.
 */
export function hourGrid(rows, keys) {
  const cells = new Map(keys.map(k => [k, new Array(24).fill(null)]))
  let low = Infinity
  let high = -Infinity
  for (const r of rows) {
    const row = cells.get(r.asset_id)
    const hour = Number(r.hour_of_day)
    const value = Number(r.mean_value)
    if (!row || !Number.isInteger(hour) || hour < 0 || hour > 23 || !isValue(r.mean_value) || !Number.isFinite(value)) continue
    row[hour] = { value, days: Number(r.days) || 0 }
    low = Math.min(low, value)
    high = Math.max(high, value)
  }
  return { cells, low: low === Infinity ? null : low, high: high === -Infinity ? null : high }
}

/** The shade of `value` between `low` and `high`: 1 to `steps`, in equal widths; the first when they are level. */
export function heatStep(value, low, high, steps = HEAT_STEPS) {
  if (!(high > low)) return 1
  return Math.min(steps, 1 + Math.floor(((value - low) / (high - low)) * steps))
}

/** The values each shade stands for, lowest first: `{ step, from, to }`; one band when they are level. */
export function heatBands(low, high, steps = HEAT_STEPS) {
  if (low === null || high === null) return []
  if (!(high > low)) return [{ step: 1, from: low, to: high }]
  const width = (high - low) / steps
  return Array.from({ length: steps }, (_, i) => ({ step: i + 1, from: low + width * i, to: i + 1 === steps ? high : low + width * (i + 1) }))
}

/** A band in words: "21.3 to 28.1 kW", or its one value when the band is level. */
export const bandRangeWords = (band, unit) =>
  (band.from === band.to ? readingWords(band.from, unit) : `${readingWords(band.from)} to ${readingWords(band.to, unit)}`)

/**
 * A cell of the heatmap in words: "Lathe 3 · 14:00–15:00 · 21.3 kW, the mean of 7 days". An hour
 * with no value says so. A cell of the Area tab's heatmap is of several machines (`machines`), and says
 * how many: "the mean of 7 days, across 5 machines".
 */
export function heatCellWords(name, hour, cell, unit) {
  const head = `${name} · ${hourWords(hour)}`
  if (!cell) return `${head} · No value in this window`
  const across = cell.machines > 1 ? `, across ${cell.machines} machines` : ''
  return `${head} · ${readingWords(cell.value, unit)}, the mean of ${cell.days} ${cell.days === 1 ? 'day' : 'days'}${across}`
}

// ------------------------------------------------------------------------------------------------
// The Metric tab: one metric across every device that reports it
// ------------------------------------------------------------------------------------------------

/** The Metric tab's id among History's tabs, and its path: `/history/metric` picks a metric. */
export const METRIC_TAB = 'metric'
export const METRIC_PATH = '/history/metric'

/** The path of one metric's tab, the picker's when `name` is empty. A name holds slashes, so it is one encoded segment. */
export const metricHistoryPath = (name) => (name ? `${METRIC_PATH}/${encodeURIComponent(name)}` : METRIC_PATH)

/** The metric a path's segments name, `/history/metric/<name>`; empty for the picker and for any other path. */
export function metricNameFrom(segments) {
  const [, tab, name] = segments
  if (tab !== METRIC_TAB || !name) return ''
  try { return decodeURIComponent(name) } catch { return '' }
}

/** The window's keys as a query, for an address that adds its own. */
function windowQuery(win) {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(windowToQuery(win, DEFAULT_HISTORY_WINDOW))) if (v) query.set(k, v)
  return query
}

/** A query as an address's tail, its lists written with their commas. */
const queryTail = (query) => {
  const q = query.toString().replace(/%2C/gi, ',')
  return q ? `?${q}` : ''
}

/**
 * The address of a metric's tab at window `win`: the devices narrowed by area (`area`) and cell
 * (`cell`), by ids, and to a list of telemetry keys (`devices`), and the page when it is not the
 * first. The picker's when `name` is empty.
 */
export function metricAddress(name, win, { areas = [], cells = [], devices = [], page = 1 } = {}) {
  const query = windowQuery(win)
  if (areas.length) query.set('area', encodeList(areas))
  if (cells.length) query.set('cell', encodeList(cells))
  if (devices.length) query.set('devices', encodeList(devices))
  if (page > 1) query.set('page', String(page))
  return `${metricHistoryPath(name)}${queryTail(query)}`
}

/**
 * Each metric some device in service reports, as `{ name, count, unit, kind }`, `count` being how many
 * devices do, in name order: cellMetrics() over every device in service, with the catalog's unit and
 * kind (datatypeKind()), both null for a metric the catalog does not know.
 */
export function historyMetrics(devices, schemas, catalog) {
  const meta = new Map((catalog || []).map(m => [m.name, m]))
  return cellMetrics(inServiceDevices(devices), schemas, catalog).map(m => ({
    ...m, unit: meta.get(m.name)?.units ?? null, kind: datatypeKind(meta.get(m.name)?.datatype), ...(meta.get(m.name)?.derivation ? { derived: true } : {}),
  }))
}

/**
 * The devices in service that report `metric` (deviceMetrics()), narrowed to those in one of `areas`
 * and in one of `cells` (ids) and named in `keys` (telemetry keys), where each is given; in the
 * order given. With the `catalog`, a derived metric is reported by the devices that report all its
 * inputs.
 */
export function metricDevices(devices, schemas, metric, { areas = [], cells = [], keys = [], catalog = null } = {}) {
  return inServiceDevices(devices).filter(d =>
    deviceMetrics(d, schemas, catalog).includes(metric)
    && (areas.length === 0 || areas.includes(d.area_id))
    && (cells.length === 0 || cells.includes(d.cell_id))
    && (keys.length === 0 || keys.includes(telemetryKey(d))))
}

/** The most devices the Metric tab draws on one page when the row cap lets one read carry them all. */
export const METRIC_DRAW_MAX = 200

/**
 * How many devices a page holds once the Metric tab pages. Twelve at the coarsest resolution, a day,
 * are 4,400 rows over a Year, inside HISTORY_MAX_ROWS, so a page is one read for any window up to
 * 416 days.
 */
export const METRIC_PAGE_SIZE = 12

/**
 * The Metric tab's pages for `count` devices over [start, end). One page of everything while one read
 * carries every device at some resolution (pickResolution()) and there are at most METRIC_DRAW_MAX of
 * them. Past that, pages of METRIC_PAGE_SIZE, each read apart at the finest resolution its own devices
 * fit. `page` is clamped into the pages there are; `from` and `to` slice the devices; `resolution` is
 * pickResolution() for the page, null when even one device does not fit at the coarsest.
 */
export function metricPages(startMs, endMs, count, page = 1, { size = METRIC_PAGE_SIZE, drawMax = METRIC_DRAW_MAX } = {}) {
  const whole = pickResolution(startMs, endMs, count)
  if (count <= drawMax && whole && whole.perRead >= count) {
    return { paged: false, page: 1, pages: 1, from: 0, to: count, size: count, resolution: whole }
  }
  const pages = Math.max(1, Math.ceil(count / size))
  const at = Math.min(pages, Math.max(1, Math.trunc(page) || 1))
  const from = (at - 1) * size
  const to = Math.min(count, at * size)
  return { paged: true, page: at, pages, from, to, size, resolution: pickResolution(startMs, endMs, Math.max(1, to - from)) }
}

/** The page the address names: a whole number above 1, else 1. */
export const pageFrom = (raw) => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 1 ? n : 1
}

/** Why the devices come a page at a time, and which. */
export const pagingWords = ({ total, from, to, size }) =>
  `${total.toLocaleString()} devices are too many to chart at once, so they come ${size} to a page: devices ${from + 1} to ${to}.`

/**
 * The Overview box's Chart for `picked` devices at window `win`: the Device tab for one, else the Metric
 * tab narrowed to them, on the metric most of them report (defaultCellMetric()); the picker, narrowed,
 * when none reports any.
 */
export function chartAddress(picked, schemas, win) {
  if (picked.length === 1) return pickedAddress(telemetryKey(picked[0]), win)
  const metric = defaultCellMetric(cellMetrics(picked, schemas))
  return metricAddress(metric, win, { devices: picked.map(telemetryKey) })
}

// ------------------------------------------------------------------------------------------------
// The Area tab: one metric across the cells of an area, a mean or a total a cell
// ------------------------------------------------------------------------------------------------

/** The Area tab's id among History's tabs, and its path: `/history/area` picks an area. */
export const AREA_TAB = 'area'
export const AREA_PATH = '/history/area'

/** The path of one area's tab, the picker's when `areaId` is empty. */
export const areaHistoryPath = (areaId) => (areaId ? `${AREA_PATH}/${encodeURIComponent(areaId)}` : AREA_PATH)

/** The area a path's segments name, `/history/area/<id>`; empty for the picker and for any other path. */
export function areaIdFrom(segments) {
  const [, tab, id] = segments
  if (tab !== AREA_TAB || !id) return ''
  try { return decodeURIComponent(id) } catch { return '' }
}

/** What each cell's chart is: the mean across its machines, or their total. The first is the default. */
export const AGG_MODES = Object.freeze(['mean', 'total'])
export const DEFAULT_AGG = 'mean'

/** The address of an area's tab at window `win`, with the metric chosen and the total when it is not the mean. */
export function areaAddress(areaId, win, { metric = '', agg = DEFAULT_AGG } = {}) {
  const query = windowQuery(win)
  if (metric) query.set('metric', metric)
  if (agg !== DEFAULT_AGG) query.set('agg', agg)
  return `${areaHistoryPath(areaId)}${queryTail(query)}`
}

/**
 * The areas the Area tab offers, archived ones too, as `{ area_id, name, is_archived, cells, machines }`:
 * `cells` its cells in service as historyCells() gives them, `machines` all their machines. A device
 * Area-Wide in the area belongs to no cell, so it is in neither.
 */
export function historyAreas(areas, cells) {
  return (areas || [])
    .map(a => {
      const id = a.area_id ?? a.id
      const own = cells.filter(c => c.area_id === id && !c.is_archived)
      return {
        area_id: id, name: String(a.area_name ?? a.name ?? ''), is_archived: Boolean(a.is_archived),
        cells: own, machines: own.flatMap(c => c.machines),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The finest resolution at which an area's cells can be read: its `devices` fit telemetry_carried()'s
 * bound (HISTORY_GROUP_READ_ROWS, which the function reads them under) and its `groups`, the rows
 * returned, fit the row cap. Null when not even a day does.
 */
export function pickGroupResolution(startMs, endMs, devices, groups, {
  resolutions = HISTORY_RESOLUTIONS, maxRows = HISTORY_MAX_ROWS, readRows = HISTORY_GROUP_READ_ROWS,
} = {}) {
  for (const r of resolutions) {
    const buckets = bucketCount(startMs, endMs, r.minutes)
    if (buckets * Math.max(1, groups) <= maxRows && buckets * Math.max(1, devices) <= readRows) return r
  }
  return null
}

/**
 * One cell's rows of telemetry_carried_by_group() laid on `starts` as a number series, for its
 * `agg`: the mean, or the total, which the function withholds (null) for a bucket in which a machine
 * had no value. `withheld` is true for each such bucket, and a bucket with no row at all is empty.
 * A bucket is carried when no machine had a reading in it. A line only: its minimum and maximum are
 * its value.
 */
export function groupSeries(rows, starts, agg) {
  const at = new Map(rows.map(r => [Math.round(Date.parse(r.bucket_ts) / 1000), r]))
  const series = { kind: 'none', avg: [], min: [], max: [], carried: [], states: [], last: [], withheld: [] }
  for (const x of starts) {
    const r = at.get(x)
    const v = !r ? null : (agg === 'total' ? r.total_double : r.mean_double) ?? null
    series.avg.push(v)
    series.min.push(v)
    series.max.push(v)
    series.last.push(v)
    series.states.push(null)
    series.carried.push(Boolean(r) && r.measured === 0)
    series.withheld.push(agg === 'total' && Boolean(r) && v === null)
  }
  if (series.avg.some(isValue)) series.kind = 'number'
  return series
}

/** The stretches of `withheld` flags that are true, as `{ from, to }` indexes, `to` exclusive. */
export function withheldRuns(withheld) {
  const runs = []
  withheld.forEach((w, i) => {
    const last = runs[runs.length - 1]
    if (w && last && last.to === i) last.to = i + 1
    else if (w) runs.push({ from: i, to: i + 1 })
  })
  return runs
}

/**
 * Where a cell's total was withheld, in words: "withheld from 2 Nov 10:05 to 10:35, where a machine
 * had no value", or how many stretches there are and the first. Null where it was not.
 */
export function withheldWords(withheld, starts, minutes) {
  const runs = withheldRuns(withheld)
  if (!runs.length) return null
  const stretch = (r) => {
    const from = starts[r.from] * 1000
    const to = starts[r.to - 1] * 1000 + minutes * MINUTE
    const sameDay = new Date(from).toDateString() === new Date(to).toDateString()
    return `from ${momentWords(from, minutes)} to ${minutes < 1440 && sameDay ? clockWords(new Date(to)) : momentWords(to, minutes)}`
  }
  const [first] = runs
  return runs.length === 1
    ? `withheld ${stretch(first)}, where a machine had no value`
    : `withheld in ${runs.length} stretches, the first ${stretch(first)}, where a machine had no value`
}

/** The words for a cell none of whose machines reports the metric chosen. */
export const silentCellWords = (name, metric) => `None of the machines in ${name} reports ${metric}.`

/**
 * The status line of the cells' charts: how many cells are charted, what each is, in which buckets,
 * how many report nothing of the metric, and the devices that sit in no cell.
 */
export function cellsWords({ shown, silent, agg, resolution, areaWide = 0 }) {
  const count = `${shown} ${shown === 1 ? 'cell' : 'cells'}`
  const what = agg === 'total' ? 'each the total of its machines, withheld where one has no value' : 'each the mean of its machines that have a value'
  const apart = silent ? `, ${silent} ${silent === 1 ? 'does' : 'do'} not report it` : ''
  const loose = areaWide ? `; ${areaWide} ${areaWide === 1 ? 'device is' : 'devices are'} Area-Wide, in no cell, so not charted` : ''
  return `${count}, ${what}, in ${resolution.words}${apart}${loose}`
}

/**
 * The heatmap's grid for an area: a row a cell, the mean of the cell's machines at each hour, from
 * the machines' own (hourGrid()). `cells` are `{ key, keys }`, `keys` being the machines of the cell
 * the grid was read for. A cell hour is the mean of the machines that have a value in it, `machines`
 * how many, and `days` the most any of them spans. A cell no machine has a value for has no row.
 * Same shape as hourGrid(): one scale across every cell.
 */
export function cellHourGrid(grid, cells) {
  const out = new Map()
  let low = Infinity
  let high = -Infinity
  for (const c of cells) {
    const hours = Array.from({ length: 24 }, (_, h) => {
      const have = c.keys.map(k => grid.cells.get(k)?.[h]).filter(Boolean)
      if (!have.length) return null
      const value = have.reduce((sum, v) => sum + v.value, 0) / have.length
      low = Math.min(low, value)
      high = Math.max(high, value)
      return { value, days: Math.max(...have.map(v => v.days)), machines: have.length }
    })
    if (hours.some(Boolean)) out.set(c.key, hours)
  }
  return { cells: out, low: low === Infinity ? null : low, high: high === -Infinity ? null : high }
}
