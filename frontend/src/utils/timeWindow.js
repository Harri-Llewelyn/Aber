/**
 * The time window a page shows, how it is written in the address, and how it moves. A window is
 * one of four kinds:
 *
 *   { kind: 'all' }                                          every row, no bound
 *   { kind: 'rolling', range: '1h', ms, label }               the last hour, ending now
 *   { kind: 'calendar', span: 'week', at: '2026-11-02' }      the week holding that day; `at` null is today
 *   { kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' }   `to` is the first minute outside
 *
 * Everything is local time. A day runs from one local midnight to the next, so a step moves by date
 * through Date's local setters, never by 24 hours: 29 March 2026 is 23 hours long in London and
 * 25 October 25. Weeks start on Monday. frontend/README.md, "One time control for every period".
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The rolling ranges a page may offer, each ending now; a page passes the ones it offers. The short
 * ones exist because an act happens inside a second, and a day could not frame one.
 */
export const TIME_PRESETS = [
  { value: '15m', label: 'Last 15 minutes', ms: 15 * MINUTE },
  { value: '1h',  label: 'Last 1 hour',     ms: HOUR },
  { value: '24h', label: 'Last 24 hours',   ms: 24 * HOUR },
  { value: '7d',  label: 'Last 7 days',     ms: 7 * DAY },
  { value: '30d', label: 'Last 30 days',    ms: 30 * DAY },
]

/** No bound at all, written `range=all` where it is not the page's default. */
export const ALL_TIME = Object.freeze({ kind: 'all' })

/** What a calendar window covers, in the order the span switch shows them. */
export const SPANS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]

/** Every span, as a page offering all four passes them; a page may offer some of them. */
export const SPAN_IDS = SPANS.map(s => s.id)

/** The Jump to list: each keeps the span shown, so in Week "A month ago" is the week holding it. */
export const JUMPS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week-ago', label: 'A week ago' },
  { id: 'month-ago', label: 'A month ago' },
  { id: 'year-start', label: 'Start of the year' },
]

/** Every query key a window is written with; `since` and `until` are the Audit Trail's older names. */
export const WINDOW_KEYS = ['span', 'at', 'range', 'from', 'to', 'since', 'until']

/** Words use the browser's locale, as the timeline's tick labels do. */
const LOCALE = undefined

const pad = (n) => String(n).padStart(2, '0')
const LOCAL_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/

/**
 * A local `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss` as a Date, or null. Built from
 * its parts, because `new Date('2026-11-02')` reads a bare date as UTC. A day that does not exist
 * (31 April) is refused rather than rolled into the next month.
 */
export function parseLocal(value) {
  const m = LOCAL_FORM.exec(String(value ?? ''))
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(v => (v === undefined ? 0 : Number(v)))
  if (h > 23 || mi > 59 || s > 59) return null
  const date = new Date(y, mo - 1, d, h, mi, s)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

/** A local date alone (`YYYY-MM-DD`), as `at` and the date field write it, or null. */
export const parseDay = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? parseLocal(value) : null)

/** A Date as its local day, `YYYY-MM-DD`. */
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** A Date as local `YYYY-MM-DDTHH:mm`, the `datetime-local` form, with seconds only when it has them. */
export const localMinute = (d) =>
  `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}${d.getSeconds() ? `:${pad(d.getSeconds())}` : ''}`

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const daysIn = (year, month) => new Date(year, month + 1, 0).getDate()

/** `d` moved by `n` calendar days at the same clock time. */
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n,
  d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())

