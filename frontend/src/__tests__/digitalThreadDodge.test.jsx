/**
 * Digital Thread: markers that would sit on top of each other.
 *
 * WHAT WAS REPORTED. "Most of the assets only appear to have one event, a green created event, even
 * though they also have a blue operational event that occurred seconds later. The first event
 * overlaps the second, making it appear that assets only have one event."
 *
 * The report also named the obvious fix and its cost -- spacing the events out along the axis would
 * distort when they happened. It would, and worse than the report supposed:
 *
 *   * A horizontal nudge is ZOOM-DEPENDENT. Over a ten-hour range 8px reads as twelve minutes; over
 *     a one-hour range the same 8px reads as one. The same pair would look different distances
 *     apart depending on the range control.
 *   * It would ERASE THE CAUSATION SIGNAL. Rows written in one transaction share a timestamp
 *     exactly, so perfect overlap is the visual signature of one act.
 *
 * So the displacement is VERTICAL. Inside a lane the y axis encodes nothing -- every marker is
 * otherwise pinned to the centre line -- so moving along it costs no information and leaves x
 * exactly where the timestamp puts it. These tests pin that: no test here asserts anything about
 * horizontal position, because nothing about it changes.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DigitalThreadTab, dodgeOffsets, DODGE_STEP_PX, DODGE_SLOTS
} from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

const WIDTH = 1000

/** Events at given fractions along the track. */
const at = (...fractions) => fractions.map((f, i) => ({ event_id: i + 1, f }))
const xOf = (e) => e.f
const offsets = (events, width = WIDTH) =>
  events.map(e => dodgeOffsets(events, xOf, width).get(e.event_id))


describe('markers that do not collide are left alone', () => {
  it('puts a lone marker on the lane centre line', () => {
    expect(offsets(at(0.5))).toEqual([0])
  })

  it('leaves well-separated markers on the line', () => {
    // 0.2 apart on a 1000px track is 200px -- nowhere near the 15px collision width.
    expect(offsets(at(0.1, 0.3, 0.5))).toEqual([0, 0, 0])
  })

  it('treats markers just outside the collision width as separate', () => {
    // 16px apart: wider than a marker, so both are already visible.
    expect(offsets(at(0, 0.016))).toEqual([0, 0])
  })
})


describe('colliding markers fan out vertically', () => {
  it('separates a pair, centred on the line', () => {
    /*
     * THE REPORTED CASE: a Created and an Operational seconds apart, which at an all-time range
     * land on the same pixel. Symmetric about the centre so the pair reads as one group sitting on
     * the lane rule rather than as markers that have slipped off it.
     */
    expect(offsets(at(0.5, 0.5001))).toEqual([-DODGE_STEP_PX / 2, DODGE_STEP_PX / 2])
  })

  it('separates a triple', () => {
    expect(offsets(at(0.5, 0.5, 0.5))).toEqual([-DODGE_STEP_PX, 0, DODGE_STEP_PX])
  })

  it('keeps the fan inside the lane', () => {
    /*
     * The track is 32px and a marker is 13px plus a 2px ring, so the fan may span at most 31px.
     * A fourth slot would clip at the lane boundary, which is why DODGE_SLOTS is 3.
     */
    const spread = offsets(at(0.5, 0.5, 0.5))
    const span = Math.max(...spread) - Math.min(...spread) + 15
    expect(span).toBeLessThanOrEqual(32)
  })

  it('handles simultaneous events, which is the causation case', () => {
    // Rows written in one transaction carry the same timestamp exactly.
    expect(offsets(at(0.4, 0.4))).toEqual([-DODGE_STEP_PX / 2, DODGE_STEP_PX / 2])
  })
})


describe('the collision test is chained, not measured from the start of the cluster', () => {
  it('treats a continuous run as one pile', () => {
    /*
     * Each 10px from the last, so every pair overlaps -- but the last is 30px from the first.
     * Testing against the cluster's START would split this into groups that still overlap at
     * their seams, which is the bug that shape of the algorithm invites.
     */
    const events = at(0, 0.01, 0.02, 0.03)
    const result = offsets(events)

    expect(new Set(result).size).toBeGreaterThan(1)
    // Four in a three-slot fan: the fourth cycles back, which is documented rather than prevented.
    expect(result[3]).toBe(result[0])
  })

  it('starts a new cluster once the gap opens up', () => {
    // Two tight pairs, far apart from each other.
    const result = offsets(at(0.1, 0.1005, 0.8, 0.8005))
    expect(result[0]).toBe(result[2])
    expect(result[1]).toBe(result[3])
    expect(result[0]).not.toBe(result[1])
  })
})


describe('width is measured, and an unmeasured track dodges nothing', () => {
  it('leaves every marker on the line when the width is unknown', () => {
    /*
     * NOT DODGING IS THE STATUS QUO; guessing a width would move markers by an amount unrelated to
     * whether they actually collide. This is also the jsdom path -- `offsetWidth` is 0 with no
     * layout engine -- which is why this function is tested directly rather than through the DOM.
     */
    expect(offsets(at(0.5, 0.5, 0.5), 0)).toEqual([0, 0, 0])
  })

  it('is width-dependent, because whether two markers touch is a question about pixels', () => {
    /*
     * The same two timestamps, at two viewport widths. On a narrow track they overlap; on a wide
     * one they are comfortably apart. A hardcoded fraction would have to be wrong at one of them.
     */
    const events = at(0.5, 0.51)
    expect(dodgeOffsets(events, xOf, 400).get(1)).not.toBe(0)   // 4px apart -- collide
    expect(dodgeOffsets(events, xOf, 4000).get(1)).toBe(0)      // 40px apart -- do not
  })
})


