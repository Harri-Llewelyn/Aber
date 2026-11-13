/**
 * The time control (common/TimeWindowControl.jsx) with the address it writes (useTimeWindow): what
 * each part is called, when an arrow is off and how it says why, the status line a step speaks,
 * the popover's three groups, and that no key is bound. In London's zone, on Monday 2 November
 * 2026 at 15:20, so every word is fixed.
 */
import React from 'react'
import { render, screen, fireEvent, within, act, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { TimeWindowControl } from '../components/common/TimeWindowControl'
import { useTimeWindow } from '../hooks/useTimeWindow'
import { ALL_TIME, TIME_PRESETS } from '../utils/timeWindow'
import { tooltipOf } from '../test/tooltips'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

/** A page's few lines: the window from the address, and the control that changes it. */
function Page() {
  const [win, setWin] = useTimeWindow({ ranges: TIME_PRESETS, allTime: true, fallback: ALL_TIME })
  return <TimeWindowControl value={win} onChange={setWin} ranges={TIME_PRESETS} allTime />
}

const show = (search = '') => {
  window.history.replaceState(null, '', `/audit-trail${search}`)
  render(<Page />)
}
const group = () => screen.getByRole('group', { name: 'Time window' })
const words = () => group().querySelector('.time-window-pick')
const arrow = (name) => within(group()).getByRole('button', { name })
const status = () => within(group()).getByRole('status')
const span = (name) => within(screen.getByRole('radiogroup', { name: 'Span' })).getByRole('radio', { name })
const choices = () => screen.getByRole('dialog', { name: 'Choose a time window' })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
})
afterEach(() => { vi.useRealTimers() })

describe('what the control is called', () => {
  it('is one group: the arrows by the span, the window in words and the span switch', () => {
    show('?span=day&at=2026-11-02')

    expect(arrow('Previous day')).toBeInTheDocument()
    expect(arrow('Next day')).toBeInTheDocument()
    expect(words()).toHaveTextContent('Today, Mon 2 Nov')
    expect(words()).toHaveAttribute('aria-haspopup', 'dialog')
    // A chevron says the words open a panel; Today is in it, not beside it.
    expect(words().querySelector('.popover-chevron')).not.toBeNull()
    expect(within(group()).queryByRole('button', { name: 'Today' })).toBeNull()
    expect(span('Day')).toHaveAttribute('aria-checked', 'true')
    // In that order, left to right.
    const order = [...group().querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent)
    expect(order).toEqual(['Previous day', 'Today, Mon 2 Nov', 'Next day', 'Day', 'Week', 'Month', 'Year'])
  })

  it('names the arrows Earlier and Later, and selects no span, under a rolling or custom window', () => {
    show('?range=1h')
    expect(arrow('Earlier')).toBeInTheDocument()
    expect(arrow('Later')).toBeInTheDocument()
    expect(words()).toHaveTextContent('Last 1 hour')
    for (const name of ['Day', 'Week', 'Month', 'Year']) expect(span(name)).toHaveAttribute('aria-checked', 'false')
  })
})

describe('when an arrow is off', () => {
  it('marks › off while the window holds now, keeps it focusable, and says why', () => {
    show('?span=week&at=2026-11-02')
    const next = arrow('Next week')

    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(next).not.toBeDisabled()
    expect(tooltipOf(next)).toMatch(/already reaches now/)
    fireEvent.click(next)
    expect(window.location.search).toBe('?span=week&at=2026-11-02')
    // ‹ is on, and its tooltip is its name, which is not read twice.
    expect(arrow('Previous week')).not.toHaveAttribute('aria-disabled')
    expect(tooltipOf(arrow('Previous week'))).toBeNull()
  })

  it('marks both off under All time', () => {
    show()
    expect(words()).toHaveTextContent('All time')
    for (const name of ['Earlier', 'Later']) {
      expect(arrow(name)).toHaveAttribute('aria-disabled', 'true')
      expect(tooltipOf(arrow(name))).toMatch(/nothing earlier or later/)
    }
  })
})

