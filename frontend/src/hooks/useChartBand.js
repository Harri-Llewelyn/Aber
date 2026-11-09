import { useBandDrag } from './useBandDrag'
import { bandWindow, bandWords, windowBounds } from '../utils/timeWindow'

/**
 * The charts' band drag (hooks/useBandDrag.js): a press on a chart's plot area or a state's strip,
 * each the window's width.
 */
const CHART_BAND = { track: '.u-over, .chart-box-states' }

/**
 * A drag across any of a page's time-series charts, which shades one band on every chart and sets it
 * as the page's window on release, as a new history entry so Back undoes it. `span` is the window
 * the charts drew, `{ start, ms }` in milliseconds, or null before one; `now` words the band's end.
 * Returns the handler to put on the element holding the charts, and `band` for each chart: its ends
 * as fractions of the window, its middle, and the window a release sets in words; null while none
 * is dragged.
 */
export function useChartBand({ span, setWin, now }) {
  const atFraction = (f) => span.start + span.ms * f
  const { band, onPointerDown } = useBandDrag((a, b) => {
    if (span) setWin(bandWindow(atFraction(a), atFraction(b), span.ms), { replace: false })
  }, CHART_BAND)
  const shown = band && span ? (() => {
    const lo = Math.min(band.a, band.b)
    const hi = Math.max(band.a, band.b)
    const { start, end } = windowBounds(bandWindow(atFraction(lo), atFraction(hi), span.ms))
    return { lo, hi, mid: (lo + hi) / 2, words: bandWords(start, end, now) }
  })() : null
  return { band: shown, onPointerDown }
}
