const MACROS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

// [min, max] of each field, in order.
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

const MINUTE_MS = 60 * 1000
const SCAN_DAYS = 62
// A schedule that has run this often is settled: its shortest gap is already among them.
const ENOUGH_RUNS = 200

/** One field as the set of values it allows, or null when it cannot be read. */
function expand(text, [min, max]) {
  const values = new Set()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const step = m[4] === undefined ? 1 : Number(m[4])
    let from = min
    let to = max
    if (m[1] !== '*') {
      from = Number(m[2])
      // "5/15" runs from 5 to the top of the range, as cron reads it.
      to = m[3] !== undefined ? Number(m[3]) : (m[4] !== undefined ? max : from)
    }
    if (step < 1 || from < min || to > max || from > to) return null
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

/**
 * How often a pg_cron schedule runs: the shortest gap, in seconds, between two of its runs, or null
 * when that cannot be told. The backup service reports its BACKUP_SCHEDULE, and the Backups page
 * warns when a backup takes more than half of this.
 *
 * Reads what pg_cron accepts: five fields (minute, hour, day of month, month, day of week, matched
 * in UTC as pg_cron runs them) of numbers, `*`, lists, ranges and steps; `N seconds`; and the
 * `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually` macros. Null
 * for an empty schedule (backups off), a form this does not read (month or weekday names), or one
 * that runs fewer than twice in 62 days. A day of month and a day of week both restricted match
 * either, as cron does.
 */
export function cronIntervalSeconds(schedule, from = Date.now()) {
  const text = String(schedule ?? '').trim().toLowerCase()
  if (!text) return null
  const seconds = /^(\d+)\s+seconds?$/.exec(text)
  if (seconds) {
    const n = Number(seconds[1])
    return n >= 1 && n <= 59 ? n : null
  }
  const parts = (MACROS[text] || text).split(/\s+/)
  if (parts.length !== 5) return null
  const sets = parts.map((p, i) => expand(p, FIELDS[i]))
  if (sets.some(s => s === null)) return null
  const [minutes, hours, days, months, weekdays] = sets
  if (weekdays.has(7)) weekdays.add(0)
  const dayRestricted = parts[2] !== '*'
  const weekdayRestricted = parts[4] !== '*'

  const matches = (d) => {
    if (!minutes.has(d.getUTCMinutes()) || !hours.has(d.getUTCHours()) || !months.has(d.getUTCMonth() + 1)) return false
    const day = days.has(d.getUTCDate())
    const weekday = weekdays.has(d.getUTCDay())
    if (dayRestricted && weekdayRestricted) return day || weekday
    return day && weekday
  }

  // Minute by minute from the next whole minute: at most 89,280 steps, and far fewer for a
  // schedule that runs often.
  const start = Math.ceil(from / MINUTE_MS) * MINUTE_MS
  let previous = null
  let shortest = null
  let runs = 0
  for (let t = start; t < start + SCAN_DAYS * 24 * 60 * MINUTE_MS; t += MINUTE_MS) {
    if (!matches(new Date(t))) continue
    if (previous !== null) {
      const gap = (t - previous) / 1000
      if (shortest === null || gap < shortest) shortest = gap
    }
    previous = t
    runs += 1
    if (runs >= ENOUGH_RUNS) break
  }
  return shortest
}
