/**
 * Digital Thread: events too close together to draw separately.
 *
 * WHAT WAS REPORTED. "Most of the assets only appear to have one event, a green created event, even
 * though they also have a blue operational event that occurred seconds later. The first event
 * overlaps the second, making it appear that assets only have one event."
 *
 * THE FIRST ANSWER WAS A VERTICAL FAN, and these tests are the second. The fan displaced colliding
 * markers up and down off the lane's centre line, which fixed the reported pair and then failed
 * where the page is most interesting: the track is 32px and a marker is 15px with its ring, so it
 * had three slots and a fourth event cycled back into the first and overlapped anyway. Worse, three
 * fanned dots and five fanned dots look alike -- and "how many happened here" is the question being
 * asked. A badge carrying the count answers it at any density.
 *
 * WHAT DID NOT CHANGE, and what several tests below exist to keep that way:
 *
 *   * X IS UNTOUCHED. A badge sits at the mean of its members' positions, so the time axis still
 *     tells the truth. Nudging markers apart along time would be zoom-dependent -- 8px reads as
 *     twelve minutes over a ten-hour range and as one minute over an hour.
 *   * THE CAUSATION SIGNAL SURVIVES, and is now stated rather than implied. Rows written in one
 *     transaction share a timestamp exactly, so they always land in one badge; the hover says "One
 *     transaction" when every member shares a causation_id, which a pile of dots could only hint at.
 *   * THE THRESHOLD IS IN PIXELS. That is what makes the range control a zoom: narrow it and the
 *     same events move further apart on screen until the badge dissolves into its members.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DigitalThreadTab, clusterEvents, clusterSummary, CLUSTER_GAP_PX
} from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

const WIDTH = 1000

/** Events at given fractions along the track. */
const at = (...fractions) => fractions.map((f, i) => ({ event_id: i + 1, f }))
const xOf = (e) => e.f
const items = (events, width = WIDTH) => clusterEvents(events, xOf, width)
/** Each drawn item as its member count -- `[1, 3, 1]` is a dot, a badge of three, a dot. */
const shape = (events, width = WIDTH) => items(events, width).map(i => i.events.length)


describe('events that do not touch are drawn as themselves', () => {
  it('draws a lone event as a single marker', () => {
    const [only] = items(at(0.5))
    expect(only.isCluster).toBe(false)
    expect(only.events).toHaveLength(1)
    expect(only.xOffset).toBe(0.5)
  })

  it('leaves well-separated events alone', () => {
    // 0.2 apart on a 1000px track is 200px -- nowhere near the collision width.
    expect(shape(at(0.1, 0.3, 0.5))).toEqual([1, 1, 1])
  })

  it('treats events just outside the collision width as separate', () => {
    // 15px apart: wider than a marker, so both are already distinguishable.
    expect(shape(at(0, 0.015))).toEqual([1, 1])
  })

  it('groups events exactly at the threshold, which is where they start touching', () => {
    expect(shape(at(0, CLUSTER_GAP_PX / WIDTH))).toEqual([2])
  })
})


