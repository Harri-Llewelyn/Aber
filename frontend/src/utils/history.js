/**
 * The History page's arithmetic: the window it opens on, the resolution the row cap picks or the
 * one chosen, its address, a chart's buckets and series, and the words a chart says. Pure, so each
 * rule is unit-tested; frontend/README.md, "History and its chart".
 */
import { HISTORY_MAX_ROWS, HISTORY_RESOLUTIONS } from '../api'
import { encodeList } from '../hooks/useUrlState'
import { modelledMetricsAcross, schemasForDevice } from './deviceTags'
import { modelledConstraints } from './payloadConformance'
import { deviceIdentifiers } from './sparkplugId'
import { SPAN_IDS, TIME_PRESETS, clockWords, rollingWindow, windowToQuery } from './timeWindow'

const MINUTE = 60 * 1000

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

/** The narrowest a text chart's bucket is drawn under Auto, in pixels, so its words stay readable. */
export const TEXT_BUCKET_MIN_PX = 5

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
// The address: /history for the device picker, /history/device/<id> for one device's charts.
// ------------------------------------------------------------------------------------------------

/**
 * The tab and device a path's segments name. Device is the only tab, so any other path is its
 * picker; `/history/device/<id>` names a device by its UUID or Sparkplug id.
 */
export function historyPath(segments) {
  const [, tab, id] = segments
  let deviceId = ''
  if (tab === 'device' && id) {
    try { deviceId = decodeURIComponent(id) } catch { deviceId = '' }
  }
  return { tab: 'device', deviceId }
}

/** The path of one device's charts, the picker's when `deviceId` is empty. */
export const deviceHistoryPath = (deviceId) =>
  (deviceId ? `/history/device/${encodeURIComponent(deviceId)}` : '/history')

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
