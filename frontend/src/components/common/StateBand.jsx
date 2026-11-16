import React, { useEffect, useRef, useState } from 'react'
import { OverflowText } from './OverflowText'
import { NEAR_HUE_DEG, hueGap, shareWords, stateHue } from '../../utils/history'

/** Under this many pixels a run keeps its colour but no name: padding and an ellipsis leave a lone ellipsis. */
const NAMED_RUN_PX = 36

/** A hairline between two runs needs room: under this many pixels it would take the whole run. */
const DIVIDED_RUN_PX = 4

/**
 * How far a run reaches under the next one, as a percentage of the window. Two edges that are one
 * number still land a sixty-fourth of a pixel apart in layout, and a browser that rounds each to a
 * whole pixel can leave a hairline of the card between them; this is more than that at any width.
 */
const OVERLAP_PCT = 0.02

/** A value's hue for App.css to colour it with, through the CSSOM: `--state-hue` (stateHue()). */
const hueOf = (state) => ({ '--state-hue': stateHue(state) })

/**
 * A state metric as one band of its runs across the window: text, which no line can draw. The runs
 * meet edge to edge and only the band's two ends are rounded; a gap in the readings ends one band
 * and starts the next. Each value takes the hue its text hashes to, at the theme's lightness and
 * chroma, and a hairline in the later run's edge colour parts two neighbours whose hues are too near
 * to tell apart (NEAR_HUE_DEG). A carried stretch is hatched. A run under NAMED_RUN_PX keeps its
 * colour and no name, at least 1px wide so a brief state is never lost; the head names it under
 * the pointer.
 * A bucket that held more than one value (`marks`) is dotted along its foot.
 *
 * It takes the runs (stateRuns(), or a change read's) and the window, and fills the width it is
 * given, so a chart, or a lane of History's Overview, can place it on any time scale.
 */
export function StateBand({ runs, marks = [], start, end }) {
  const ref = useRef(null)
  const [px, setPx] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    setPx(el.clientWidth)
    if (typeof ResizeObserver !== 'function') return undefined
    const watcher = new ResizeObserver(() => setPx(el.clientWidth))
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [])
  const span = end - start
  const part = (from, to, of, over = 0) => ({ left: `${((from - of.from) / of.span) * 100}%`, width: `${((to - from) / of.span) * 100 + over}%` })
  const whole = { from: start, span }
  return (
    <div className="chart-states" ref={ref}>
      {runs.map((r, i) => {
        const own = { from: r.startMs, span: r.endMs - r.startMs }
        const wide = ((r.endMs - r.startMs) / span) * px
        const named = !(px > 0 && wide < NAMED_RUN_PX)
        const after = runs[i - 1]?.endMs === r.startMs ? runs[i - 1] : null
        const before = runs[i + 1]?.startMs === r.endMs
        const apart = after && wide >= DIVIDED_RUN_PX && hueGap(after.state, r.state) < NEAR_HUE_DEG
        const classes = [
          'chart-state',
          named ? '' : 'chart-state-thin',
          after ? '' : 'chart-state-first',
          before ? '' : 'chart-state-last',
          apart ? 'chart-state-divided' : '',
        ].filter(Boolean).join(' ')
        return (
          <span key={r.from} className={classes} style={{ ...part(r.startMs, r.endMs, whole, before ? OVERLAP_PCT : 0), ...hueOf(r.state) }}>
            {r.carried.map(c => (
              <span key={c.startMs} className="chart-state-carried" style={part(c.startMs, c.endMs, own)} />
            ))}
            {named && <OverflowText>{r.state}</OverflowText>}
          </span>
        )
      })}
      {marks.map(m => <span key={m.startMs} className="chart-state-mixed" style={part(m.startMs, m.endMs, whole)} />)}
    </div>
  )
}

/**
 * Under a state's band: each value with its colour and its share of the charted time, then the
 * others, and a note for each mark the band carries. `stateKey` is stateKey() of the runs' shares.
 */
export function StateBandKey({ stateKey: key, carried, mixed }) {
  return (
    <ul className="chart-state-key">
      {key.shown.map(s => (
        <li key={s.state} className="chart-state-key-value" style={hueOf(s.state)}>
          <span className="chart-state-swatch" aria-hidden="true" />
          <OverflowText className="chart-state-key-name">{s.state}</OverflowText>
          <span className="chart-state-share">{shareWords(s.share)}</span>
        </li>
      ))}
      {key.others && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch" aria-hidden="true" />
          <span className="chart-state-key-name">{`${key.others.count} other${key.others.count === 1 ? '' : 's'}`}</span>
          <span className="chart-state-share">{shareWords(key.others.share)}</span>
        </li>
      )}
      {carried && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch chart-state-swatch-carried" aria-hidden="true" />
          <span className="chart-state-key-name">carried forward</span>
        </li>
      )}
      {mixed && (
        <li className="chart-state-key-plain">
          <span className="chart-state-swatch chart-state-swatch-mixed" aria-hidden="true" />
          <span className="chart-state-key-name">more than one value in the bucket</span>
        </li>
      )}
    </ul>
  )
}
