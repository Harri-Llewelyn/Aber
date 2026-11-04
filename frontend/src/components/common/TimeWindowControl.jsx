import React, { useId, useState } from 'react'
import { ToolbarPopover } from './FiltersPopover'
import { SegmentedControl } from './SegmentedControl'
import { Tooltip } from './Tooltip'
import { IconCalendar, IconChevronLeft, IconChevronRight, IconZoomIn, IconZoomOut } from './Icons'
import { useClockTick } from '../../hooks/useClockTick'
import {
  ALL_TIME, JUMPS, SPANS, SPAN_IDS, TIME_PRESETS, canStep, canZoomIn, canZoomOut, chooseSpan, holdsNow,
  jumpTo, localMinute, parseDay, parseLocal, rollingWindow, sameWindow, stepNames, stepWindow, windowBounds,
  windowWords, zoomBounds, zoomIn, zoomOut
} from '../../utils/timeWindow'

/** How often the control looks at the clock, so the words and the › arrow follow it. */
const CLOCK_MS = 60 * 1000


/**
 * One icon button: an arrow, or Zoom in or Zoom out. Off, it is `aria-disabled`, not `disabled`,
 * as the Audit Trail drawer's step buttons are: it keeps its Tab stop, a press does nothing, and
 * its tooltip says why. On, the tooltip is `tip`, or its name.
 */