/** `d` moved by `n` months at the same clock time; the 31st becomes the last day of a shorter month. */
function addMonths(d, n) {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const day = Math.min(d.getDate(), daysIn(first.getFullYear(), first.getMonth()))
  return new Date(first.getFullYear(), first.getMonth(), day,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

/** The first moment of the span holding `d`: its local midnight, Monday, the 1st or 1 January. */
export function spanStart(span, d) {
  if (span === 'week') return addDays(midnight(d), -((d.getDay() + 6) % 7))
  if (span === 'month') return new Date(d.getFullYear(), d.getMonth(), 1)
  if (span === 'year') return new Date(d.getFullYear(), 0, 1)
  return midnight(d)
}

/** `d` moved by `n` spans, by date. */
export function addSpans(span, d, n) {
  if (span === 'week') return addDays(d, 7 * n)
  if (span === 'month') return addMonths(d, n)
  if (span === 'year') return addMonths(d, 12 * n)
  return addDays(d, n)
}

/** The day a calendar window is about: its `at`, or today. */
const dayOf = (win, now) => parseDay(win.at) || midnight(new Date(now))

/**
 * Where the window starts and ends at `now`, as Dates; `end` is the first moment outside it. Either
 * is null where the window has no such bound: both under All time, and an end left out of a
 * custom window.
 */
export function windowBounds(win, now = Date.now()) {
  if (win?.kind === 'rolling') return { start: new Date(now - win.ms), end: new Date(now) }
  if (win?.kind === 'calendar') {
    const start = spanStart(win.span, dayOf(win, now))
    return { start, end: addSpans(win.span, start, 1) }
  }
  if (win?.kind === 'custom') return { start: parseLocal(win.from), end: parseLocal(win.to) }
  return { start: null, end: null }
}

/**
 * The window as the `since` and `until` an API takes: ISO instants, or '' for no bound. `until` is
 * the last millisecond inside, since the Audit Trail's query includes it. A rolling window is left
 * open at the top, so a row written while the request runs still counts. Call it at fetch time,
 * so a rolling window or today is measured from the request.
 */
export function timeWindow(win, now = Date.now()) {
  const { start, end } = windowBounds(win, now)
  return {
    since: start ? start.toISOString() : '',
    until: end && win.kind !== 'rolling' ? new Date(end.getTime() - 1).toISOString() : '',
  }
}

/** How many calendar days apart two Dates at the same clock time are; null at different times. */
function wholeDaysBetween(a, b) {
  if (a.getHours() !== b.getHours() || a.getMinutes() !== b.getMinutes() || a.getSeconds() !== b.getSeconds()) return null
  const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY)
  return days > 0 ? days : null
}

/** [from, to) moved `n` times its own length: by date when it is whole days, else by its length in time. */
function shiftRange(from, to, n) {
  const days = wholeDaysBetween(from, to)
  if (days) return [addDays(from, days * n), addDays(to, days * n)]
  const ms = to.getTime() - from.getTime()
  return [new Date(from.getTime() + ms * n), new Date(to.getTime() + ms * n)]
}

const customWindow = (from, to) => ({ kind: 'custom', from: localMinute(from), to: localMinute(to) })

/** The window as it reaches now, the edge a step later may not cross. */
export function holdsNow(win, now = Date.now()) {
  if (win?.kind === 'rolling') return true
  const { end } = windowBounds(win, now)
  return !!end && end.getTime() > now
}

/**
 * Whether the window can move `n` steps (-1 earlier, +1 later): never under All time or with an
 * end missing, and never later while it holds now.
 */
export function canStep(win, n, now = Date.now()) {
  if (!win || win.kind === 'all') return false
  const { start, end } = windowBounds(win, now)
  if (!start || !end || end <= start) return false
  return n < 0 || !holdsNow(win, now)
}

/**
 * The window `n` steps on. A calendar window moves by its span, by date. A custom window moves by
 * its own length. A rolling window becomes the fixed window of the same length, from the current
 * minute, moved: Last 1 hour at 15:20, stepped back, is 13:20 to 14:20.
 */
export function stepWindow(win, n, now = Date.now()) {
  if (!canStep(win, n, now)) return win
  if (win.kind === 'calendar') return { ...win, at: localDay(addSpans(win.span, dayOf(win, now), n)) }
  const minute = new Date(Math.floor(now / MINUTE) * MINUTE)
  const [from, to] = win.kind === 'rolling'
    ? [new Date(minute.getTime() - win.ms), minute]
    : [parseLocal(win.from), parseLocal(win.to)]
  return customWindow(...shiftRange(from, to, n))
}

/**
 * The window `span` shows when chosen: the same day under a calendar window, the span holding a
 * custom window's last moment, and today otherwise, so Last 1 hour becomes Today.
 */
export function chooseSpan(win, span, now = Date.now()) {
  if (win?.kind === 'calendar') return { kind: 'calendar', span, at: win.at }
  const { start, end } = win?.kind === 'custom' ? windowBounds(win, now) : {}
  const last = end ? new Date(end.getTime() - 1) : start
  return { kind: 'calendar', span, at: localDay(last || new Date(now)) }
}

/**
 * A Jump to choice (a JUMPS id, or a `YYYY-MM-DD` from the date field), at the span shown, or else
 * at Day, or the first of `spans` on a page that does not offer Day.
 */
export function jumpTo(win, target, now = Date.now(), spans = SPAN_IDS) {
  const today = midnight(new Date(now))
  const day = {
    today,
    yesterday: addDays(today, -1),
    'week-ago': addDays(today, -7),
    'month-ago': addMonths(today, -1),
    'year-start': new Date(today.getFullYear(), 0, 1),
  }[target] || parseDay(target)
  if (!day) return win
  const span = win?.kind === 'calendar' ? win.span : spans.includes('day') ? 'day' : spans[0]
  return { kind: 'calendar', span, at: localDay(day) }
}

/** The arrows' names: by the span, or Earlier and Later for a window that steps by its own length. */
export function stepNames(win) {
  return win?.kind === 'calendar'
    ? { earlier: `Previous ${win.span}`, later: `Next ${win.span}` }
    : { earlier: 'Earlier', later: 'Later' }
}

/** "Mon 2 Nov", with the year where it is not this year's. */
const dayWords = (d, withYear) =>
  d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })

