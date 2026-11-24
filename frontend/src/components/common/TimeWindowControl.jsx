import React, { useEffect, useId, useState } from 'react'
import { FieldError, fieldErrorProps } from './FieldError'
import { ToolbarPopover } from './FiltersPopover'
import { SegmentedControl } from './SegmentedControl'
import { Tooltip } from './Tooltip'
import { IconCalendar, IconChevronLeft, IconChevronRight, IconZoomIn, IconZoomOut } from './Icons'
import { useClockTick } from '../../hooks/useClockTick'
import {
  ALL_TIME, JUMPS, SPANS, SPAN_IDS, TIME_PRESETS, canStep, canZoomIn, canZoomOut, chooseSpan, holdsNow,
  jumpTo, localMinute, overLimit, parseDay, parseLocal, rollingWindow, sameWindow, stepNames, stepWindow,
  windowBounds, windowWords, zoomBounds, zoomIn, zoomOut
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

/**
 * The popover's three groups: Jump to, Rolling and Custom range. `onChoose` takes the new window.
 * Under a `limit`, a rolling range or a custom one over it is refused here and the window stays.
 */
function WindowChoices({ value, ranges, allTime, spans, now, limit, onChoose }) {
  const id = useId()
  const bounds = windowBounds(value, now)
  const [day, setDay] = useState('')
  // The custom boxes open on the window shown, to the minute, so a small change is a small edit.
  const boxed = (d) => (d ? localMinute(new Date(Math.floor(d.getTime() / 60000) * 60000)) : '')
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : boxed(bounds.start))
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : boxed(bounds.end))
  const rangeOk = !!parseLocal(from) && !!parseLocal(to) && parseLocal(from) < parseLocal(to)
  // A rolling range refused, and a custom one once a box has been edited: never on open, when the
  // boxes hold the window already shown.
  const [refused, setRefused] = useState(false)
  const [edited, setEdited] = useState(false)
  const customOver = rangeOk && overLimit({ kind: 'custom', from, to }, limit, now)
  const reason = limit?.reason
  const customError = edited && customOver ? reason : null

  const option = (win, text, key) => {
    const chosen = sameWindow(win, value)
    // Offered and refused, as a span over the limit is: not `disabled`, so it keeps its place in the
    // tab order and its tooltip. The window shown is never refused, since it is already on screen.
    if (!chosen && overLimit(win, limit, now)) {
      return (
        <Tooltip key={key} text={reason}>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-disabled"
            aria-disabled="true"
            onClick={() => setRefused(true)}
          >
            {text}
          </button>
        </Tooltip>
      )
    }
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
        {/* Not a field's: the range pressed is aria-disabled, and its tooltip says the same. */}
        <FieldError error={refused ? reason : null} />
      </div>

      <div className="time-window-group" role="group" aria-labelledby={`${id}-custom`}>
        <div className="form-label" id={`${id}-custom`}>Custom range</div>
        <form
          className="time-window-group"
          onSubmit={(e) => { e.preventDefault(); if (rangeOk && !customOver) onChoose({ kind: 'custom', from, to }) }}
        >
          <label className="time-window-field">
            <span>From</span>
            <Tooltip text="In local time.">
              <input type="datetime-local" className="form-control" value={from} onChange={e => { setFrom(e.target.value); setEdited(true) }} {...fieldErrorProps(customError, `${id}-custom-error`)} />
            </Tooltip>
          </label>
          <label className="time-window-field">
            <span>To</span>
            <Tooltip text="In local time. The range stops at the start of this minute.">
              <input type="datetime-local" className="form-control" value={to} onChange={e => { setTo(e.target.value); setEdited(true) }} {...fieldErrorProps(customError, `${id}-custom-error`)} />
            </Tooltip>
          </label>
          <FieldError id={`${id}-custom-error`} error={customError} />
          <button type="submit" className="btn btn-sm btn-primary" disabled={!rangeOk || customOver}>Show range</button>
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
 *
 * `limit`, `{ maxSpanMs, reason }`, is a page's longest window and the sentence that says how to
 * lift it, such as "Search for a cell, or for up to 40 devices, to see more than 7 days at once".
 * The control refuses what is longer, and says why where the person acted. A span over it stays in
 * the switch, `aria-disabled` and focusable, with the reason in its tooltip; pressing it changes
 * nothing and says the reason under the control. A rolling or custom range over it is refused in the
 * popover, and Zoom out is off with the reason in its tooltip. The window already shown is never
 * refused. When `limit` goes, the spans come back and the sentence clears.
 */
export function TimeWindowControl({
  value, onChange, ranges = TIME_PRESETS, allTime = false, spans = SPAN_IDS, label = 'Time window',
  zoom = false, extent = null, limit = null,
}) {
  useClockTick(CLOCK_MS)
  const now = Date.now()
  const [news, setNews] = useState('')
  const [refused, setRefused] = useState(false)
  const names = stepNames(value)
  const span = value.kind === 'calendar' ? value.span : null
  // A span whose window, chosen now, is over the limit; the one shown is not refused.
  const offered = SPANS.filter(s => spans.includes(s.id)).map(s => (
    limit && s.id !== span && overLimit(chooseSpan(value, s.id, now), limit, now) ? { ...s, unavailable: limit.reason } : s
  ))

  // The sentence goes when anything it was about changes: the window, or the limit itself.
  const windowKey = JSON.stringify(value)
  useEffect(() => { setRefused(false) }, [windowKey, limit?.maxSpanMs, limit?.reason])

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
  const outOver = canZoomOut(value, now, extent) && overLimit(zoomOut(value, now, extent), limit, now)

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
              limit={limit}
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
        onRefuse={() => setRefused(true)}
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
            off={!canZoomOut(value, now, extent) || outOver}
            reason={outOver ? limit.reason : outReason}
            onStep={() => show(zoomOut(value, now, extent), { replace: false })}
          >
            <IconZoomOut size={15} aria-hidden="true" />
          </WindowButton>
        </span>
      )}

      <FieldError error={refused && limit ? limit.reason : null} className="time-window-problem" />

      <div className="sr-only" role="status" aria-live="polite">{news}</div>
    </div>
  )
}
