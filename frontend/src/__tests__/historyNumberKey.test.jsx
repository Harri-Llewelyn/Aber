/**
 * A number chart's key: its lowest and highest with their buckets, and its mean and median over
 * time, under the chart in the text key's style; pointing at an entry marks it on the plot. uPlot
 * draws on a canvas jsdom does not have, so a stand-in gives the chart a plot area and a scale.
 */
import React from 'react'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { TimeSeriesChart } from '../components/common/TimeSeriesChart'
import { bucketStarts, chartSeries, chartSummary, momentWords } from '../utils/history'
import { HISTORY_RESOLUTIONS } from '../api'

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.over = document.createElement('div')
      this.over.className = 'u-over'
      target.appendChild(this.over)
    }
    // A scale of one pixel a unit, upwards from a plot 200px tall.
    valToPos(value) { return 200 - value }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

const MINUTE = 60 * 1000
const T0 = Date.UTC(2026, 10, 2)
const START = T0
const END = T0 + 6 * MINUTE
const NOW = T0 + 5 * MINUTE
const starts = bucketStarts(START, END, 1)
const at = (i, values) => ({ bucket_ts: new Date(T0 + i * MINUTE).toISOString(), ...values })
const read = (i, avg, min, max) => at(i, { avg_double: avg, min_double: min, max_double: max, last_double: avg, n_rows: 3, is_carried: false })
const carried = (i, v) => at(i, { avg_double: v, min_double: v, max_double: v, last_double: v, n_rows: 0, is_carried: true })

/** Five buckets before now, a sixth at it: the lowest is 8 at the start, the highest 61 at 4 minutes. */
const SERIES = chartSeries([
  read(0, 10, 8, 12), read(1, 20, 18, 25), carried(2, 20), carried(3, 20), read(4, 50, 40, 61), read(5, 100, 99, 101),
], starts)

const draw = (series = SERIES, extra = {}) => render(
  <TimeSeriesChart
    metric="Spindle/LOAD" unit="kW" starts={starts} series={series} start={START} end={END} now={NOW} minutes={1}
    summary={chartSummary({
      metric: 'Spindle/LOAD', unit: 'kW', windowText: 'Last 6 minutes', resolution: HISTORY_RESOLUTIONS[0], series, starts, span: { start: START, end: END, now: NOW },
    })}
    {...extra}
  />
)

const entries = (container) => [...container.querySelectorAll('.chart-number-key li')]
const words = (li) => [...li.querySelectorAll('span')].map(s => s.textContent)

afterEach(cleanup)

describe("a number chart's key", () => {
  it('sits under the chart in the text key\'s place and style, with the lowest, highest, mean and median and the unit', () => {
    const { container } = draw()
    const key = container.querySelector('.chart-number-key')
    expect(key.classList.contains('chart-state-key')).toBe(true)
    // The key follows the plot, before the screen-reader text.
    expect(key.previousElementSibling.classList.contains('chart-frame')).toBe(true)
    expect(entries(container).map(words)).toEqual([
      ['min', '8 kW', momentWords(T0, 1)],
      ['max', '61 kW', momentWords(T0 + 4 * MINUTE, 1)],
      ['mean', '24 kW', 'over time'],
      ['median', '20 kW', 'over time'],
    ])
  })

  it("is not under a flag's or a text's chart, which keep their own keys", () => {
    const flag = chartSeries([at(0, { last_bool: true }), at(1, { last_bool: false })], starts)
    const first = draw(flag)
    expect(first.container.querySelector('.chart-number-key')).toBeNull()
    expect(first.container.querySelector('.chart-state-key')).not.toBeNull()
    cleanup()
    const text = chartSeries([at(0, { last_string: 'RUNNING' })], starts)
    const second = draw(text)
    expect(second.container.querySelector('.chart-number-key')).toBeNull()
    cleanup()
    expect(draw(chartSeries([], starts)).container.querySelector('.chart-number-key')).toBeNull()
  })

  it('marks a bucket on the plot while its extreme is pointed at, and clears it on leaving', () => {
    const { container } = draw()
    const [lowest, highest] = entries(container)
    const over = () => container.querySelector('.u-over')
    expect(over().querySelector('.chart-point-mark')).toBeNull()
    fireEvent.mouseEnter(lowest)
    const ring = over().querySelector('.chart-point-mark')
    // At the bucket's start, across the window, and at its value on the plot's scale.
    expect(ring.style.left).toBe('0%')
    expect(ring.style.top).toBe('192px')
    fireEvent.mouseLeave(lowest)
    expect(over().querySelector('.chart-point-mark')).toBeNull()
    fireEvent.mouseEnter(highest)
    const high = over().querySelector('.chart-point-mark')
    expect(parseFloat(high.style.left)).toBeCloseTo((4 / 6) * 100, 5)
    expect(high.style.top).toBe('139px')
  })

  it('draws a level across the plot while the mean or the median is pointed at', () => {
    const { container } = draw()
    const [, , mean, median] = entries(container)
    const over = () => container.querySelector('.u-over')
    fireEvent.mouseEnter(mean)
    expect(over().querySelector('.chart-point-mark')).toBeNull()
    expect(over().querySelector('.chart-level-mark').style.top).toBe('176px')
    fireEvent.mouseLeave(mean)
    fireEvent.mouseEnter(median)
    expect(over().querySelector('.chart-level-mark').style.top).toBe('180px')
    fireEvent.mouseLeave(median)
    expect(over().querySelector('.chart-level-mark')).toBeNull()
  })

  it('gives a screen reader the mean and the median, over time', () => {
    draw()
    expect(screen.getByRole('img', { name: 'Spindle/LOAD (kW)' }))
      .toHaveAccessibleDescription(/Lowest 8 kW, highest 61 kW\. Mean 24 kW and median 20 kW over time\./)
  })

  it('says every figure in text, so the mark on the plot is only an aid', () => {
    const { container } = draw()
    const key = within(container.querySelector('.chart-number-key'))
    expect(key.getByText('61 kW')).toBeInTheDocument()
    expect(container.querySelector('.chart-number-key [tabindex]')).toBeNull()
  })
})
