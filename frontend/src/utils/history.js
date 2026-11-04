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
import { SPAN_IDS, TIME_PRESETS, rollingWindow, windowToQuery } from './timeWindow'

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
 * line can draw, keeps its text in `states`. `kind` is what the series holds: number, flag, state,
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
  const series = { kind, avg: [], min: [], max: [], carried: [], states: [] }
  for (const x of starts) {
    const r = at.get(x)
    series.avg.push(r ? pick.avg(r) : null)
    series.min.push(r ? pick.min(r) : null)
    series.max.push(r ? pick.max(r) : null)
    series.carried.push(r ? Boolean(r.is_carried) : false)
    series.states.push(r ? r.last_string ?? null : null)
  }
  return series
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

/** The chart's title: the metric's name, then its unit in brackets when it has one. */
export const chartTitle = (metric, unit) => (unit ? `${metric} (${unit})` : metric)

/**
 * The text a screen reader is given for a chart: the metric, the window, the resolution, the
 * latest value and the lowest and highest, how many buckets carried a value forward, and the valid
 * range where the schema declares one.
 */
export function chartSummary({ metric, unit, windowText, resolution, series, validRange }) {
  const head = `${chartTitle(metric, unit)}, ${windowText}, in ${resolution.words}.`
  const shown = series.avg.map((v, i) => i).filter(i => series.avg[i] !== null)
  if (series.kind === 'none' || (series.kind !== 'state' && shown.length === 0)) {
    return `${head} No readings in this window, and none before it.`
  }
  const parts = [head]
  if (series.kind === 'state') {
    const latest = [...series.states].reverse().find(s => s !== null)
    parts.push(`Latest ${latest}.`)
  } else {
    const word = (v) => (series.kind === 'flag' ? (v ? 'true' : 'false') : readingWords(v, unit))
    parts.push(`Latest ${word(series.avg[shown[shown.length - 1]])}.`)
    if (series.kind === 'number') {
      const lows = series.min.filter(v => v !== null)
      const highs = series.max.filter(v => v !== null)
      parts.push(`Lowest ${word(Math.min(...lows))}, highest ${word(Math.max(...highs))}.`)
    }
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
