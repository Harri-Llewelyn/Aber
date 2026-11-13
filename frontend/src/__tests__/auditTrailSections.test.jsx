/**
 * Audit Trail: sections close. Each heading is a disclosure button (GroupHeading) with its lane
 * count; a closed section draws one summary track holding every event of its lanes, clustered as a
 * lane is, and opening an event there opens the section too. Expand all and Collapse all open or
 * close them together; which are closed is kept in this browser, not in the address; ↑ and ↓ skip
 * a closed section's lanes, and the open event stays selected on the summary track.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuditTrailTab, byTimeThenId, CLOSED_SECTIONS_KEY } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

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
 * Drawn, top to bottom:
 *   Gateways           1 Line 1 Gateway   12:00
 *   Devices            2 Press_04         09:00 10:00 11:00
 *                      3 Press_05         08:00 10:20 10:40
 *                      4 Press_07         10:30 x3, one transaction (ids 50-52)
 *                      5 Press_06         10:30
 *   Device nameplates  6 Press_04         09:30 10:30
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
const DEVICE_EVENTS = EVENTS.filter(e => e.entity_type === 'devices').length

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/audit-trail')
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    return Promise.resolve([])
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getAllByText('Press_04').length).toBeGreaterThan(0))
}
/** A section's heading button, by the section's name. */
const heading = (name) => {
  const found = [...document.querySelectorAll('.trail-section .group-heading')]
    .filter(b => b.querySelector('.group-heading-label')?.textContent === name)
  expect(found, `one heading named ${name}`).toHaveLength(1)
  return found[0]
}
const toggle = (name) => fireEvent.click(heading(name))
const closedTrack = (name) => heading(name).closest('.trail-section').querySelector('.trail-track')
const marker = (name, time) => screen.getByRole('button', { name: `UPDATE on ${name} at ${new Date(at(time)).toLocaleString()}` })
const openEvent = () => new URLSearchParams(window.location.search).get('event')
const position = () => document.querySelector('.trail-drawer-nav-pos')?.textContent ?? ''
const press = (key) => fireEvent.keyDown(document, { key })

describe('a section heading', () => {
  it('is a disclosure button with a chevron, the section and its lane count', async () => {
    await show()
    const devices = heading('Devices')
    expect(devices.tagName).toBe('BUTTON')
    expect(devices).toHaveAccessibleName('Devices, 4 lanes')
    expect(heading('Gateways')).toHaveAccessibleName('Gateways, 1 lane')
    expect(devices.querySelector('.group-heading-chevron')).toBeTruthy()
    expect(devices).toHaveAttribute('aria-expanded', 'true')
    // It controls the box its lanes are in.
    const lanes = document.getElementById(devices.getAttribute('aria-controls'))
    expect(lanes).toHaveAttribute('role', 'group')
    expect(lanes).toHaveAccessibleName('Devices lanes')
    expect(within(lanes).getAllByRole('button', { name: /^Open the latest change to/ })).toHaveLength(4)
  })

  it('closes its lanes and opens them again', async () => {
    await show()
    toggle('Devices')
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'false')
    const lanes = document.getElementById(heading('Devices').getAttribute('aria-controls'))
    expect(lanes).not.toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open the latest change to Press_05' })).toBeNull()
    // The other sections are untouched.
    expect(screen.getByRole('button', { name: 'Open the latest change to Line 1 Gateway' })).toBeInTheDocument()

    toggle('Devices')
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Open the latest change to Press_05' })).toBeInTheDocument()
  })
})

describe('a closed section', () => {
  it('draws one summary track holding every event of its lanes', async () => {
    await show()
    toggle('Devices')
    const track = closedTrack('Devices')
    // jsdom measures no width, so nothing clusters: one marker per event.
    expect(track.querySelectorAll('.trail-node')).toHaveLength(DEVICE_EVENTS)
    expect(within(track).getByRole('button', { name: `UPDATE on Press_05 at ${new Date(at('08:00')).toLocaleString()}` }))
      .toBeInTheDocument()
  })

  describe('at a width that clusters', () => {
    let offsetWidth
    beforeEach(() => {
      offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() { return this.classList?.contains('trail-track') ? 1000 : 0 },
      })
    })
    afterEach(() => {
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    })

    it('clusters across lanes as a lane does, with the same breakdown in its tooltip', async () => {
      await show()
      toggle('Devices')
      /* 10:30 holds Press_07's three rows and Press_06's one: on their lanes a badge of three and
         a marker; on the closed track one badge of four. */
      const badge = [...closedTrack('Devices').querySelectorAll('.trail-cluster')].find(b => b.textContent === '4')
      expect(badge).toBeTruthy()
      expect(badge).toHaveAccessibleName(`4 events in Devices from ${new Date(at('10:30')).toLocaleString()} — open the first`)
      expect(tooltipOf(badge)).toMatch(/^4 events: 4 Operational\n/)
      expect(document.querySelector('.trail-legend').textContent).toMatch(/Grouped \(1\)/)
    })

    it('opens the first event of a badge, and the section with it', async () => {
      await show()
      toggle('Devices')
      const badge = [...closedTrack('Devices').querySelectorAll('.trail-cluster')].find(b => b.textContent === '4')
      fireEvent.click(badge)
      await waitFor(() => expect(openEvent()).toBe('20'))
      expect(heading('Devices')).toHaveAttribute('aria-expanded', 'true')
    })
  })

  it('opens an event picked on it in the drawer, and opens the section to show its lane', async () => {
    await show()
    toggle('Devices')
    fireEvent.click(within(closedTrack('Devices')).getByRole('button', { name: `UPDATE on Press_05 at ${new Date(at('10:20')).toLocaleString()}` }))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    expect(openEvent()).toBe('11')
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'true')
    // Now on its lane, and lit there.
    expect(marker('Press_05', '10:20')).toHaveAttribute('aria-pressed', 'true')
    expect(marker('Press_05', '10:20').closest('.trail-lane')).toBeTruthy()
  })
})