/** "15:20" in the browser's locale. */
export const clockWords = (d) => d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })

/** "Mon 26 Oct – Sun 1 Nov": the year on both ends when they differ, on the last when it is not this one. */
function daysWords(first, last, thisYear) {
  const crosses = first.getFullYear() !== last.getFullYear()
  return `${dayWords(first, crosses)} – ${dayWords(last, crosses || last.getFullYear() !== thisYear)}`
}

/**
 * The window in words, as the control's button shows it: "Today, Mon 2 Nov", "Mon 26 Oct – Sun 1
 * Nov", "October 2026", "2026", "Last 1 hour", "All time", or "Mon 2 Nov, 10:05 – 14:20". A custom
 * window of whole days reads as days.
 */
export function windowWords(win, now = Date.now()) {
  const thisYear = new Date(now).getFullYear()
  const ofYear = (d) => d.getFullYear() !== thisYear
  if (win?.kind === 'rolling') return win.label
  if (win?.kind === 'calendar') {
    const { start, end } = windowBounds(win, now)
    if (win.span === 'year') return String(start.getFullYear())
    if (win.span === 'month') return start.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })
    if (win.span === 'week') return daysWords(start, addDays(end, -1), thisYear)
    const words = dayWords(start, ofYear(start))
    return localDay(start) === localDay(new Date(now)) ? `Today, ${words}` : words
  }
  if (win?.kind === 'custom') {
    const from = parseLocal(win.from)
    const to = parseLocal(win.to)
    const at = (d) => `${dayWords(d, ofYear(d))}, ${clockWords(d)}`
    if (from && to) {
      if (wholeDaysBetween(from, to) && from.getTime() === midnight(from).getTime()) {
        const last = addDays(to, -1)
        return localDay(from) === localDay(last) ? dayWords(from, ofYear(from)) : daysWords(from, last, thisYear)
      }
      return localDay(from) === localDay(to) ? `${at(from)} – ${clockWords(to)}` : `${at(from)} – ${at(to)}`
    }
    if (from) return `From ${at(from)}`
    if (to) return `Until ${at(to)}`
  }
  return 'All time'
}

