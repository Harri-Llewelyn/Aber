/**
 * The time control (common/TimeWindowControl.jsx) with the address it writes (useTimeWindow): what
 * each part is called, when an arrow is off and how it says why, the status line a step speaks,
 * the popover's three groups, and that no key is bound. In London's zone, on Monday 2 November
 * 2026 at 15:20, so every word is fixed.
 */
import React from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
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
