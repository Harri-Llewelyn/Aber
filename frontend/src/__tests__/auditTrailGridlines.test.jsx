import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

/**
 * The vertical gridlines: one faint dotted line under each axis tick, down every row, so an event
 * on one lane can be read against the same instant on another. What is guarded is agreement --
 * that a line and its tick are placed by one formula -- because a line that drifts from its label
 * is worse than no line.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.:()\-*+?^${}|[\]\\>]/g, '\\$&')
  return APP_CSS.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1]
}

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Press_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

/* Two lanes and a span of a day, so the five ticks land at five distinct positions. Dated and never
   refreshed: the default range is All time. */
const EVENTS = [
  {
    event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-02T00:00:00Z', changed_by: 'user-1', actor_source: 'user',
    old_data: { id: 'dev-1', status: 'OFFLINE' }, new_data: { id: 'dev-1', status: 'ONLINE' }
  },
  {
    event_id: 2, entity_type: 'devices', entity_id: 'dev-2', event_type: 'UPDATE',
    timestamp: '2026-08-03T00:00:00Z', changed_by: 'user-1', actor_source: 'user',
    old_data: { id: 'dev-2', status: 'OFFLINE' }, new_data: { id: 'dev-2', status: 'ONLINE' }
  }
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => {
    if (p.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (p.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Press_01')).toBeInTheDocument())
}

describe('the gridlines under the axis ticks', () => {
  it('draws one line per tick, at exactly the position of its tick', async () => {
    await show()
    const ticks = [...document.querySelectorAll('.dt-tick')]
    const lines = [...document.querySelectorAll('.dt-gridline')]
    expect(ticks.length).toBe(5)
    expect(lines.length).toBe(ticks.length)
    ticks.forEach((tick, i) => {
      // Character-identical, not merely close: both come out of one helper.
      expect(tick.style.left).toMatch(/^calc\(14px/)
      expect(lines[i].style.left).toBe(tick.style.left)
    })
  })

  it('draws the lines once behind the rows, not once per lane', async () => {
    await show()
    const layers = document.querySelectorAll('.dt-gridlines')
    expect(layers.length).toBe(1)
    // Under the axis, inside the box that holds every row, and after them so the first section
    // stays the body's first child.
    const body = document.querySelector('.dt-swimlanes > .dt-lane.dt-axis + .dt-body')
    expect(body).toBeTruthy()
    expect(body.lastElementChild).toBe(layers[0])
    expect(body.firstElementChild).toHaveClass('dt-section')
    expect(layers[0].getAttribute('aria-hidden')).toBe('true')
  })

  it('spans the track column and nothing else, from the widths the lanes are laid out with', () => {
    /* jsdom lays nothing out, so the agreement is asserted through the stylesheet: the layer's
       left edge is the label width plus the lane gap, the same two custom properties the label
       and the lane read, so the three cannot drift apart. */
    expect(ruleFor('.dt-gridlines')).toMatch(/left:\s*calc\(var\(--dt-label-width\) \+ var\(--dt-lane-gap\)\)/)
    expect(ruleFor('.dt-lane-label')).toMatch(/flex:\s*0 0 var\(--dt-label-width\)/)
    expect(ruleFor('.dt-lane')).toMatch(/gap:\s*var\(--dt-lane-gap\)/)
    expect(ruleFor('.dt-swimlanes')).toMatch(/--dt-label-width:\s*260px/)
  })

  it('is inert and behind everything', () => {
    expect(ruleFor('.dt-gridlines')).toMatch(/pointer-events:\s*none/)
    expect(ruleFor('.dt-gridlines')).toMatch(/z-index:\s*-1/)
    // Which only works inside a stacking context of the body's own; without it, -1 is behind the
    // card and the lines vanish.
    expect(ruleFor('.dt-body')).toMatch(/isolation:\s*isolate/)
    expect(ruleFor('.dt-gridline')).toMatch(/dotted/)
  })
})