describe('events that pile up become one badge carrying the count', () => {
  it('groups the reported pair', () => {
    /*
     * THE REPORTED CASE: a Created and an Operational seconds apart, which at an all-time range
     * land on the same pixel. One badge reading 2, rather than one dot that looks like one event.
     */
    const [group] = items(at(0.5, 0.5001))
    expect(group.isCluster).toBe(true)
    expect(group.events.map(e => e.event_id)).toEqual([1, 2])
  })

  it('groups a burst larger than the fan could hold, which is why the fan was replaced', () => {
    /*
     * SIX. The vertical fan had three slots and cycled the rest back through them, so a
     * commissioning burst -- routinely five or six rows -- was drawn as three dots with the
     * remainder hidden underneath, and nothing on the page said so. The badge simply reads 6.
     */
    expect(shape(at(0.5, 0.5, 0.5, 0.5, 0.5, 0.5))).toEqual([6])
  })

  it('handles simultaneous events, which is the causation case', () => {
    // Rows written in one transaction carry the same timestamp exactly, so they can never be
    // separated by any amount of zooming -- they must land in one badge at every range.
    expect(shape(at(0.4, 0.4))).toEqual([2])
  })

  it('puts the badge at the group centre, not on its earliest member', () => {
    // A badge is wider than a dot and stands for all of them; hanging it off the first would sit
    // it left of the events it represents.
    const [group] = items(at(0.500, 0.502))
    expect(group.xOffset).toBeCloseTo(0.501, 6)
  })

  it('draws every event exactly once, whether or not it was grouped', () => {
    /*
     * THE INVARIANT THAT MATTERS MOST. A badge is allowed to hide events visually; it is not
     * allowed to lose them. If clustering ever dropped a member, the page would under-report an
     * audit log -- which is the one thing this page exists not to do.
     */
    const events = at(0, 0.001, 0.002, 0.4, 0.9, 0.9005)
    const drawn = items(events).flatMap(i => i.events.map(e => e.event_id))

    expect(drawn.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  })
})


describe('the collision test is chained, not measured from the start of the group', () => {
  it('treats a continuous run as one pile', () => {
    /*
     * Each 10px from the last, so every pair overlaps -- but the last is 30px from the first.
     * Testing against the group's START would split this into badges that still overlap at their
     * seams, which is the bug that shape of the algorithm invites.
     */
    expect(shape(at(0, 0.01, 0.02, 0.03))).toEqual([4])
  })

  it('starts a new group once the gap opens up', () => {
    // Two tight pairs, far apart from each other.
    expect(shape(at(0.1, 0.1005, 0.8, 0.8005))).toEqual([2, 2])
  })

  it('mixes badges and single markers in one lane', () => {
    expect(shape(at(0.1, 0.1005, 0.5, 0.9))).toEqual([2, 1, 1])
  })
})


describe('width is measured, and an unmeasured track groups nothing', () => {
  it('draws every event singly when the width is unknown', () => {
    /*
     * NOT GROUPING IS THE STATUS QUO; guessing a width would fold together markers that do not
     * actually touch. This is also the jsdom path -- `offsetWidth` is 0 with no layout engine --
     * which is why this function is tested directly as well as through the DOM.
     */
    expect(shape(at(0.5, 0.5, 0.5), 0)).toEqual([1, 1, 1])
  })

  it('is width-dependent, because whether two markers touch is a question about pixels', () => {
    /*
     * The same two positions at two viewport widths. On a narrow track they overlap; on a wide one
     * they are comfortably apart. A hardcoded fraction would have to be wrong at one of them.
     */
    const events = at(0.5, 0.51)
    expect(shape(events, 400)).toEqual([2])       // 4px apart -- one badge
    expect(shape(events, 4000)).toEqual([1, 1])   // 40px apart -- two dots
  })
})


describe('order is decided by position, not by the order events arrived', () => {
  it('reads the same whichever way the API returned them', () => {
    // `/api/v1/digital-thread` returns newest first.
    const forward = at(0.5, 0.5005, 0.501)
    const backward = [...forward].reverse()

    expect(items(forward)[0].events.map(e => e.event_id))
      .toEqual(items(backward)[0].events.map(e => e.event_id))
  })

  it('breaks a tie on event_id, so a badge opens on the first row the transaction wrote', () => {
    /*
     * `recorded_at` is transaction START time, so every row of one act carries the same timestamp
     * and sorting by position alone leaves them in whatever order they arrived. `event_id` is the
     * order the rows were WRITTEN -- the same tiebreak causationSiblings() uses, and for the same
     * reason: inside one act that is the order it performed them.
     */
    const scrambled = [{ event_id: 9, f: 0.5 }, { event_id: 3, f: 0.5 }, { event_id: 7, f: 0.5 }]
    expect(items(scrambled)[0].events.map(e => e.event_id)).toEqual([3, 7, 9])
  })

  it('exposes the earliest member as the one a click opens', () => {
    const [group] = items(at(0.5, 0.5002, 0.5004))
    expect(group.event).toBe(group.events[0])
    expect(group.event.event_id).toBe(1)
  })
})


describe('the hover summary', () => {
  const kindOf = (e) => e.kind
  const ev = (id, kind, timestamp, causation_id = null) =>
    ({ event_id: id, kind, timestamp, causation_id })

  it('counts by classification, in the legend order and the legend words', () => {
    /*
     * MARKERS order, not insertion order and not alphabetical, so the breakdown reads down the key
     * printed directly above the timeline -- and in ITS labels rather than a second set of names
     * for the same four things.
     */
    const summary = clusterSummary([
      ev(1, 'operational', '2026-08-21T09:00:00Z'),
      ev(2, 'creation',    '2026-08-21T09:00:00Z'),
      ev(3, 'operational', '2026-08-21T09:00:01Z')
    ], kindOf)

    expect(summary).toContain('3 events: 1 Created, 2 Operational')
  })

  it('says outright when one transaction wrote them', () => {
    /*
     * THE FACT A BADGE WOULD OTHERWISE LOSE. A fan of dots showed it by accident -- perfect
     * overlap was the signature of one act. Collapsed to a count, it has to be said in words.
     */
    const summary = clusterSummary([
      ev(1, 'creation',   '2026-08-21T09:00:00Z', 'tx-1'),
      ev(2, 'governance', '2026-08-21T09:00:00Z', 'tx-1')
    ], kindOf)

    expect(summary).toContain('One transaction')
  })

  it('does not claim one transaction merely because the timestamps agree', () => {
    /*
     * Two different acts can commit in the same second, and every row written before migration
     * 0026 carries no causation at all -- so a NULL must never match another NULL. Same rule
     * causationSiblings() enforces, stated here because this is the other place it could be broken.
     */
    const summary = clusterSummary([
      ev(1, 'creation',    '2026-08-21T09:00:00Z'),
      ev(2, 'operational', '2026-08-21T09:00:00Z')
    ], kindOf)

    expect(summary).not.toContain('One transaction')
    expect(summary).toContain('All at')
  })

  it('gives the window when the events are merely close', () => {
    const summary = clusterSummary([
      ev(1, 'creation',    '2026-08-21T09:00:00Z'),
      ev(2, 'operational', '2026-08-21T09:00:20Z')
    ], kindOf)

    expect(summary).toContain('→')
  })

  it('tells the reader how to see the events individually', () => {
    // The badge is the only place the zoom relationship is discoverable: nothing else on the page
    // connects the range control to whether a group is drawn as one mark or several.
    const summary = clusterSummary([
      ev(1, 'creation',    '2026-08-21T09:00:00Z'),
      ev(2, 'operational', '2026-08-21T09:00:01Z')
    ], kindOf)

    expect(summary).toMatch(/narrow the time range/i)
  })
})


/*
 * The wiring, exercised through the DOM.
 *
 * Everything above tests the pure functions, which leaves one thing unasserted: whether the
 * component actually USES them. jsdom reports `offsetWidth: 0` for every element, so the real page
 * takes the no-measurement path in tests and no amount of pure-function coverage would notice a
 * component that computed the groups and then drew every event singly anyway.
 *
 * So the measurement is stubbed and the rendered track is read back.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

describe('the component draws the badges', () => {
  const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] }]

  /*
   * THREE EVENTS, AND THE THIRD IS LOAD-BEARING. The x axis is scaled to the events themselves, so
   * a fixture of only the two close ones would put them at fractions 0 and 1 -- at opposite ends of
   * the track, touching nothing, and the test would pass while proving the opposite of what it
   * claims. The distant third stretches the domain to nine hours, which is what makes two events
   * two seconds apart land on the same pixel: the reported situation.
   */
  const BURST = [
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
    }
  ]
  const LATER = {
    event_id: 3, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-21T18:00:00Z', description: 'much later',
    changed_by: null, actor_source: 'ingestion',
    old_data: { name: 'Simulated_CNC_01', status: 'ONLINE' },
    new_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' }
  }
  const EVENTS = [...BURST, LATER]

  let originalOffsetWidth

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/digital-thread')) {
        /*
         * THE RANGE CONTROL IS HONOURED, because one test below is about what narrowing it does.
         * The window is a query parameter rather than a client-side filter (see timeWindow), so a
         * narrower range returns fewer rows -- which shrinks the DOMAIN, which is what actually
         * spreads a burst across the track. A mock that ignored `since` would make that test a
         * no-op that still passed.
         */
        return Promise.resolve(path.includes('since=') ? BURST : EVENTS)
      }
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

  /** Badges on the timeline. Scoped to the track, so the legend's sample is not counted -- which
   *  is also what pins the split between `.dt-cluster` the look and `.dt-track .dt-cluster` the
   *  positioned marker. */
  const badges = () => [...document.querySelectorAll('.dt-track .dt-cluster')]
  const dots = () => [...document.querySelectorAll('.dt-node')]

  /** The fraction out of `calc(14px + <f> * (100% - 28px))`, however jsdom reorders it. */
  const fractionOf = (left) => Number(/([\d.e-]+)\s*\*|\*\s*([\d.e-]+)/.exec(left)?.slice(1).find(Boolean) ?? NaN)

  const draw = async () => {
    render(<DigitalThreadTab />)
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
    await waitFor(() => expect(badges()).toHaveLength(1))
  }

  it('replaces the overlapping pair with one badge reading its count', async () => {
    await draw()

    expect(badges()[0]).toHaveTextContent('2')
    // The distant event collides with nothing, so it stays an ordinary coloured dot. A badge
    // applied to everything would be as wrong as none at all -- it would claim density where
    // there is none.
    expect(dots()).toHaveLength(1)
  })

  it('applies the grouping even though the timeline does not exist on first paint', async () => {
    /*
     * THE BUG THIS CAUGHT WHEN THE FAN WAS BUILT, and it would have shipped invisibly. The
     * measurement began as a `useEffect` with `[]` deps -- which runs while the page is still
     * showing its spinner, finds no track to measure, records a width of 0, and never runs again.
     * Grouping would then be disabled permanently, on a page that looked exactly as it did before.
     */
    await draw()
    expect(badges()).toHaveLength(1)
  })

  it('leaves horizontal position untouched, which is the whole point', async () => {
    /*
     * THE PROPERTY THIS EXISTS TO PRESERVE. The badge must sit essentially where the two events
     * are -- two seconds out of nine hours, so hard against the left end -- because grouping was
     * chosen over nudging along the axis precisely so the time axis keeps telling the truth. If a
     * future change displaced markers along x, this is what would catch it.
     */
    await draw()

    expect(fractionOf(badges()[0].style.left)).toBeLessThan(0.001)
    expect(fractionOf(dots()[0].style.left)).toBeCloseTo(1, 5)
  })

  it('no longer displaces any marker vertically', async () => {
    // The fan set an inline `top` on colliding markers. Nothing should now: every mark sits on the
    // lane's centre line, where the CSS puts it.
    await draw()
    for (const el of [...badges(), ...dots()]) expect(el.style.top).toBe('')
  })

  it('names the group in the legend, with a purple sample', async () => {
    await draw()

    expect(screen.getByText('Grouped (1)')).toBeInTheDocument()
    expect(document.querySelector('.dt-legend .dt-cluster')).toBeTruthy()
  })

  it('breaks the group down on hover, in the legend words', async () => {
    await draw()
    expect(badges()[0].getAttribute('title')).toContain('2 events: 1 Created, 1 Operational')
  })

  it('opens the drawer on the oldest member when the badge is clicked', async () => {
    await draw()
    fireEvent.click(badges()[0])

    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    // Oldest first, so a click lands at the START of the burst and Next means "and then what".
    expect(screen.getByTitle(/Position in this asset's history/)).toHaveTextContent('Event 1 of 3')
  })

  it('keeps the badge ringed while Previous/Next steps through the events inside it', async () => {
    /*
     * The ring marks WHERE THE DRAWER IS. Stepping from the first member to the second does not
     * move the drawer out of the group, so the highlight must not move either -- the events are
     * both at that badge. Stepping once more leaves the group, and then it must.
     */
    await draw()
    fireEvent.click(badges()[0])
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())

    expect(badges()[0].className).toContain('dt-node-selected')

    const next = () => screen.getByRole('button', { name: /Next/ })
    fireEvent.click(next())
    await waitFor(() =>
      expect(screen.getByTitle(/Position in this asset's history/)).toHaveTextContent('Event 2 of 3'))
    expect(badges()[0].className).toContain('dt-node-selected')

    fireEvent.click(next())
    await waitFor(() => expect(dots()[0].className).toContain('dt-node-selected'))
    expect(badges()[0].className).not.toContain('dt-node-selected')
  })

  it('dissolves the badge into individual markers when the range is narrowed', async () => {
    /*
     * THE RANGE CONTROL AS A ZOOM, end to end. Narrowing it drops the distant event from the
     * result, which shrinks the domain from nine hours to two seconds -- and the same two events
     * are now a track's width apart rather than a fraction of a pixel. Nothing about them changed;
     * the pixels between them did, which is the whole basis of the threshold.
     */
    await draw()

    fireEvent.change(screen.getByTitle('Limit the timeline to a time range'),
      { target: { value: '15m' } })

    await waitFor(() => expect(badges()).toHaveLength(0))
    expect(dots()).toHaveLength(2)
    // And with no notation on screen, the key entry for it goes too.
    expect(screen.queryByText(/^Grouped/)).toBeNull()
  })
})
