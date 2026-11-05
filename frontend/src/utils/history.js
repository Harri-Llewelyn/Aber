/**
 * The History page's arithmetic: the window it opens on, the resolution the row cap picks or the
 * one chosen, its address, a chart's buckets and series, and the words a chart says. Pure, so each
 * rule is unit-tested; frontend/README.md, "History and its chart".
 */
import {
  COVERAGE_LARGE_MAX_HOURS, COVERAGE_MAX_DEVICES, COVERAGE_ROLLUP_MINUTES, COVERAGE_SMALL_SELECTION, HISTORY_MAX_ROWS,
  HISTORY_RESOLUTIONS,
} from '../api'
import { encodeList } from '../hooks/useUrlState'
import { modelledMetricsAcross, schemasForDevice } from './deviceTags'
import { datatypeLabel } from './sparkplugDatatype'
import { modelledConstraints } from './payloadConformance'
import { deviceIdentifiers, deviceIds } from './sparkplugId'
import { SOURCE_SIMULATED, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED, groupDevicesByCell } from './cellResolution'
import { areaWideInService, inServiceDevices } from './inService'
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
 */
export function readPlan(startMs, endMs, { names, textNames = new Set(), bucket = 'auto', widthPx = DEFAULT_CHART_PX }) {
  const { resolution: chosen, refused } = resolutionFor(startMs, endMs, names.length, bucket)
  if (!chosen) return { problem: true, groups: [], refused: null }
  if (bucket !== 'auto' && !refused) return { groups: names.length ? [{ names, resolution: chosen }] : [], refused: null, chosen }
  const text = names.filter(n => textNames.has(n))
  const rest = names.filter(n => !textNames.has(n))
  const groups = []
  if (rest.length) groups.push({ names: rest, resolution: pickResolution(startMs, endMs, rest.length) })
  if (text.length) groups.push({ names: text, resolution: readableResolution(startMs, endMs, text.length, widthPx), text: true })
  if (groups.some(g => !g.resolution)) return { problem: true, groups: [], refused: null }
  return { groups, refused, chosen }
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
 * is approved. Each carries the names of the cell and area it sits in, and they are sorted by name.
 */
export function historyDevices(devices, cells, areas) {
  const cellById = new Map(cells.map(c => [c.cell_id ?? c.id, c]))
  const areaById = new Map(areas.map(a => [a.area_id ?? a.id, a]))
  return devices
    .filter(d => !d.is_quarantined)
    .map(d => {
      const cell = cellById.get(d.effective_cell_id) || null
      const area = areaById.get(d.effective_area_id ?? cell?.area_id) || null
      return { ...d, cell_name: cell?.name ?? null, area_name: area?.name ?? null }
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
 * name. A metric it stopped declaring is still charted while a schema models it.
 */
export function deviceMetrics(device, schemas) {
  const declared = Array.isArray(device?.last_birth_metrics) ? device.last_birth_metrics : []
  const modelled = modelledMetricsAcross(schemasForDevice(device, schemas)) || new Set()
  return [...new Set([...declared, ...modelled])].filter(Boolean).sort((a, b) => a.localeCompare(b))
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

/**
 * A run under the pointer in words: "2 Nov 10:05 – 10:40 · RUNNING, 35 min", and how much of it was
 * carried forward: all of it, or "20 min carried forward".
 */
export function runWords(run, minutes) {
  const sameDay = new Date(run.startMs).toDateString() === new Date(run.endMs).toDateString()
  const to = minutes < 1440 && sameDay ? clockWords(new Date(run.endMs)) : momentWords(run.endMs, minutes)
  const length = run.endMs - run.startMs
  const held = run.carried.reduce((a, c) => a + c.endMs - c.startMs, 0)
  const carried = held <= 0 ? '' : held >= length ? ', carried forward' : `, ${durationWords(held)} carried forward`
  return `${momentWords(run.startMs, minutes)} – ${to} · ${run.state}, ${durationWords(length)}${carried}`
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
export function chartSummary({ metric, unit, windowText, resolution, series, validRange, starts, span }) {
  const head = `${chartTitle(metric, unit)}, ${windowText}, in ${resolution.words}.`
  const shown = series.avg.map((v, i) => i).filter(i => series.avg[i] !== null)
  if (series.kind === 'none' || (series.kind !== 'state' && shown.length === 0)) {
    return `${head} No readings in this window, and none before it.`
  }
  const parts = [head]
  const word = (v) => valueWords(series.kind, v, unit)
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
 * telemetry_coverage() sums the widest rollup that divides it; under 5 minutes, telemetry_1m.
 */
export const COVERAGE_BLOCKS = Object.freeze([1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080])

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

/** A strip's text for a screen reader: how many of its blocks had readings, and where they stop. */
export function coverageSummary(name, counts, stopWords) {
  const had = counts.filter(n => n > 0).length
  return `${name}: readings in ${had} of ${counts.length} blocks.${stopWords ? ` ${stopWords}.` : ''}`
}

/** A selection box's size in words: "3 devices · 10:05 – 14:20, 4 h 15 min" (bandWords()). */
export const boxWords = (count, start, end, now = Date.now()) =>
  `${count} ${count === 1 ? 'device' : 'devices'} · ${bandWords(start, end, now)}`

/** Why Chart is off with several devices picked. */
export const CHART_SEVERAL_REASON = 'Pick one device to chart it. Charting several comes with the Metric tab.'

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