describe('a step', () => {
  it('moves by the span, writes span and at, and replaces the history entry', () => {
    show('?span=day&at=2026-11-02')
    const entries = window.history.length

    fireEvent.click(arrow('Previous day'))
    expect(window.location.search).toBe('?span=day&at=2026-11-01')
    expect(words()).toHaveTextContent('Sun 1 Nov')
    expect(arrow('Next day')).not.toHaveAttribute('aria-disabled')
    expect(window.history.length).toBe(entries)
  })

  it('is said in the polite status line, as each step is', () => {
    show('?span=day&at=2026-11-02')
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(status()).toHaveTextContent('')

    fireEvent.click(arrow('Previous day'))
    expect(status()).toHaveTextContent('Showing Sun 1 Nov')
    fireEvent.click(span('Week'))
    expect(status()).toHaveTextContent('Showing Mon 26 Oct – Sun 1 Nov')
    // Today is in the popover's Jump to; choosing it gives focus back to the words, which say it.
    fireEvent.click(words())
    fireEvent.click(within(choices()).getByRole('button', { name: 'Today' }))
    expect(words()).toHaveTextContent('Mon 2 Nov – Sun 8 Nov')
    expect(window.location.search).toBe('?span=week&at=2026-11-02')
  })

  it('turns a rolling window into a fixed one, and a span chosen under it into today', () => {
    show('?range=1h')
    fireEvent.click(arrow('Earlier'))
    expect(window.location.search).toBe('?from=2026-11-02T13%3A20&to=2026-11-02T14%3A20')
    expect(words()).toHaveTextContent('Mon 2 Nov, 13:20 – 14:20')
    expect(arrow('Later')).not.toHaveAttribute('aria-disabled')

    fireEvent.click(span('Day'))
    expect(words()).toHaveTextContent('Today, Mon 2 Nov')
  })

  it('binds no key: the arrow keys and [ and ] leave the window alone', () => {
    show('?span=day&at=2026-11-01')
    for (const key of ['ArrowLeft', 'ArrowRight', '[', ']']) fireEvent.keyDown(document, { key })
    expect(window.location.search).toBe('?span=day&at=2026-11-01')
  })
})

