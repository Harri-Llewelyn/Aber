/**
 * Audit Trail: how the event drawer steps. ← and → move along the open lane (its kind and id, so a
 * device and its nameplate are two lanes), oldest first and in write order inside a transaction;
 * ↑ and ↓ move to the lane drawn above or below, at its event nearest in time; the four buttons do
 * the same, stay focusable at an end and say why in the shared tooltip; a status line says what
 * each step opened; the selected marker is scrolled into view after every step; and every key
 * stands down while a dialog is open.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuditTrailTab, byTimeThenId, nearestInTime } from '../components/tabs/AuditTrailTab'
import { shortcutGroups } from '../components/modals/ShortcutsModal'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Line 1 Gateway', devices: [] }]
const DEVICES = ['Press_04', 'Press_05', 'Press_06', 'Press_07']
  .map((asset_name, i) => ({ asset_id: `dev-${i + 4}`, asset_name, last_birth_metrics: [] }))

const at = (hhmm) => `2026-08-21T${hhmm}:00Z`
const row = (event_id, entity_type, entity_id, time, extra = {}) => ({
  event_id, entity_type, entity_id, event_type: 'UPDATE', timestamp: at(time),
  description: `Action UPDATE on ${entity_type} [${entity_id}]`, changed_by: 'user-1', actor_source: 'user',
  old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' }, ...extra,
})

/*
 * Drawn, top to bottom (busiest first inside a section, then by name):
 *   1 Line 1 Gateway   (Gateways)
 *   2 Press_04         (Devices)   09:00 10:00 11:00
 *   3 Press_05                     08:00 10:20 10:40
 *   4 Press_07                     10:30 x3, one transaction (ids 50-52)
 *   5 Press_06                     10:30
 *   6 Press_04         (Device nameplates, the same id as the device)  09:30 10:30
 * Served newest first, as the RPC returns them.
 */
const TX = { causation_id: 9001, transaction_rows: 3 }
const EVENTS = [
  row(1, 'devices', 'dev-4', '09:00'), row(2, 'devices', 'dev-4', '10:00'), row(3, 'devices', 'dev-4', '11:00'),
  row(10, 'devices', 'dev-5', '08:00'), row(11, 'devices', 'dev-5', '10:20'), row(12, 'devices', 'dev-5', '10:40'),
  row(52, 'devices', 'dev-7', '10:30', TX), row(51, 'devices', 'dev-7', '10:30', TX), row(50, 'devices', 'dev-7', '10:30', TX),
  row(20, 'devices', 'dev-6', '10:30'),
  row(30, 'device_nameplate', 'dev-4', '09:30'), row(31, 'device_nameplate', 'dev-4', '10:30'),
  row(40, 'gateways', 'gw-1', '12:00'),
].sort((a, b) => byTimeThenId(b, a))

