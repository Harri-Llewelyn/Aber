import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotificationHistory } from '../components/common/NotificationHistory'
import { useToast } from '../hooks/useToast'

/**
 * The notification list's filter. What is pinned: four segments under the heading, All and the
 * three groups, each named with its count and titled the same; choosing one narrows the list, and
 * a group with nothing in it says so; the filter is back on All each time the panel opens; only the
 * entries on show are marked read; Clear still empties everything and says so while filtered; and
 * the filter is one Tab stop whose arrow keys choose.
 */

const NOW = Date.parse('2026-10-15T12:00:00Z')
const entry = (id, msg, type, group, over = {}) => ({ id, msg, type, group, at: NOW - id * 1000, read: false, count: 1, ...over })

const ENTRIES = [
  entry(6, 'Saved', 'success', 'info'),
  entry(5, 'Resolved — Spindle Overtemperature', 'success', 'alert'),
  entry(4, 'Save failed', 'error', 'warning'),
  entry(3, 'Spindle Overtemperature', 'error', 'alert'),
  entry(2, 'Device discovered', 'info', 'info'),
  // Stored before groups: its type puts it in Warning.
  { id: 1, msg: 'Cap reached', type: 'warning', at: NOW - 1000, read: false, count: 1 }
]

const bell = () => screen.getByRole('button', { name: /^notifications/i })
const panel = () => screen.getByRole('dialog', { name: 'Notifications' })
const filter = () => within(panel()).getByRole('radiogroup', { name: 'Show' })
const segment = (name) => within(filter()).getByRole('radio', { name })
const listed = () => within(panel()).queryAllByRole('listitem').map(li => li.querySelector('.notif-item-msg').lastChild.textContent)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('the filter', () => {
  it('sits under the heading with All and the three groups, each named with its count', () => {
    render(<NotificationHistory entries={ENTRIES} />)
    fireEvent.click(bell())
    const top = panel().querySelector('.notif-panel-top')
    expect(top.querySelector('.notif-panel-head')).toHaveTextContent('Notifications')
    expect(top.contains(filter())).toBe(true)

    const radios = within(filter()).getAllByRole('radio')
    expect(radios.map(r => r.getAttribute('aria-label'))).toEqual(['All, 6', 'Info, 2', 'Warnings, 2', 'Alerts, 2'])
    for (const r of radios) expect(r).toHaveAttribute('title', r.getAttribute('aria-label'))
    expect(segment('All, 6')).toHaveAttribute('aria-checked', 'true')
    expect(radios.every(r => r.querySelector('svg'))).toBe(true)
  })

  it('narrows the list to one group, an entry stored before groups included', () => {
    render(<NotificationHistory entries={ENTRIES} />)
    fireEvent.click(bell())
    expect(listed()).toHaveLength(6)

    fireEvent.click(segment('Alerts, 2'))
    expect(listed()).toEqual(['Resolved — Spindle Overtemperature', 'Spindle Overtemperature'])
    fireEvent.click(segment('Warnings, 2'))
    expect(listed()).toEqual(['Save failed', 'Cap reached'])
    fireEvent.click(segment('Info, 2'))
    expect(listed()).toEqual(['Saved', 'Device discovered'])
  })

  it('says so when the chosen group has nothing in it', () => {
    render(<NotificationHistory entries={ENTRIES.filter(e => e.group !== 'alert')} />)
    fireEvent.click(bell())
    fireEvent.click(segment('Alerts, 0'))
    expect(listed()).toEqual([])
    expect(panel()).toHaveTextContent('No alerts in this list.')
    expect(panel()).toHaveTextContent('What is firing now is in the alert counter.')
  })

  it('is not drawn while the list is empty', () => {
    render(<NotificationHistory entries={[]} />)
    fireEvent.click(bell())
    expect(within(panel()).queryByRole('radiogroup')).toBeNull()
    expect(panel()).toHaveTextContent('No notifications')
  })

  it('is back on All each time the panel opens', () => {
    render(<NotificationHistory entries={ENTRIES} />)
    fireEvent.click(bell())
    fireEvent.click(segment('Alerts, 2'))
    fireEvent.click(bell())
    fireEvent.click(bell())
    expect(segment('All, 6')).toHaveAttribute('aria-checked', 'true')
    expect(listed()).toHaveLength(6)

    fireEvent.click(segment('Info, 2'))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(bell())
    expect(segment('All, 6')).toHaveAttribute('aria-checked', 'true')
  })

  it('is one Tab stop, and its arrow keys move and choose', () => {
    render(<NotificationHistory entries={ENTRIES} />)
    fireEvent.click(bell())
    expect(within(filter()).getAllByRole('radio').map(r => r.tabIndex)).toEqual([0, -1, -1, -1])
    act(() => { segment('All, 6').focus() })
    fireEvent.keyDown(segment('All, 6'), { key: 'ArrowRight' })
    expect(segment('Info, 2')).toHaveFocus()
    expect(listed()).toEqual(['Saved', 'Device discovered'])
    // The arrows stay inside the panel, so it stays open.
    expect(panel()).toBeInTheDocument()
  })
})

describe('Clear while filtered', () => {
  it('still empties the whole list, and its tooltip says so', () => {
    const onClear = vi.fn()
    render(<NotificationHistory entries={ENTRIES} onClear={onClear} />)
    fireEvent.click(bell())
    const clear = within(panel()).getByRole('button', { name: 'Clear' })
    expect(clear).toHaveAttribute('title', 'Empty this list. The toasts on screen stay.')

    fireEvent.click(segment('Alerts, 2'))
    expect(clear).toHaveAttribute('title', 'Empty the whole list, not only the alerts shown. The toasts on screen stay.')
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('reading what the filter shows', () => {
  let hook
  function Wired() {
    hook = useToast()
    return <NotificationHistory entries={hook.history} onMarkRead={hook.markRead} onClear={hook.clearHistory} />
  }
  beforeEach(() => window.sessionStorage.clear())
  afterEach(() => window.sessionStorage.clear())

  it('marks only the entries on show read while a filter is on', () => {
    render(<Wired />)
    act(() => { hook.showToast('Spindle Overtemperature', 'error', { group: 'alert' }) })
    fireEvent.click(bell())
    expect(hook.history.every(e => e.read)).toBe(true)
    fireEvent.click(segment('Alerts, 1'))

    // A save reported while the alerts are shown is not on show, so it stays unread...
    act(() => { hook.showToast('Saved', 'success') })
    expect(hook.history.find(e => e.msg === 'Saved').read).toBe(false)
    expect(document.querySelector('.notif-badge')).toHaveTextContent('1')
    // ...and another alert is.
    act(() => { hook.showToast('Belt Slip', 'warning', { group: 'alert' }) })
    expect(hook.history.find(e => e.msg === 'Belt Slip').read).toBe(true)

    // Back on All, it is read too.
    fireEvent.click(segment(/^All/))
    expect(hook.history.every(e => e.read)).toBe(true)
    expect(document.querySelector('.notif-badge')).toBeNull()
  })
})