describe('Expand all and Collapse all', () => {
  it('closes every section, then opens every one, with the toggle Metrics and Vocabulary use', async () => {
    await show()
    const control = within(document.querySelector('.groups-header')).getByRole('button', { name: /Collapse all/ })
    // Outlined: a filter control, as on Metrics and Vocabulary.
    expect(control).toHaveClass('btn-ghost')
    fireEvent.click(control)
    for (const name of ['Gateways', 'Devices', 'Device nameplates']) {
      expect(heading(name)).toHaveAttribute('aria-expanded', 'false')
    }
    expect(document.querySelectorAll('.trail-lane:not(.trail-axis)')).toHaveLength(0)

    fireEvent.click(within(document.querySelector('.groups-header')).getByRole('button', { name: /Expand all/ }))
    for (const name of ['Gateways', 'Devices', 'Device nameplates']) {
      expect(heading(name)).toHaveAttribute('aria-expanded', 'true')
    }
    expect(document.querySelectorAll('.trail-lane:not(.trail-axis)')).toHaveLength(6)
  })

  it('reads Collapse all while any section is open', async () => {
    await show()
    toggle('Devices')
    expect(within(document.querySelector('.groups-header')).getByRole('button', { name: /Collapse all/ })).toBeInTheDocument()
  })
})

describe('which sections are closed', () => {
  it('is every section open on a first visit', async () => {
    await show()
    expect(screen.getAllByRole('button', { expanded: false }).filter(b => b.classList.contains('group-heading'))).toHaveLength(0)
  })

  it('is kept in this browser, not in the address', async () => {
    await show()
    toggle('Devices')
    expect(JSON.parse(window.localStorage.getItem(CLOSED_SECTIONS_KEY))).toEqual(['DEVICE'])
    expect(window.location.search).toBe('')

    cleanup()
    await show()
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'false')
    expect(heading('Gateways')).toHaveAttribute('aria-expanded', 'true')

    // Open again, the key goes rather than holding an empty list.
    toggle('Devices')
    expect(window.localStorage.getItem(CLOSED_SECTIONS_KEY)).toBeNull()
  })

  it('opens every section, and still closes them, where storage is refused', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refused') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('refused') })
    await show()
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'true')
    toggle('Devices')
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'false')
  })

  it('ignores a stored value it did not write', async () => {
    window.localStorage.setItem(CLOSED_SECTIONS_KEY, '{"DEVICE": true}')
    await show()
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('↑ and ↓ with a section closed', () => {
  it('skip the closed section\'s lanes', async () => {
    await show()
    fireEvent.click(marker('Line 1 Gateway', '12:00'))
    await waitFor(() => expect(openEvent()).toBe('40'))
    toggle('Devices')
    expect(position()).toBe('Event 1 of 1 · Entity 1 of 2')

    press('ArrowDown')
    // Past the four device lanes to the nameplate, at its event nearest 12:00.
    await waitFor(() => expect(openEvent()).toBe('31'))
    expect(position()).toBe('Event 2 of 2 · Entity 2 of 2')
    press('ArrowUp')
    await waitFor(() => expect(openEvent()).toBe('40'))
  })

  it('keep the open event selected on the summary track when its section closes', async () => {
    await show()
    fireEvent.click(marker('Press_05', '10:20'))
    await waitFor(() => expect(openEvent()).toBe('11'))
    toggle('Devices')

    // Still open in the drawer, and lit where its section is drawn now.
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
    const lit = within(closedTrack('Devices')).getByRole('button', { name: `UPDATE on Press_05 at ${new Date(at('10:20')).toLocaleString()}` })
    expect(lit).toHaveAttribute('aria-pressed', 'true')
    // Its place along the lane still counts; it has no place among the drawn lanes.
    expect(position()).toBe('Event 2 of 3')

    // ← and → still step along its lane, on the summary track.
    press('ArrowRight')
    await waitFor(() => expect(openEvent()).toBe('12'))
    expect(heading('Devices')).toHaveAttribute('aria-expanded', 'false')

    // ↑ and ↓ leave it for the open lanes either side.
    press('ArrowUp')
    await waitFor(() => expect(openEvent()).toBe('40'))
  })

  it('say why there is no entity to step to when every one past it is closed', async () => {
    await show()
    fireEvent.click(marker('Line 1 Gateway', '12:00'))
    await waitFor(() => expect(openEvent()).toBe('40'))
    toggle('Devices')
    toggle('Device nameplates')
    const next = within(document.querySelector('.trail-drawer-nav-btns')).getByRole('button', { name: 'Next Entity' })
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(tooltipOf(next)).toBe('Every entity below this one is in a closed section')
  })
})