let served = EVENTS
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/audit-trail')
  served = EVENTS
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(served)
    if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    return Promise.resolve([])
  })
})
afterEach(() => { document.querySelectorAll('.probe-dialog').forEach(d => d.remove()) })

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getAllByText('Press_04').length).toBeGreaterThan(0))
}
const hhmm = (time) => new Date(at(time)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
/** A marker by its lane's name and its time; the device lane and the nameplate lane differ in time. */
const marker = (name, time) => screen.getByRole('button', { name: `UPDATE on ${name} at ${new Date(at(time)).toLocaleString()}` })
const open = async (name, time) => {
  fireEvent.click(marker(name, time))
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
}
const position = () => document.querySelector('.trail-drawer-nav-pos')?.textContent ?? ''
const openEvent = () => new URLSearchParams(window.location.search).get('event')
const news = () => document.querySelector('.trail-drawer-nav [role="status"]')
const press = (key, target = document) => fireEvent.keyDown(target, { key })
const nav = () => within(document.querySelector('.trail-drawer-nav-btns'))
const button = (name) => nav().getByRole('button', { name })
const settle = () => new Promise(r => setTimeout(r, 20))

describe('the helpers', () => {
  it('orders by time, then by id inside one transaction', () => {
    const tx = EVENTS.filter(e => e.entity_id === 'dev-7').sort(byTimeThenId)
    expect(tx.map(e => e.event_id)).toEqual([50, 51, 52])
  })

  it('picks the event nearest in time, and the earlier of two as near', () => {
    const lane = EVENTS.filter(e => e.entity_id === 'dev-5').sort(byTimeThenId)
    expect(nearestInTime(lane, at('10:05')).event_id).toBe(11)
    expect(nearestInTime(lane, at('10:30')).event_id).toBe(11)
    expect(nearestInTime(lane, at('23:00')).event_id).toBe(12)
    expect(nearestInTime([], at('10:00'))).toBeNull()
  })
})

describe('← and → step along the open lane', () => {
  it('counts and steps through the lane, not every row with the entity\'s id', async () => {
    // Press_04's nameplate events share its id; the device lane has three events, not five.
    await show()
    await open('Press_04', '09:00')
    expect(position()).toBe('Event 1 of 3 · Entity 2 of 6')

    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('2'))
    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('3'))
    expect(position()).toBe('Event 3 of 3 · Entity 2 of 6')
    press('ArrowRight')
    await settle()
    expect(openEvent(), 'Next ran on into the nameplate lane').toBe('3')
  })

  it('runs through one transaction in the order its rows were written, as its badge does', async () => {
    await show()
    fireEvent.click(screen.getAllByRole('button', { name: /UPDATE on Press_07/ })[0])
    await waitFor(() => expect(openEvent()).toBe('50'))
    expect(position()).toMatch(/^Event 1 of 3/)
    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('51'))
    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('52'))
    press('ArrowLeft')
    await waitFor(() => expect(openEvent()).toBe('51'))
  })
})