/**
 * The ticks of a calendar window's axis, at local times so a clock change does not move them: a
 * day every six hours, a week at each midnight, a month weekly from the 1st, a year each quarter.
 * Each is `{ at, label }`, the window's two ends included.
 */
export function calendarTicks(span, start, end) {
  const y = start.getFullYear()
  const m = start.getMonth()
  if (span === 'day') {
    return [0, 6, 12, 18, 24].map(h => new Date(y, m, start.getDate(), h))
      .map(at => ({ at, label: clockWords(at) }))
  }
  if (span === 'week') {
    return [0, 1, 2, 3, 4, 5, 6, 7].map(i => addDays(start, i))
      .map(at => ({ at, label: at.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric' }) }))
  }
  const at = span === 'year'
    ? [0, 3, 6, 9, 12].map(month => new Date(y, month, 1))
    : [...[1, 8, 15, 22].map(d => new Date(y, m, d)), end]
  return at.map(d => ({ at: d, label: d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) }))
}

/** Whether two windows are the same window, as written in the address. */
export const sameWindow = (a, b) => !!a && !!b && a.kind === b.kind
  && (a.span ?? null) === (b.span ?? null) && (a.at ?? null) === (b.at ?? null)
  && (a.range ?? null) === (b.range ?? null)
  && (a.from || '') === (b.from || '') && (a.to || '') === (b.to || '')

const rolling = (r) => ({ kind: 'rolling', range: r.value, ms: r.ms, label: r.label })

/**
 * The older `until` named the last minute inside a window (a bare date, the last day); `to` names
 * the first moment outside it, so the same window opens.
 */
function legacyTo(until) {
  const d = parseLocal(until)
  if (!d) return ''
  return localMinute(String(until).includes('T') ? new Date(d.getTime() + MINUTE) : addDays(d, 1))
}

/**
 * The window an address names, for a page offering `ranges`, `spans` (and All time if `allTime`).
 * In order: `span` with `at`; `from` and `to`; the older `since` and `until`, read as `from` and
 * `to`; `range`. A span the page does not offer is passed over, and anything else is the page's
 * `fallback`.
 */
export function windowFromQuery(query, { ranges = TIME_PRESETS, allTime = false, fallback = ALL_TIME, spans = SPAN_IDS } = {}) {
  const get = (key) => query.get(key)
  if (spans.includes(get('span'))) {
    return { kind: 'calendar', span: get('span'), at: parseDay(get('at')) ? get('at') : null }
  }
  const [from, to] = [get('from'), get('to')].map(v => (parseLocal(v) ? v : ''))
  if (from || to) return { kind: 'custom', from, to }
  const since = parseLocal(get('since'))
  const until = legacyTo(get('until'))
  if (since || until) return { kind: 'custom', from: since ? localMinute(since) : '', to: until }
  if (get('range') === 'all' && allTime) return ALL_TIME
  const range = ranges.find(r => r.value === get('range'))
  return range ? rolling(range) : fallback
}

/** The query keys that write `win`, every window key named (null to remove); the default writes none. */
export function windowToQuery(win, fallback = ALL_TIME) {
  const query = Object.fromEntries(WINDOW_KEYS.map(k => [k, null]))
  if (sameWindow(win, fallback)) return query
  if (win.kind === 'calendar') Object.assign(query, { span: win.span, at: win.at || null })
  else if (win.kind === 'custom') Object.assign(query, { from: win.from || null, to: win.to || null })
  else if (win.kind === 'rolling') query.range = win.range
  else query.range = 'all'
  return query
}

/** A rolling range of `ranges` as a window, for a page that sets one itself. */
export const rollingWindow = (value, ranges = TIME_PRESETS) => {
  const range = ranges.find(r => r.value === value)
  return range ? rolling(range) : ALL_TIME
}
