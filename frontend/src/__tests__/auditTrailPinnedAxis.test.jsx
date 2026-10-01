import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

/**
 * The date row stays in view. The timeline scrolls inside the card rather than with the page, and
 * the axis row pins to the top of that scroller with the section headings under it, so a reader
 * deep in a long section still has the dates and knows which section they are in.
 *
 * `position: sticky; top: 0` on its own would have done nothing: the lanes' scroller was already a
 * scroll container for the horizontal axis (overflow-y: hidden), so a sticky descendant resolved
 * against a box that never moved vertically. Asserted through the stylesheet, because jsdom does
 * no layout and the failure is silent.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

const ruleFor = (selector) => {
  const escaped = selector.replace(/[.:()\-*+?^${}|[\]\\>]/g, '\\$&')
  return APP_CSS.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\n\\}`))?.[1]
}

const zIndex = (rule) => Number(/z-index:\s*(-?\d+)/.exec(rule)?.[1])

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Press_01', last_birth_metrics: [] }]
const EVENTS = [{
  event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
  timestamp: '2026-08-02T00:00:00Z', changed_by: 'user-1', actor_source: 'user',
  old_data: { id: 'dev-1', status: 'OFFLINE' }, new_data: { id: 'dev-1', status: 'ONLINE' }
}]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => {
    if (p.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (p.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

describe('the timeline scrolls inside the card', () => {
  it('caps the page at the viewport and lets only the lanes give way', () => {
    /* A chain of flex columns from the page down to the scroller, every link able to shrink and
       everything beside the scroller refusing to. A maximum, not a height: a short trail gets a
       short card. */
    expect(ruleFor('.page-fill')).toMatch(/height:\s*100%/)
    expect(ruleFor('.page-fill > .page-main')).toMatch(/max-height:\s*100%/)
    expect(ruleFor('.page-fill > .page-main > .card-fill')).toMatch(/min-height:\s*0/)
    expect(ruleFor('.card-fill > *')).toMatch(/flex-shrink:\s*0/)
    expect(ruleFor('.card-fill > .trail-timeline')).toMatch(/flex-direction:\s*column/)
    expect(ruleFor('.trail-timeline > :not(.trail-scroll)')).toMatch(/flex-shrink:\s*0/)
    expect(ruleFor('.trail-timeline > .trail-scroll')).toMatch(/min-height:\s*0/)
  })

  it('scrolls the lanes in both directions rather than the page', () => {
    const rule = ruleFor('.trail-scroll')
    expect(rule).toMatch(/overflow-x:\s*auto/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
    expect(rule).not.toMatch(/overflow-y:\s*hidden/)
  })

  it('marks the page and the timeline body so the chain has something to hang from', async () => {
    render(<AuditTrailTab />)
    await waitFor(() => expect(screen.getByText('Press_01')).toBeInTheDocument())
    expect(document.querySelector('.page-layout')).toHaveClass('page-fill')
    const body = document.querySelector('.trail-timeline')
    expect(body).toHaveClass('card-body', 'card-fill-scroll')
    expect(body.querySelector('.trail-scroll')).toBeTruthy()
  })
})

describe('the axis row stays in view', () => {
  it('pins to the top of the scroller, opaque, above the labels that would ride over it', () => {
    const axis = ruleFor('.trail-lane.trail-axis')
    expect(axis).toMatch(/position:\s*sticky/)
    expect(axis).toMatch(/top:\s*0/)
    // Opaque, or the rows show through the dates as they pass under.
    expect(axis).toMatch(/background:\s*var\(--bg-base\)/)
    expect(zIndex(axis)).toBeGreaterThan(zIndex(ruleFor('.trail-lane-label')))
  })

  it('leaves the track inside it bare, because a scale is not a lane', () => {
    // The row is what is opaque; boxing the tick labels like data would make the ruler read as
    // another asset.
    expect(ruleFor('.trail-axis-track')).not.toMatch(/background/)
    expect(ruleFor('.trail-axis-track')).not.toMatch(/border/)
  })

  it('pins the section headings under it, from the one declared axis height', () => {
    /* The heading's offset and the axis track's height read one custom property, so a change to
       either cannot leave a heading pinned into the dates. Above the lane labels: its own lanes
       come after it in the DOM and would otherwise paint over it as they scroll under. */
    const section = ruleFor('.trail-section')
    expect(section).toMatch(/top:\s*calc\(var\(--trail-axis-height\)/)
    expect(ruleFor('.trail-axis-track')).toMatch(/height:\s*var\(--trail-axis-height\)/)
    expect(ruleFor('.trail-swimlanes')).toMatch(/--trail-axis-height:\s*\d+px/)
    expect(zIndex(section)).toBeGreaterThan(zIndex(ruleFor('.trail-lane-label')))
    // A row of the grid, so only the row's own border box pins: no margin above it to pin dead
    // space under the axis, and no padding to hide a row of labels with.
    expect(section).not.toMatch(/margin/)
    expect(section).not.toMatch(/padding/)
    expect(section).toMatch(/border-bottom:\s*1px solid var\(--border\)/)
  })

  it('keeps every marker under the labels and the headings it passes', () => {
    /* Badges carry z-index 3 and the active ring 4, the same numbers as the heading and above the
       label's 2, and in one stacking context the later element wins -- so a badge scrolling under
       a pinned heading or sideways under a sticky label painted over it. Each track is its own
       stacking context, which keeps those numbers inside the track. */
    expect(ruleFor('.trail-track')).toMatch(/isolation:\s*isolate/)
    expect(zIndex(ruleFor('.trail-track'))).toBeNaN()
    expect(zIndex(ruleFor('.trail-track .trail-cluster'))).toBeGreaterThanOrEqual(zIndex(ruleFor('.trail-section')))
  })

  it('draws the header rows on the base surface, not the thead tint', () => {
    /* The pinned date row and the pinned heading under it read as one header system. The `thead`
       tint they first took is 2% black in the light theme, which on a white card is no band at
       all; the base surface is a header band in both themes. The label column of each row is
       opaque in its own right and takes the same colour, or it would sit as a block of a
       different colour at the left of the row. */
    const base = /background:\s*var\(--bg-base\)/
    for (const selector of ['.trail-lane.trail-axis', '.trail-axis .trail-lane-label', '.trail-section', '.trail-section .trail-lane-label']) {
      expect(ruleFor(selector), selector).toMatch(base)
      expect(ruleFor(selector), selector).not.toMatch(/background-image/)
    }
    // And the tables' own headers are on the same surface, so tables and the timeline match.
    expect(APP_CSS).toMatch(/\nthead tr,\nthead th \{\s*background:\s*var\(--bg-base\);/)
  })
})