describe('↑ and ↓ move between lanes', () => {
  it('open the lane below\'s event nearest in time, and come back the same way', async () => {
    await show()
    await open('Press_04', '10:00')
    press('ArrowDown')
    await waitFor(() => expect(openEvent()).toBe('11'))   // Press_05 at 10:20, not 08:00 or 10:40
    expect(position()).toBe('Event 2 of 3 · Entity 3 of 6')
    press('ArrowUp')
    await waitFor(() => expect(openEvent()).toBe('2'))
    expect(position()).toBe('Event 2 of 3 · Entity 2 of 6')
  })

  it('opens the earlier of two equally near events', async () => {
    // From 10:30 on Press_07, Press_05's 10:20 and 10:40 are ten minutes either side.
    await show()
    fireEvent.click(screen.getAllByRole('button', { name: /UPDATE on Press_07/ })[0])
    await waitFor(() => expect(openEvent()).toBe('50'))
    press('ArrowUp')
    await waitFor(() => expect(openEvent()).toBe('11'))
  })

  it('opens the first row of a transaction, which is what its badge opens', async () => {
    await show()
    await open('Press_05', '10:20')
    press('ArrowDown')
    await waitFor(() => expect(openEvent()).toBe('50'))
  })

  it('crosses section headings in the order drawn, and stops at the first and last lane', async () => {
    await show()
    await open('Press_06', '10:30')
    press('ArrowDown')
    // From the last Devices lane to the first lane of the next section: the nameplate, at 10:30.
    await waitFor(() => expect(openEvent()).toBe('31'))
    expect(position()).toBe('Event 2 of 2 · Entity 6 of 6')
    press('ArrowDown')
    await settle()
    expect(openEvent(), 'wrapped round to the top').toBe('31')

    for (let i = 0; i < 5; i++) press('ArrowUp')
    await waitFor(() => expect(openEvent()).toBe('40'))
    expect(position()).toBe('Event 1 of 1 · Entity 1 of 6')
    press('ArrowUp')
    await settle()
    expect(openEvent(), 'wrapped round to the bottom').toBe('40')
  })

  it('follows the lane order on screen when the key is pressed', async () => {
    await show()
    await open('Press_06', '10:30')
    expect(position()).toBe('Event 1 of 1 · Entity 5 of 6')

    // Press_06 gains three events and becomes the busiest lane, drawn first in its section. A
    // change of filter and back fetches the trail again.
    served = [...EVENTS, row(21, 'devices', 'dev-6', '07:00'), row(22, 'devices', 'dev-6', '07:10'), row(23, 'devices', 'dev-6', '07:20')]
      .sort((a, b) => byTimeThenId(b, a))
    const filters = screen.getByRole('button', { name: /^Filters/ })
    fireEvent.click(filters)
    fireEvent.change(screen.getByRole('combobox', { name: 'Entity' }), { target: { value: 'DEVICE' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Entity' }), { target: { value: '' } })
    fireEvent.click(filters)
    await waitFor(() => expect(position()).toBe('Event 4 of 4 · Entity 2 of 6'))
    expect(screen.queryByRole('dialog')).toBeNull()

    press('ArrowDown')
    // Press_04, now third: 10:00 and 11:00 are as near to 10:30, and the earlier opens.
    await waitFor(() => expect(openEvent()).toBe('2'))
    expect(position()).toBe('Event 2 of 3 · Entity 3 of 6')
  })

  it('keep the timeline from scrolling while the drawer is open, and only then', async () => {
    await show()
    expect(press('ArrowDown'), 'prevented with the drawer shut').toBe(true)
    await open('Press_04', '09:00')
    expect(press('ArrowDown')).toBe(false)
    expect(press('ArrowUp')).toBe(false)
    // At an end there is nowhere to go, and the key still does not scroll.
    await open('Line 1 Gateway', '12:00')
    expect(press('ArrowUp')).toBe(false)
    expect(press('PageDown'), 'Page Down still scrolls').toBe(true)
  })
})

describe('the four buttons', () => {
  it('name their keys, and read as their words rather than their glyphs', async () => {
    await show()
    await open('Press_04', '10:00')
    expect(button('Previous')).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft')
    expect(button('Next')).toHaveAttribute('aria-keyshortcuts', 'ArrowRight')
    expect(button('Previous Entity')).toHaveAttribute('aria-keyshortcuts', 'ArrowUp')
    expect(button('Next Entity')).toHaveAttribute('aria-keyshortcuts', 'ArrowDown')
    expect(button('Previous Entity')).toHaveAccessibleDescription('Move to Line 1 Gateway, the entity above, at the same point in time (↑)')
    expect(button('Next Entity')).toHaveAccessibleDescription('Move to Press_05, the entity below, at the same point in time (↓)')
    // The shared tooltip, not the browser's.
    for (const b of nav().getAllByRole('button')) expect(b).not.toHaveAttribute('title')
  })

  it('step between lanes as the keys do', async () => {
    await show()
    await open('Press_04', '10:00')
    fireEvent.click(button('Next Entity'))
    await waitFor(() => expect(openEvent()).toBe('11'))
    fireEvent.click(button('Previous Entity'))
    await waitFor(() => expect(openEvent()).toBe('2'))
  })

  it('stay focusable at an end, do nothing when pressed, and say why on focus', async () => {
    await show()
    await open('Press_04', '09:00')
    const previous = button('Previous')
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    expect(previous).not.toBeDisabled()
    act(() => previous.focus())
    expect(document.activeElement).toBe(previous)
    expect(screen.getByRole('tooltip')).toHaveTextContent('This is the oldest recorded change to this entity')

    fireEvent.click(previous)
    await settle()
    expect(openEvent()).toBe('1')
    expect(button('Next')).not.toHaveAttribute('aria-disabled')
  })

  it('say at the first and last lane that there is no entity beyond', async () => {
    await show()
    await open('Line 1 Gateway', '12:00')
    expect(button('Previous Entity')).toHaveAttribute('aria-disabled', 'true')
    expect(button('Previous Entity')).toHaveAccessibleDescription('This is the first entity on the trail')
    fireEvent.click(button('Previous Entity'))
    await settle()
    expect(openEvent()).toBe('40')

    await open('Press_04', '10:30')   // the nameplate lane, last
    expect(button('Next Entity')).toHaveAttribute('aria-disabled', 'true')
    expect(button('Next Entity')).toHaveAccessibleDescription('This is the last entity on the trail')
  })

  it('say Previous ends at the oldest change loaded while Show more has older ones', async () => {
    served = Object.assign([...EVENTS], { nextCursor: { recorded_at: at('08:00'), id: 10 } })
    await show()
    await open('Press_04', '09:00')
    expect(button('Previous')).toHaveAccessibleDescription(
      'This is the oldest change loaded. Show more, at the foot of the trail, loads older ones.')
  })

  it('say so when older changes exist that this view cannot reach', async () => {
    served = Object.assign([...EVENTS], { truncated: true })
    await show()
    await open('Press_04', '09:00')
    expect(button('Previous')).toHaveAccessibleDescription(
      'This is the oldest change loaded. There are older ones this view cannot reach.')
  })
})

describe('the status line', () => {
  it('says nothing when a marker opens the drawer, then what each step opened', async () => {
    await show()
    await open('Press_04', '09:00')
    const line = news()
    expect(line).toHaveAttribute('role', 'status')
    expect(line).toHaveAttribute('aria-live', 'polite')
    expect(line).toHaveTextContent(/^$/)

    press('ArrowRight')
    await waitFor(() => expect(line).toHaveTextContent(`Event 2 of 3: Updated, ${hhmm('10:00')}, Press_04`))

    press('ArrowDown')
    await waitFor(() => expect(line).toHaveTextContent(
      `Entity 3 of 6, Press_05. Event 2 of 3: Updated, ${hhmm('10:20')}`))

    fireEvent.click(button('Next'))
    await waitFor(() => expect(line).toHaveTextContent(`Event 3 of 3: Updated, ${hhmm('10:40')}, Press_05`))
    // The same element throughout: a reader announces a change to a live region it already knows.
    expect(news()).toBe(line)

    fireEvent.click(marker('Press_06', '10:30'))
    await waitFor(() => expect(openEvent()).toBe('20'))
    expect(news()).toHaveTextContent(/^$/)
  })
})

describe('the selected marker is scrolled into view', () => {
  let scrolled
  let original
  beforeEach(() => {
    original = Element.prototype.scrollIntoView
    scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
  })
  afterEach(() => { Element.prototype.scrollIntoView = original })

  it('after every step, by key or button', async () => {
    await show()
    await open('Press_04', '09:00')
    expect(scrolled, 'a click is already on screen').not.toHaveBeenCalled()

    press('ArrowRight')
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1))
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(scrolled.mock.contexts[0]).toBe(marker('Press_04', '10:00'))

    press('ArrowDown')
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(2))
    expect(scrolled.mock.contexts[1]).toBe(marker('Press_05', '10:20'))

    fireEvent.click(button('Previous'))
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(3))
    expect(scrolled.mock.contexts[2]).toBe(marker('Press_05', '08:00'))
  })
})

