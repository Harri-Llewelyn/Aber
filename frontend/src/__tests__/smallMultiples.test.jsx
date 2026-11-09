/**
 * SmallMultiples on its own, as the Area and Metric tabs will use it: one chart a member on one
 * value scale, a member with no series in words, a member's head, and nothing of a page's. uPlot
 * draws on a canvas jsdom does not have, so a stand-in records what each chart was built with.
 */
import React from 'react'
import { render, screen, within, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SmallMultiples } from '../components/common/SmallMultiples'
import { chartSeries, bucketStarts } from '../utils/history'

const { plots } = vi.hoisted(() => ({ plots: [] }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.data = data
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
      plots.push(this)
    }
    setSize() {}
    destroy() { this.destroyed = true; this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

const START = Date.UTC(2026, 10, 2)
const END = START + 3 * 5 * 60 * 1000
const RESOLUTION = { id: '5m', minutes: 5, words: '5-minute buckets' }
const starts = bucketStarts(START, END, 5)

/** A number series: its average at each of three buckets, a degree either side for its band. */
const numbers = (avgs) => chartSeries(avgs.map((v, i) => ({
  bucket_ts: new Date((starts[i]) * 1000).toISOString(), avg_double: v, min_double: v - 1, max_double: v + 1, last_double: v,
  n_rows: 1, is_carried: false,
})), starts)

const render3 = (members, props = {}) => render(
  <SmallMultiples
    members={members}
    metric="Spindle/LOAD"
    unit="kW"
    start={START}
    end={END}
    now={END + 1000}
    resolution={RESOLUTION}
    windowText="Last 24 hours"
    syncKey="test"
    {...props}
  />
)

beforeEach(() => { plots.length = 0 })
afterEach(cleanup)

describe('SmallMultiples', () => {
  it('draws a chart a member and gives every one the same value scale, said in words', () => {
    const members = [
      { key: 'a', name: 'Machine A', starts, series: numbers([10, 12, 14]) },
      { key: 'b', name: 'Machine B', starts, series: numbers([80, 82, 84]) },
    ]
    render3(members)
    expect(plots).toHaveLength(2)
    expect(plots[0].opts.scales.y.range).toEqual(plots[1].opts.scales.y.range)
    // 9 to 85, padded by 8% of 76.
    expect(plots[0].opts.scales.y.range[0]).toBeCloseTo(9 - 76 * 0.08)
    expect(plots[0].opts.scales.y.range[1]).toBeCloseTo(85 + 76 * 0.08)
    expect(screen.getByText('One scale for every machine: 2.92 to 91.08 kW.')).toBeInTheDocument()
  })

  it('names each chart by its member, and its summary for a screen reader begins with it', () => {
    render3([{ key: 'a', name: 'Machine A', starts, series: numbers([10, 12, 14]) }, { key: 'b', name: 'Machine B', starts, series: numbers([1, 2, 3]) }])
    const figure = screen.getByRole('figure', { name: 'Machine A' })
    const summary = document.getElementById(within(figure).getByRole('img').getAttribute('aria-describedby'))
    expect(summary.textContent).toMatch(/^Machine A\. Spindle\/LOAD \(kW\), Last 24 hours, in 5-minute buckets\./)
  })

  it('says in words that a member has no series, and draws no chart for it', () => {
    render3([
      { key: 'a', name: 'Machine A', starts, series: numbers([10, 12, 14]) },
      { key: 'b', name: 'Machine B' },
      { key: 'c', name: 'Machine C', absent: 'Machine C is switched off.' },
    ])
    expect(plots).toHaveLength(1)
    expect(screen.getAllByRole('figure')).toHaveLength(1)
    expect(screen.getByText('Machine B does not report Spindle/LOAD.')).toBeInTheDocument()
    expect(screen.getByText('Machine C is switched off.')).toBeInTheDocument()
    // One chart alone has nothing to share a scale with.
    expect(screen.queryByText(/One scale for every machine/)).not.toBeInTheDocument()
  })

  it('makes a member\'s name a link where it has an address, and shows its status dot where it has a device', () => {
    render3([
      { key: 'a', name: 'Machine A', to: '/history/device/a', device: { asset_id: 'a', asset_name: 'Machine A', status: 'ONLINE' }, starts, series: numbers([10, 12, 14]) },
      { key: 'b', name: 'Machine B', device: { asset_id: 'b', asset_name: 'Machine B', status: 'OFFLINE' }, starts, series: numbers([1, 2, 3]) },
    ])
    const a = within(screen.getByRole('figure', { name: 'Machine A' }))
    expect(a.getByRole('link', { name: 'Machine A' })).toHaveAttribute('href', '/history/device/a')
    expect(a.getByText('Online')).toBeInTheDocument()
    const b = within(screen.getByRole('figure', { name: 'Machine B' }))
    expect(b.queryByRole('link')).not.toBeInTheDocument()
    expect(b.getByText('Offline')).toBeInTheDocument()
  })

  it('passes a member\'s own valid range and plugins to its chart, and shares the pointer', () => {
    const plugin = { hooks: {} }
    render3([
      { key: 'a', name: 'Machine A', starts, series: numbers([10, 12, 14]), validRange: { minimum: 0, maximum: 100 }, plugins: [plugin] },
      { key: 'b', name: 'Machine B', starts, series: numbers([1, 2, 3]) },
    ])
    expect(plots[0].opts.plugins).toEqual([plugin])
    expect(plots[1].opts.plugins).toEqual([])
    for (const { opts } of plots) expect(opts.cursor.sync).toEqual({ key: 'test' })
    expect(screen.getByText('Valid range 0 to 100 kW')).toBeInTheDocument()
  })

  it('draws no chart again when the same scale arrives in a new render', () => {
    const members = [
      { key: 'a', name: 'Machine A', starts, series: numbers([10, 12, 14]) },
      { key: 'b', name: 'Machine B', starts, series: numbers([1, 2, 3]) },
    ]
    const { rerender } = render3(members)
    expect(plots).toHaveLength(2)
    rerender(
      <SmallMultiples
        members={members.map(m => ({ ...m }))}
        metric="Spindle/LOAD"
        unit="kW"
        start={START}
        end={END}
        now={END + 2000}
        resolution={RESOLUTION}
        windowText="Last 24 hours"
        syncKey="test"
      />
    )
    expect(plots).toHaveLength(2)
  })
})
