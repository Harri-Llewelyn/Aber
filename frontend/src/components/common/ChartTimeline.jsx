import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { clockWords } from '../../utils/timeWindow'
import { nowFraction } from '../../utils/history'
import { FUTURE_WORDS_PX, PLOT_LEFT_PX, PLOT_RIGHT_PX, pointerWords, timelineTicks } from '../../utils/timelineAxis'

const TimelineContext = createContext(null)

/**
 * The page's shared time axis, or null outside one: `{ start, end, now, ticks, pointer, point,
 * clear, band }`. A chart inside one (TimeSeriesChart) draws no time labels, Now badge or "No
 * readings yet" of its own, takes its gridlines from `ticks` and its pointer from `pointer`.
 */
export const useChartTimeline = () => useContext(TimelineContext)

/** Whether two pointers are the same: a time in milliseconds and the part of the page it is over (`plot`, `strip` or `axis`). */
const same = (a, b) => a === b || (a && b && a.at === b.at && a.by === b.by)

/**
 * The state every chart of a page shares: the window (`start` and `end` in milliseconds, `now`),
 * the axis's ticks at the width the axis measures (`setAxisPx`), the pointer, and the drag's
 * `band`. It draws nothing; ChartTimeline puts the axis over it, and a page with lanes of its own
 * can lay its own axis and provide this alone.
 */
export function TimelineProvider({ start, end, now, band = null, children }) {
  const [pointer, setPointer] = useState(null)
  const [axisPx, setAxisPx] = useState(0)
  const point = useCallback((next) => setPointer(prev => (same(prev, next) ? prev : next)), [])
  const clear = useCallback((by) => setPointer(prev => (prev && prev.by === by ? null : prev)), [])
  const ticks = useMemo(() => timelineTicks(start, end, axisPx), [start, end, axisPx])
  const value = useMemo(
    () => ({ start, end, now, ticks, pointer, point, clear, band, axisPx, setAxisPx }),
    [start, end, now, ticks, pointer, point, clear, band, axisPx]
  )
  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>
}

/** The width of the Now badge, "Now 15:20", which the future part's words come after. */
const NOW_BADGE_PX = 76

/** A readout's class near either end of the axis, which holds it inside, as the Audit Trail's band words are. */
const heldBy = (f) => (f > 0.85 ? ' trail-band-words-end' : f < 0.15 ? ' trail-band-words-start' : '')

/**
 * The one time axis over a page's charts: the time labels, then under them the future part hatched
 * and said once ("No readings yet") with the Now badge at its edge, the time under the pointer, and
 * the band a drag shades. The badge has the row of the hatch, so it never covers a label. It
 * takes its two gutters from `--plot-left` and `--plot-right` (ChartTimeline sets them to the
 * charts'), so a tick is above the same time in every plot area and strip. A press and a drag on
 * it zooms, as on a chart (`.chart-axis-track` is a track of useChartBand). Sticky, as the Audit
 * Trail's axis is; the group headings pin under it by `--chart-axis-height`. It is hidden from
 * assistive technology: each chart's summary names the window.
 */
export function ChartAxis() {
  const { start, end, now, ticks, pointer, point, clear, band, axisPx, setAxisPx } = useChartTimeline()
  const trackRef = useRef(null)

  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    setAxisPx(track.clientWidth)
    if (typeof ResizeObserver !== 'function') return undefined
    const watcher = new ResizeObserver(() => setAxisPx(track.clientWidth))
    watcher.observe(track)
    return () => watcher.disconnect()
  }, [setAxisPx])

  const span = end - start
  const fraction = nowFraction(start, end, now)
  // The words follow the Now badge, which stands at the line: they need its width and their own.
  const futureFits = fraction !== null && (!axisPx || (1 - fraction) * axisPx >= FUTURE_WORDS_PX + NOW_BADGE_PX)

  const moved = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (!(rect.width > 0)) return
    const f = (e.clientX - rect.left) / rect.width
    if (f < 0 || f > 1) clear('axis')
    else point({ at: start + f * span, by: 'axis' })
  }

  const pointed = pointer && !band ? (pointer.at - start) / span : null
  return (
    <div className="chart-axis" aria-hidden="true">
      <div className="chart-axis-track" ref={trackRef} onPointerMove={moved} onPointerLeave={() => clear('axis')}>
        <div className="chart-axis-row">
          {band && <div className="trail-band" style={{ left: `${band.lo * 100}%`, width: `${(band.hi - band.lo) * 100}%` }} />}
          {band && (
            <div
              className={`trail-band-words${heldBy(band.mid)}`}
              style={{ left: `${(band.mid > 0.85 ? band.hi : band.mid < 0.15 ? band.lo : band.mid) * 100}%` }}
            >
              {band.words}
            </div>
          )}
          {ticks.map(t => (
            <span key={t.at} className={`chart-tick chart-tick-${t.align}`} style={{ left: `${t.f * 100}%` }}>{t.label}</span>
          ))}
          {pointed !== null && pointed >= 0 && pointed <= 1 && (
            <div className={`trail-band-words chart-axis-pointer${heldBy(pointed)}`} style={{ left: `${pointed * 100}%` }}>
              {pointerWords(pointer.at, span)}
            </div>
          )}
        </div>
        {fraction !== null && (
          <div className="chart-axis-future-row">
            <div className="trail-shade trail-shade-future" style={{ left: `${fraction * 100}%` }}>{futureFits && 'No readings yet'}</div>
            <div className={`trail-now${fraction > 0.85 ? ' trail-now-end' : ' trail-now-start'}`} style={{ left: `${fraction * 100}%` }}>
              Now {clockWords(new Date(now))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A page's charts under one time axis (ChartAxis) over the window `start` to `end`, with `now`, and
 * `band` the drag's (useChartBand()). `children` are the groups; the wrapper is what the page's
 * press handler (`onPointerDown`, useChartBand's) goes on, and takes the page's own `className`. The
 * charts' gutters are set for the axis through `--plot-left` and `--plot-right`.
 *
 *   <ChartTimeline className="history-groups" start={s} end={e} now={now} band={band} onPointerDown={startBand}>
 *     …groups of TimeSeriesChart…
 *   </ChartTimeline>
 */
export function ChartTimeline({ start, end, now, band = null, onPointerDown, className = '', children }) {
  const future = nowFraction(start, end, now) !== null
  return (
    <TimelineProvider start={start} end={end} now={now} band={band}>
      <div
        className={`chart-timeline${future ? ' chart-timeline-future' : ''}${className ? ` ${className}` : ''}`}
        style={{ '--plot-left': `${PLOT_LEFT_PX}px`, '--plot-right': `${PLOT_RIGHT_PX}px` }}
        onPointerDown={onPointerDown}
      >
        <ChartAxis />
        {children}
      </div>
    </TimelineProvider>
  )
}