describe('the keys stand down', () => {
  it('while a dialog is open, a popover\'s or a native one', async () => {
    await show()
    await open('Press_04', '09:00')

    const popover = document.createElement('div')
    popover.setAttribute('role', 'dialog')
    popover.className = 'probe-dialog'
    document.body.append(popover)
    press('ArrowRight'); press('ArrowDown')
    await settle()
    expect(openEvent()).toBe('1')
    popover.remove()

    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    dialog.className = 'probe-dialog'
    document.body.append(dialog)
    press('ArrowRight'); press('ArrowUp')
    await settle()
    expect(openEvent()).toBe('1')
    dialog.remove()

    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('2'))
  })

  it('for a key a control on the page has already taken', async () => {
    render(<><AuditTrailTab /><button type="button" onKeyDown={e => e.preventDefault()}>Takes its arrows</button></>)
    await waitFor(() => expect(screen.getAllByText('Press_04').length).toBeGreaterThan(0))
    await open('Press_04', '09:00')
    press('ArrowRight', screen.getByRole('button', { name: 'Takes its arrows' }))
    await settle()
    expect(openEvent()).toBe('1')
  })
})

describe('the shortcuts list', () => {
  it('has a row for ↑ and ↓ in its Audit Trail group, beside ← and →', () => {
    const group = shortcutGroups().find(g => g.title === 'Audit Trail')
    const rows = group.items.map(i => [i.keys.join(' '), i.join, i.description])
    expect(rows).toContainEqual(['↑ ↓', 'or', 'Move to the entity above or below, at the same point in time'])
    expect(rows.map(r => r[0])).toContain('← →')
  })
})