describe('the popover', () => {
  it('opens a dialog from the words, takes focus, and gives it back on Escape', () => {
    show('?span=day&at=2026-11-02')
    fireEvent.click(words())

    expect(words()).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(within(choices()).getByRole('button', { name: 'Today' }))
    for (const name of ['Jump to', 'Rolling', 'Custom range']) {
      expect(within(choices()).getByRole('group', { name })).toBeInTheDocument()
    }
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(words())
  })

  it('jumps keeping the span: in Week, a month ago is the week holding that day', () => {
    show('?span=week&at=2026-11-02')
    fireEvent.click(words())
    fireEvent.click(within(choices()).getByRole('button', { name: 'A month ago' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(words()).toHaveTextContent('Mon 28 Sept – Sun 4 Oct')
  })

  it('jumps to any other day from the date field', () => {
    show()
    fireEvent.click(words())
    const jump = within(choices()).getByRole('button', { name: 'Jump' })
    expect(jump).toBeDisabled()
    fireEvent.change(within(choices()).getByLabelText('Another day'), { target: { value: '2026-03-29' } })
    fireEvent.click(jump)

    expect(window.location.search).toBe('?span=day&at=2026-03-29')
    expect(words()).toHaveTextContent('Sun 29 Mar')
  })

  it('opens the custom range on the window shown, and shows a range typed into it', () => {
    show('?span=day&at=2026-11-01')
    fireEvent.click(words())
    expect(within(choices()).getByLabelText('From')).toHaveValue('2026-11-01T00:00')
    expect(within(choices()).getByLabelText('To')).toHaveValue('2026-11-02T00:00')

    fireEvent.change(within(choices()).getByLabelText('From'), { target: { value: '2026-11-01T10:05' } })
    fireEvent.change(within(choices()).getByLabelText('To'), { target: { value: '2026-11-01T14:20' } })
    fireEvent.click(within(choices()).getByRole('button', { name: 'Show range' }))

    expect(words()).toHaveTextContent('Sun 1 Nov, 10:05 – 14:20')
    expect(arrow('Earlier')).toBeInTheDocument()
  })

  it('marks the rolling range shown as chosen', () => {
    show('?range=7d')
    fireEvent.click(words())
    const rolling = within(choices()).getByRole('group', { name: 'Rolling' })
    expect(within(rolling).getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(rolling).getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('a page offering some spans', () => {
  const SOME_SPANS = ['day', 'week']
  const SOME_RANGES = TIME_PRESETS.slice(0, 2)
  function Narrow() {
    const [win, setWin] = useTimeWindow({ ranges: SOME_RANGES, fallback: ALL_TIME, spans: SOME_SPANS })
    return <TimeWindowControl value={win} onChange={setWin} ranges={SOME_RANGES} spans={SOME_SPANS} />
  }
  const narrow = (search = '') => {
    window.history.replaceState(null, '', `/logs${search}`)
    render(<Narrow />)
  }

  it('switches between those spans alone, and the arrows and the switch work as before', () => {
    narrow('?span=week&at=2026-11-02')
    const radios = within(screen.getByRole('radiogroup', { name: 'Span' })).getAllByRole('radio')
    expect(radios.map(r => r.textContent)).toEqual(['Day', 'Week'])
    expect(span('Week')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(arrow('Previous week'))
    expect(window.location.search).toBe('?span=week&at=2026-10-26')
    fireEvent.click(span('Day'))
    expect(window.location.search).toBe('?span=day&at=2026-10-26')
  })

  it('reads a span it does not offer as its fallback, and tidies the address', () => {
    narrow('?span=month&at=2026-11-02')
    expect(words()).toHaveTextContent('All time')
    expect(window.location.search).toBe('')
  })

  it('jumps from a rolling window to a day, a span it offers', () => {
    narrow('?range=1h')
    fireEvent.click(words())
    fireEvent.click(within(choices()).getByRole('button', { name: 'Yesterday' }))
    expect(window.location.search).toBe('?span=day&at=2026-11-01')
  })

  it('leaves the Audit Trail its four spans by default', () => {
    show('?span=year&at=2026-11-02')
    expect(within(screen.getByRole('radiogroup', { name: 'Span' })).getAllByRole('radio').map(r => r.textContent))
      .toEqual(['Day', 'Week', 'Month', 'Year'])
    expect(words()).toHaveTextContent('2026')
  })
})

describe('Zoom in and Zoom out', () => {
  /** A page that asks for the buttons, its axis drawing 09:00 to 13:00 under All time. */
  const AXIS = { start: new Date(2026, 10, 2, 9).getTime(), end: new Date(2026, 10, 2, 13).getTime() }
  function Zooming({ extent = AXIS }) {
    const [win, setWin] = useTimeWindow({ ranges: TIME_PRESETS, allTime: true, fallback: ALL_TIME })
    return <TimeWindowControl value={win} onChange={setWin} ranges={TIME_PRESETS} allTime zoom extent={extent} />
  }
  const zooming = (search = '', props = {}) => {
    window.history.replaceState(null, '', `/audit-trail${search}`)
    render(<Zooming {...props} />)
  }
  const zoom = (name) => within(within(group()).getByRole('group', { name: 'Zoom' })).getByRole('button', { name })

  afterEach(() => vi.restoreAllMocks())

  it('are offered only to a page that asks, after the span switch, with a tooltip each', () => {
    show('?span=day&at=2026-11-01')
    expect(within(group()).queryByRole('button', { name: 'Zoom in' })).toBeNull()
    cleanup()

    zooming('?span=day&at=2026-11-01')
    const order = [...group().querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent)
    expect(order.slice(-6)).toEqual(['Day', 'Week', 'Month', 'Year', 'Zoom in', 'Zoom out'])
    expect(tooltipOf(zoom('Zoom in'))).toMatch(/middle half/)
    expect(tooltipOf(zoom('Zoom out'))).toMatch(/twice as long/)
  })

  it('halve and double the window, say so, and each adds a history entry, so Back undoes it', async () => {
    zooming('?span=day&at=2026-11-01')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')

    fireEvent.click(zoom('Zoom in'))
    expect(window.location.search).toBe('?from=2026-11-01T06%3A00&to=2026-11-01T18%3A00')
    expect(words()).toHaveTextContent('Sun 1 Nov, 06:00 – 18:00')
    expect(status()).toHaveTextContent('Showing Sun 1 Nov, 06:00 – 18:00')
    fireEvent.click(zoom('Zoom out'))
    expect(window.location.search).toBe('?from=2026-11-01T00%3A00&to=2026-11-02T00%3A00')
    expect(push).toHaveBeenCalledTimes(2)
    expect(replace).not.toHaveBeenCalled()

    act(() => { window.history.back() })
    await waitFor(() => expect(words()).toHaveTextContent('Sun 1 Nov, 06:00 – 18:00'))
    act(() => { window.history.back() })
    await waitFor(() => expect(window.location.search).toBe('?span=day&at=2026-11-01'))
    expect(span('Day')).toHaveAttribute('aria-checked', 'true')
  })

  it('leave a step replacing the entry, as it did', () => {
    zooming('?span=day&at=2026-11-01')
    fireEvent.click(zoom('Zoom in'))
    const push = vi.spyOn(window.history, 'pushState')
    const entries = window.history.length

    fireEvent.click(arrow('Earlier'))
    expect(window.location.search).toBe('?from=2026-10-31T18%3A00&to=2026-11-01T06%3A00')
    fireEvent.click(span('Day'))
    expect(push).not.toHaveBeenCalled()
    expect(window.history.length).toBe(entries)
  })

  it('turn Zoom in off at a minute, focusable and saying why, and leave Zoom out on', () => {
    zooming('?from=2026-11-02T10%3A00&to=2026-11-02T10%3A01')
    const zoomInButton = zoom('Zoom in')
    expect(zoomInButton).toHaveAttribute('aria-disabled', 'true')
    expect(zoomInButton).not.toBeDisabled()
    expect(tooltipOf(zoomInButton)).toMatch(/one minute long, the narrowest/)
    fireEvent.click(zoomInButton)
    expect(window.location.search).toBe('?from=2026-11-02T10%3A00&to=2026-11-02T10%3A01')

    expect(zoom('Zoom out')).not.toHaveAttribute('aria-disabled')
    fireEvent.click(zoom('Zoom out'))
    expect(window.location.search).toBe('?from=2026-11-02T09%3A59%3A30&to=2026-11-02T10%3A01%3A30')
    expect(zoom('Zoom in')).not.toHaveAttribute('aria-disabled')
  })

  it('move a zoom out that would pass now back to end at the current minute', () => {
    zooming('?span=day&at=2026-11-02')
    fireEvent.click(zoom('Zoom out'))
    expect(window.location.search).toBe('?from=2026-10-31T15%3A21&to=2026-11-02T15%3A21')
    expect(arrow('Later')).toHaveAttribute('aria-disabled', 'true')
  })

  it('under All time, zoom in to the middle half of the axis drawn, and zoom out not at all', () => {
    zooming()
    expect(zoom('Zoom out')).toHaveAttribute('aria-disabled', 'true')
    expect(tooltipOf(zoom('Zoom out'))).toMatch(/nothing wider/)

    fireEvent.click(zoom('Zoom in'))
    expect(window.location.search).toBe('?from=2026-11-02T10%3A00&to=2026-11-02T12%3A00')
    expect(zoom('Zoom out')).not.toHaveAttribute('aria-disabled')
  })

  it('under All time with nothing drawn, have nothing to zoom into', () => {
    zooming('', { extent: null })
    expect(zoom('Zoom in')).toHaveAttribute('aria-disabled', 'true')
    expect(tooltipOf(zoom('Zoom in'))).toMatch(/Nothing is drawn/)
  })
})

describe('the clock', () => {
  it('turns › on once the day it held is over', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date(2026, 10, 2, 23, 59, 30))
    show('?span=day&at=2026-11-02')
    expect(arrow('Next day')).toHaveAttribute('aria-disabled', 'true')

    act(() => { vi.advanceTimersByTime(60 * 1000) })
    expect(arrow('Next day')).not.toHaveAttribute('aria-disabled')
  })
})

describe('a page with a limit', () => {
  const HOUR_MS = 60 * 60 * 1000
  // 7 days and the hour a week gains when the clocks go back, as Overview's and the Logs tab's are.
  const REASON = 'With more than 40 devices, this page shows 7 days at most. Search for a cell, or for up to 40 devices, to see a longer window.'
  const LIMIT = { maxSpanMs: 169 * HOUR_MS, reason: REASON }

  function Limited({ limit = LIMIT, zoom = false, allTime = false }) {
    const [win, setWin] = useTimeWindow({ ranges: TIME_PRESETS, allTime, fallback: ALL_TIME })
    return <TimeWindowControl value={win} onChange={setWin} ranges={TIME_PRESETS} allTime={allTime} zoom={zoom} limit={limit} />
  }
  const limited = (search = '', props = {}) => {
    window.history.replaceState(null, '', `/history${search}`)
    return render(<Limited {...props} />)
  }
  const alerts = () => within(group()).queryAllByRole('alert')
  const zoom = (name) => within(within(group()).getByRole('group', { name: 'Zoom' })).getByRole('button', { name })
  const rolling = () => within(choices()).getByRole('group', { name: 'Rolling' })
  const custom = () => within(choices()).getByRole('group', { name: 'Custom range' })

  describe('the span switch', () => {
    it('keeps a span over the limit, aria-disabled and focusable, and gives the reason in its tooltip', () => {
      limited('?span=day&at=2026-11-02')
      for (const name of ['Month', 'Year']) {
        expect(span(name)).toHaveAttribute('aria-disabled', 'true')
        expect(span(name)).not.toBeDisabled()
        expect(tooltipOf(span(name))).toBe(REASON)
      }
      span('Month').focus()
      expect(document.activeElement).toBe(span('Month'))
      for (const name of ['Day', 'Week']) expect(span(name)).not.toHaveAttribute('aria-disabled')
      expect(tooltipOf(span('Week'))).toBeNull()
    })

    it('shows the tooltip on focus, as the shared bubble does', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.focus(span('Year'))
      expect(screen.getByRole('tooltip')).toHaveTextContent(REASON)
    })

    it('changes nothing when pressed, and says the reason under the control', () => {
      limited('?span=day&at=2026-11-02')
      expect(alerts()).toHaveLength(0)

      fireEvent.click(span('Month'))
      expect(window.location.search).toBe('?span=day&at=2026-11-02')
      expect(span('Day')).toHaveAttribute('aria-checked', 'true')
      expect(span('Month')).toHaveAttribute('aria-checked', 'false')
      expect(words()).toHaveTextContent('Today, Mon 2 Nov')
      expect(alerts()).toHaveLength(1)
      expect(alerts()[0]).toHaveTextContent(REASON)
      // In the form fields' error style, and in the control's own box, under its row.
      expect(alerts()[0]).toHaveClass('form-hint', 'hint-danger', 'time-window-problem')
      expect(status()).toHaveTextContent('')
    })

    it('says it the same for the keyboard: Enter on the span', () => {
      limited('?span=day&at=2026-11-02')
      const year = span('Year')
      year.focus()
      fireEvent.click(year)
      expect(window.location.search).toBe('?span=day&at=2026-11-02')
      expect(alerts()[0]).toHaveTextContent(REASON)
    })

    it('clears the sentence when the window changes, and for a span that is allowed', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(span('Month'))
      expect(alerts()).toHaveLength(1)

      fireEvent.click(span('Week'))
      expect(window.location.search).toBe('?span=week&at=2026-11-02')
      expect(alerts()).toHaveLength(0)

      fireEvent.click(span('Year'))
      expect(alerts()).toHaveLength(1)
      fireEvent.click(arrow('Previous week'))
      expect(alerts()).toHaveLength(0)
    })

    it('brings the spans back, and clears the sentence, when the limit lifts', () => {
      const { rerender } = limited('?span=day&at=2026-11-02')
      fireEvent.click(span('Month'))
      expect(alerts()).toHaveLength(1)

      rerender(<Limited limit={null} />)
      expect(alerts()).toHaveLength(0)
      for (const name of ['Month', 'Year']) {
        expect(span(name)).not.toHaveAttribute('aria-disabled')
        expect(tooltipOf(span(name))).toBeNull()
      }
      fireEvent.click(span('Month'))
      expect(window.location.search).toBe('?span=month&at=2026-11-02')
    })

    it('does not bring the old sentence back when the limit returns', () => {
      const { rerender } = limited('?span=day&at=2026-11-02')
      fireEvent.click(span('Month'))
      rerender(<Limited limit={null} />)
      rerender(<Limited />)
      expect(alerts()).toHaveLength(0)
      expect(span('Month')).toHaveAttribute('aria-disabled', 'true')
    })

    it('leaves the span already shown alone, and a week holding a clock change, which is not over', () => {
      limited('?span=month&at=2026-11-02')
      expect(span('Month')).not.toHaveAttribute('aria-disabled')
      expect(span('Year')).toHaveAttribute('aria-disabled', 'true')
      cleanup()

      limited('?span=day&at=2026-10-21')
      expect(span('Week')).not.toHaveAttribute('aria-disabled')
    })

    it('marks every span under a rolling window by the window it would show', () => {
      limited('?range=30d')
      expect(span('Day')).not.toHaveAttribute('aria-disabled')
      expect(span('Week')).not.toHaveAttribute('aria-disabled')
      expect(span('Month')).toHaveAttribute('aria-disabled', 'true')
    })

    it('leaves a page without a limit as it was', () => {
      limited('?span=day&at=2026-11-02', { limit: null })
      for (const name of ['Day', 'Week', 'Month', 'Year']) expect(span(name)).not.toHaveAttribute('aria-disabled')
      fireEvent.click(span('Year'))
      expect(window.location.search).toBe('?span=year&at=2026-11-02')
      expect(alerts()).toHaveLength(0)
    })
  })

  describe('a rolling range', () => {
    it('over the limit is refused in the popover, marked as a span is, and the window stays', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(words())
      const over = within(rolling()).getByRole('button', { name: 'Last 30 days' })
      expect(over).toHaveAttribute('aria-disabled', 'true')
      expect(over).not.toBeDisabled()
      expect(tooltipOf(over)).toBe(REASON)
      expect(within(rolling()).queryByRole('alert')).toBeNull()

      fireEvent.click(over)
      expect(window.location.search).toBe('?span=day&at=2026-11-02')
      expect(screen.getByRole('dialog', { name: 'Choose a time window' })).toBeInTheDocument()
      expect(within(rolling()).getByRole('alert')).toHaveTextContent(REASON)
    })

    it('within the limit is chosen as before, 7 days among them', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(words())
      expect(within(rolling()).getByRole('button', { name: 'Last 7 days' })).not.toHaveAttribute('aria-disabled')
      fireEvent.click(within(rolling()).getByRole('button', { name: 'Last 7 days' }))
      expect(window.location.search).toBe('?range=7d')
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('shown already is not refused, and All time is, where a page offers it', () => {
      limited('?range=30d', { allTime: true })
      fireEvent.click(words())
      expect(within(rolling()).getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(rolling()).getByRole('button', { name: 'Last 30 days' })).not.toHaveAttribute('aria-disabled')
      const all = within(rolling()).getByRole('button', { name: 'All time' })
      expect(all).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(all)
      expect(window.location.search).toBe('?range=30d')
      expect(within(rolling()).getByRole('alert')).toHaveTextContent(REASON)
    })
  })

  describe('a custom range', () => {
    const type = (from, to) => {
      fireEvent.change(within(choices()).getByLabelText('From'), { target: { value: from } })
      fireEvent.change(within(choices()).getByLabelText('To'), { target: { value: to } })
    }
    const show = () => within(choices()).getByRole('button', { name: 'Show range' })

    it('over the limit is refused by the range picker, with the reason, and the window stays', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(words())
      expect(within(custom()).queryByRole('alert')).toBeNull()

      type('2026-10-20T00:00', '2026-11-02T00:00')
      expect(within(custom()).getByRole('alert')).toHaveTextContent(REASON)
      expect(show()).toBeDisabled()
      fireEvent.click(show())
      fireEvent.submit(show().closest('form'))
      expect(window.location.search).toBe('?span=day&at=2026-11-02')
      expect(screen.getByRole('dialog', { name: 'Choose a time window' })).toBeInTheDocument()
    })

    it('takes a range as long as the limit, and clears the sentence as it comes under it', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(words())
      type('2026-10-20T00:00', '2026-11-02T00:00')
      expect(within(custom()).getByRole('alert')).toBeInTheDocument()

      type('2026-10-26T00:00', '2026-11-02T01:00')
      expect(within(custom()).queryByRole('alert')).toBeNull()
      expect(show()).toBeEnabled()
      fireEvent.click(show())
      expect(window.location.search).toBe('?from=2026-10-26T00%3A00&to=2026-11-02T01%3A00')
    })

    it('says nothing on opening, even when the window shown is over the limit', () => {
      limited('?span=month&at=2026-11-02')
      fireEvent.click(words())
      expect(within(choices()).getByLabelText('From')).toHaveValue('2026-11-01T00:00')
      expect(within(custom()).queryByRole('alert')).toBeNull()
      // It is the window shown, so it is still over: Show range waits for an edit.
      expect(show()).toBeDisabled()
    })

    it('waits for both ends, as it did, before it says anything about the length', () => {
      limited('?span=day&at=2026-11-02')
      fireEvent.click(words())
      type('2026-10-01T00:00', '')
      expect(within(custom()).queryByRole('alert')).toBeNull()
      expect(show()).toBeDisabled()
    })
  })

  describe('Zoom out', () => {
    it('is off where the window it would show is over the limit, focusable, with the reason as its tooltip', () => {
      limited('?from=2026-10-28T00%3A00&to=2026-11-02T00%3A00', { zoom: true })
      const out = zoom('Zoom out')
      expect(out).toHaveAttribute('aria-disabled', 'true')
      expect(out).not.toBeDisabled()
      expect(tooltipOf(out)).toBe(REASON)
      fireEvent.click(out)
      expect(window.location.search).toBe('?from=2026-10-28T00%3A00&to=2026-11-02T00%3A00')
      expect(zoom('Zoom in')).not.toHaveAttribute('aria-disabled')
    })

    it('is on below it, and still twice the window', () => {
      limited('?from=2026-10-29T00%3A00&to=2026-11-01T00%3A00', { zoom: true })
      expect(zoom('Zoom out')).not.toHaveAttribute('aria-disabled')
      expect(tooltipOf(zoom('Zoom out'))).toMatch(/twice as long/)
      fireEvent.click(zoom('Zoom out'))
      expect(window.location.search).toBe('?from=2026-10-27T12%3A00&to=2026-11-02T12%3A00')
    })

    it('comes back when the limit lifts', () => {
      const { rerender } = limited('?from=2026-10-28T00%3A00&to=2026-11-02T00%3A00', { zoom: true })
      expect(zoom('Zoom out')).toHaveAttribute('aria-disabled', 'true')
      rerender(<Limited limit={null} zoom />)
      expect(zoom('Zoom out')).not.toHaveAttribute('aria-disabled')
    })

    it('keeps the reason it had for a window with no bounds, which a limit does not change', () => {
      limited('', { zoom: true, allTime: true })
      expect(tooltipOf(zoom('Zoom out'))).toMatch(/nothing wider/)
    })
  })
})