function WindowButton({ name, tip = name, off, reason, onStep, children }) {
  return (
    <Tooltip text={off ? reason : tip}>
      <button
        type="button"
        className={`btn btn-sm btn-ghost time-window-step${off ? ' btn-disabled' : ''}`}
        aria-label={name}
        aria-disabled={off ? 'true' : undefined}
        onClick={() => { if (!off) onStep() }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** The popover's three groups: Jump to, Rolling and Custom range. `onChoose` takes the new window. */
function WindowChoices({ value, ranges, allTime, spans, now, onChoose }) {
  const id = useId()
  const bounds = windowBounds(value, now)
  const [day, setDay] = useState('')
  // The custom boxes open on the window shown, to the minute, so a small change is a small edit.
  const boxed = (d) => (d ? localMinute(new Date(Math.floor(d.getTime() / 60000) * 60000)) : '')
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : boxed(bounds.start))
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : boxed(bounds.end))
  const rangeOk = !!parseLocal(from) && !!parseLocal(to) && parseLocal(from) < parseLocal(to)

  const option = (win, text, key) => {
    const chosen = sameWindow(win, value)
    return (
      <button
        key={key}
        type="button"
        className={`btn btn-sm ${chosen ? 'btn-primary' : 'btn-ghost'}`}
        aria-pressed={chosen}
        onClick={() => onChoose(win)}
      >
        {text}
      </button>
    )
  }

  return (
    <>
      <div className="time-window-group" role="group" aria-labelledby={`${id}-jump`}>
        <div className="form-label" id={`${id}-jump`}>Jump to</div>
        <div className="time-window-options">
          {JUMPS.map(j => (
            <button key={j.id} type="button" className="btn btn-sm btn-ghost" onClick={() => onChoose(jumpTo(value, j.id, now, spans))}>
              {j.label}
            </button>
          ))}
        </div>
        <form
          className="time-window-row"
          onSubmit={(e) => { e.preventDefault(); if (parseDay(day)) onChoose(jumpTo(value, day, now, spans)) }}
        >
          <label className="time-window-field">
            <span>Another day</span>
            <input type="date" className="form-control" value={day} onChange={e => setDay(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-sm btn-ghost" disabled={!parseDay(day)}>Jump</button>
        </form>
      </div>

      <div className="time-window-group" role="group" aria-labelledby={`${id}-rolling`}>
        <div className="form-label" id={`${id}-rolling`}>Rolling</div>
        <div className="time-window-options">
          {ranges.map(r => option(rollingWindow(r.value, ranges), r.label, r.value))}
          {allTime && option(ALL_TIME, 'All time', 'all')}
        </div>
      </div>

      <div className="time-window-group" role="group" aria-labelledby={`${id}-custom`}>
        <div className="form-label" id={`${id}-custom`}>Custom range</div>
        <form
          className="time-window-group"
          onSubmit={(e) => { e.preventDefault(); if (rangeOk) onChoose({ kind: 'custom', from, to }) }}
        >
          <label className="time-window-field">
            <span>From</span>
            <Tooltip text="In local time.">
              <input type="datetime-local" className="form-control" value={from} onChange={e => setFrom(e.target.value)} />
            </Tooltip>
          </label>
          <label className="time-window-field">
            <span>To</span>
            <Tooltip text="In local time. The range stops at the start of this minute.">
              <input type="datetime-local" className="form-control" value={to} onChange={e => setTo(e.target.value)} />
            </Tooltip>
          </label>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!rangeOk}>Show range</button>
        </form>
      </div>
    </>
  )
}

/**
 * One time control for every page that shows a period: ‹ the window in words › and the
 * Day | Week | Month | Year switch. The words open a popover (ToolbarPopover, the Filters frame)
 * to jump to a day, Today among them, or choose a rolling or custom range. It sits in the toolbar after the search box.
 *
 *   const [win, setWin] = useTimeWindow({ ranges: TIME_PRESETS, allTime: true })
 *   <TimeWindowControl value={win} onChange={setWin} ranges={TIME_PRESETS} allTime />
 *   const { since, until } = timeWindow(win)   // at fetch time
 *
 * `ranges` and `allTime` are what the Rolling group offers, and `spans` the switch (`SPAN_IDS` or
 * some of them); pass the same to useTimeWindow. The arrows step by the span, or by the window's
 * own length (Earlier and Later). › is off while the window holds now, and both under All time.
 * Each step is said in a polite status line. No key is bound: `[` and `]` change tab, and the
 * arrow keys step the Audit Trail's drawer.
 *
 * `zoom` adds Zoom in and Zoom out after the switch: half and twice the window about its middle,
 * as a custom window. `extent` is the stretch the page's axis draws, which Zoom in halves where
 * the window has no bounds of its own (All time). A zoom calls `onChange(next, { replace: false })`,
 * so Back undoes it; everything else calls `onChange(next)`, which replaces the entry.
 */
export function TimeWindowControl({
  value, onChange, ranges = TIME_PRESETS, allTime = false, spans = SPAN_IDS, label = 'Time window',
  zoom = false, extent = null,
}) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const [news, setNews] = useState('')
  const names = stepNames(value)
  const span = value.kind === 'calendar' ? value.span : null
  const offered = SPANS.filter(s => spans.includes(s.id))

  /** Show `next`, and say so in the status line: the arrows and the switch keep focus, so nothing else would. */
  const show = (next, ...options) => {
    onChange(next, ...options)
    setNews(`Showing ${windowWords(next, now)}`)
  }

  const stuck = value.kind === 'all'
    ? 'All time already shows every event, so there is nothing earlier or later.'
    : 'Set both ends of the custom range to step it.'
  const laterReason = canStep(value, -1, now) && holdsNow(value, now)
    ? 'This window already reaches now, so nothing later is recorded yet.'
    : stuck

  const zoomable = !!zoomBounds(value, now, extent)
  const unzoomable = value.kind === 'all' ? 'Nothing is drawn yet to zoom into.' : 'Set both ends of the custom range to zoom it.'
  const inReason = zoomable ? 'This window is one minute long, the narrowest a zoom goes.' : unzoomable
  const outReason = value.kind === 'all' ? 'All time already shows every event, so there is nothing wider.' : unzoomable

  return (
    <div className="time-window" role="group" aria-label={label}>
      {/* The arrows never part from the words; the switch may wrap under them. */}
      <span className="time-window-nav">
        <WindowButton
          name={names.earlier}
          off={!canStep(value, -1, now)}
          reason={stuck}
          onStep={() => show(stepWindow(value, -1, now))}
        >
          <IconChevronLeft size={15} aria-hidden="true" />
        </WindowButton>

        <ToolbarPopover
          label="Choose a time window"
          button={<><IconCalendar size={13} aria-hidden="true" /><span className="time-window-words">{windowWords(value, now)}</span></>}
          buttonClass="btn btn-sm btn-ghost time-window-pick"
          tip="Jump to a day, or choose a rolling or custom range"
        >
          {({ close }) => (
            <WindowChoices
              value={value}
              ranges={ranges}
              allTime={allTime}
              spans={spans}
              now={now}
              onChoose={(next) => { onChange(next); close() }}
            />
          )}
        </ToolbarPopover>

        <WindowButton
          name={names.later}
          off={!canStep(value, 1, now)}
          reason={laterReason}
          onStep={() => show(stepWindow(value, 1, now))}
        >
          <IconChevronRight size={15} aria-hidden="true" />
        </WindowButton>
      </span>

      <SegmentedControl
        label="Span"
        options={offered}
        value={span}
        onChange={(next) => show(chooseSpan(value, next, now))}
      />

      {/* In the expanded plan's order, Zoom in first. */}
      {zoom && (
        <span className="time-window-zoom" role="group" aria-label="Zoom">
          <WindowButton
            name="Zoom in"
            tip="Show the middle half of this window. Back undoes a zoom."
            off={!canZoomIn(value, now, extent)}
            reason={inReason}
            onStep={() => show(zoomIn(value, now, extent), { replace: false })}
          >
            <IconZoomIn size={15} aria-hidden="true" />
          </WindowButton>
          <WindowButton
            name="Zoom out"
            tip="Show twice as long a window about the same middle, ending no later than now. Back undoes a zoom."
            off={!canZoomOut(value, now, extent)}
            reason={outReason}
            onStep={() => show(zoomOut(value, now, extent), { replace: false })}
          >
            <IconZoomOut size={15} aria-hidden="true" />
          </WindowButton>
        </span>
      )}

      <div className="sr-only" role="status" aria-live="polite">{news}</div>
    </div>
  )
}
