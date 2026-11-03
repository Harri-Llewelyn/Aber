import { useCallback, useEffect, useMemo } from 'react'
import { navigate, queryOf, useUrl, withQuery } from './useUrlState'
import { ALL_TIME, SPAN_IDS, TIME_PRESETS, WINDOW_KEYS, windowFromQuery, windowToQuery } from '../utils/timeWindow'

/**
 * A page's time window, held in the address as `span` and `at`, `range`, or `from` and `to`
 * (utils/timeWindow.js). Returns `[win, setWin]`, as useUrlState does, and a change replaces the
 * history entry, so Back does not replay each step. The page's `fallback` writes nothing, and an
 * address written another way (the older `since` and `until`, a value the page does not offer) is
 * tidied to the one way. Pass module-level constants: the window is memoised on them.
 *
 * @param {Object} [options]
 * @param {Array} [options.ranges] The rolling ranges the page offers, `TIME_PRESETS` or some of them.
 * @param {boolean} [options.allTime] Whether All time is one of them.
 * @param {Object} [options.fallback] The window with nothing in the address.
 * @param {string[]} [options.spans] The spans the page offers, `SPAN_IDS` or some of them.
 */
export function useTimeWindow({ ranges = TIME_PRESETS, allTime = false, fallback = ALL_TIME, spans = SPAN_IDS } = {}) {
  const query = queryOf(useUrl())
  // The window's own keys as one string, so the window is a new object only when they change.
  const written = JSON.stringify(WINDOW_KEYS.map(k => query.get(k)))

  const win = useMemo(() => {
    const own = new URLSearchParams()
    JSON.parse(written).forEach((value, i) => { if (value !== null) own.set(WINDOW_KEYS[i], value) })
    return windowFromQuery(own, { ranges, allTime, fallback, spans })
  }, [written, ranges, allTime, fallback, spans])

  const tidy = JSON.stringify(WINDOW_KEYS.map(k => windowToQuery(win, fallback)[k])) !== written
  useEffect(() => {
    if (tidy) navigate(withQuery(windowToQuery(win, fallback)), { replace: true })
  }, [tidy, win, fallback])

  const setWin = useCallback(
    (next) => navigate(withQuery(windowToQuery(next, fallback)), { replace: true }),
    [fallback]
  )

  return [win, setWin]
}