describe('input order does not decide the fan', () => {
  it('assigns slots by position, not by the order events arrived', () => {
    // The API returns newest first; the fan should read the same either way.
    const forward = at(0.5, 0.5005, 0.501)
    const backward = [...forward].reverse().map((e, i) => ({ ...e, event_id: e.event_id }))

    const a = dodgeOffsets(forward, xOf, WIDTH)
    const b = dodgeOffsets(backward, xOf, WIDTH)

    for (const e of forward) expect(a.get(e.event_id)).toBe(b.get(e.event_id))
  })
})


describe('the constants the CSS depends on', () => {
  it('exposes a step and slot count the lane can accommodate', () => {
    expect(DODGE_SLOTS).toBe(3)
    expect(DODGE_STEP_PX).toBeGreaterThan(0)
    // A marker is 15px including its ring; the step must be smaller or the fan would not overlap
    // at all and would need more room than the lane has.
    expect(DODGE_STEP_PX).toBeLessThan(15)
  })
})


/*
 * The wiring, exercised through the DOM.
 *
 * Everything above tests `dodgeOffsets` directly, which leaves one thing unasserted: whether the
 * component actually APPLIES it. jsdom reports `offsetWidth: 0` for every element, so the real page
 * takes the no-measurement path in tests and no amount of pure-function coverage would notice a
 * component that computed the offsets and then dropped them.
 *
 * So the measurement is stubbed and the rendered markers are read back.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

describe('the component applies the fan to the rendered markers', () => {
  const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] }]

  /*
   * THREE EVENTS, AND THE THIRD IS LOAD-BEARING. The x axis is scaled to the events themselves, so
   * a fixture of only the two close ones would put them at fractions 0 and 1 -- at opposite ends of
   * the track, colliding with nothing, and the test would pass while proving the opposite of what
   * it claims. The distant third stretches the domain to nine hours, which is what makes two events
   * two seconds apart land on the same pixel: the reported situation.
   */
  const EVENTS = [
    {
      event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'INSERT',
      timestamp: '2026-08-21T09:00:00Z', description: 'created',
      changed_by: null, actor_source: 'user', old_data: null, new_data: { name: 'Simulated_CNC_01' }
    },
    {
      event_id: 2, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
      timestamp: '2026-08-21T09:00:02Z', description: 'went online',
      changed_by: null, actor_source: 'ingestion',
      old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
      new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
    },
    {
      event_id: 3, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
      timestamp: '2026-08-21T18:00:00Z', description: 'much later',
      changed_by: null, actor_source: 'ingestion',
      old_data: { name: 'Simulated_CNC_01', status: 'ONLINE' },
      new_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' }
    }
  ]

  /** The fraction out of `calc(14px + <f> * (100% - 28px))`, however jsdom reorders it. */
  const fractionOf = (left) => Number(/([\d.e-]+)\s*\*|\*\s*([\d.e-]+)/.exec(left)?.slice(1).find(Boolean) ?? NaN)

  let originalOffsetWidth

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
      if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
      return Promise.resolve([])
    })
    /*
     * jsdom has no layout, so `offsetWidth` is 0 everywhere and the component takes its
     * no-measurement path. Stubbed for the track only, which is the element it measures.
     */
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList?.contains('dt-track') ? 1000 : 0 }
    })
  })

  afterEach(() => {
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
    }
  })

  const nodes = () => [...document.querySelectorAll('.dt-node')]

  const draw = async () => {
    render(<DigitalThreadTab />)
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
    await waitFor(() => expect(nodes()).toHaveLength(3))
  }

  it('gives two near-simultaneous events different vertical positions', async () => {
    await draw()
    const byId = nodes().sort((a, b) => fractionOf(a.style.left) - fractionOf(b.style.left))

    expect(byId[0].style.top).not.toBe(byId[1].style.top)
    for (const n of [byId[0], byId[1]]) expect(n.style.top).toContain('50%')
  })

  it('leaves the distant event on the centre line', async () => {
    // It collides with nothing, so it must not be moved. A fan applied to everything would be as
    // wrong as no fan at all -- it would imply structure where there is none.
    await draw()
    const last = nodes().sort((a, b) => fractionOf(a.style.left) - fractionOf(b.style.left))[2]

    expect(last.style.top).toBe('')
  })

  it('leaves horizontal position untouched, which is the whole point', async () => {
    /*
     * THE PROPERTY THE FIX EXISTS TO PRESERVE. The two close markers must still sit essentially on
     * top of each other horizontally -- two seconds out of nine hours -- because the displacement
     * is vertical precisely so the time axis keeps telling the truth. If a future change nudged
     * them apart along x, this is what would catch it.
     */
    await draw()
    const fractions = nodes().map(n => fractionOf(n.style.left)).sort((a, b) => a - b)

    expect(fractions[1] - fractions[0]).toBeLessThan(0.001)
    expect(fractions[2]).toBeCloseTo(1, 5)
  })

  it('applies the fan even though the timeline does not exist on first paint', async () => {
    /*
     * THE BUG THIS CAUGHT, and it would have shipped invisibly. The measurement began as a
     * `useEffect` with `[]` deps -- which runs while the page is still showing its spinner, finds
     * no track to measure, records a width of 0, and never runs again. The dodge was then disabled
     * permanently, on a page that looked exactly as it did before the change.
     *
     * Asserted as "some marker moved after the fetch resolved", which is only possible if the
     * width was measured at a moment later than mount.
     */
    await draw()
    expect(nodes().some(n => n.style.top !== '')).toBe(true)
  })
})
