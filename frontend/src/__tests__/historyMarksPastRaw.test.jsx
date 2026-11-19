/**
 * A text or flag chart older than raw retention marks each bucket that held more than one value,
 * from the historian's state rollups (0313). They say that a bucket held more than one value, never
 * how many, so the read gives such a mark no count, and the chart says "more than one value" where
 * a counted mark says "3 values". A bucket raw still holds keeps its count.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { api, HISTORY_RESOLUTIONS } from '../api'
import { bucketStarts, chartSeries, chartSummary, markBuckets, markWords, markedStretches, momentWords } from '../utils/history'

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.over = document.createElement('div')
      target.appendChild(this.over)
    }
    setSize() {}
    destroy() { this.over.remove() }
  }
  FakePlot.paths = { stepped: () => () => null }
  return { default: FakePlot }
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn(), exportTelemetry: vi.fn() } }
})

const MINUTE = 60000
const T0 = Date.UTC(2026, 0, 5, 10, 0)
const at = (ms) => new Date(T0 + ms).toISOString()

describe('a mark with no count', () => {
  const starts = bucketStarts(T0, T0 + 4 * MINUTE, 1)
  const span = { start: T0, end: T0 + 4 * MINUTE, now: T0 + 60 * MINUTE }
  const state = chartSeries(starts.map(s => ({ bucket_ts: new Date(s * 1000).toISOString(), last_string: 'RUN', n_rows: 1 })), starts)
  const row = { read: 'retention', marked_ts: [at(MINUTE), at(3 * MINUTE)], marked_values: [null, 3] }

  it('is laid on its bucket as at least two values, and said to be uncounted', () => {
    const marked = markBuckets(state, starts, row)
    expect(marked.marked).toEqual([0, 2, 0, 3])
    expect(marked.uncounted).toEqual([false, true, false, false])
    expect(markedStretches(marked, starts, { ...span, minutes: 1 }).map(m => [(m.startMs - T0) / MINUTE, m.values, m.counted]))
      .toEqual([[1, 2, false], [3, 3, true]])
  })

  it('says more than one value, never a count; a counted one keeps its count', () => {
    const [uncounted, counted] = markedStretches(markBuckets(state, starts, row), starts, { ...span, minutes: 1 })
    const stretch = (m) => `${momentWords(m.startMs, 1)} – ${momentWords(m.endMs, 1).split(' ').pop()}`
    expect(markWords(uncounted, 1, 'state')).toBe(`${stretch(uncounted)} · more than one value in this bucket, RUN last`)
    expect(markWords(counted, 1, 'state')).toBe(`${stretch(counted)} · 3 values in this bucket, RUN last`)
    expect(markWords({ ...uncounted, last: false }, 1, 'flag')).toBe(`${stretch(uncounted)} · both values in this bucket, false last`)
  })

  it('is counted among the buckets that held more than one value in the summary', () => {
    const series = markBuckets(state, starts, row)
    const minute = HISTORY_RESOLUTIONS.find(r => r.minutes === 1)
    expect(chartSummary({ metric: 'Controller/EXECUTION', windowText: 'a window', resolution: minute, series, starts, span }))
      .toContain('2 of 4 buckets held more than one value, and show the last.')
  })
})

describe('a state chart older than raw retention', () => {
  const CELL = '2b3e0c4a-8888-4000-8000-000000000313'
  const device = { asset_id: CELL, asset_name: 'Robot cell', last_birth_metrics: ['Controller/EXECUTION', 'Door/OPEN'] }
  const catalog = [{ name: 'Controller/EXECUTION', datatype: 12 }, { name: 'Door/OPEN', datatype: 11 }]
  const first = (from, minutes) => Math.floor(Date.parse(from) / (minutes * MINUTE)) * minutes * MINUTE
  /** The bucket read: RUNNING throughout, and a door that is shut throughout. */
  const buckets = ({ from, bucketMinutes, metricNames }) => Promise.resolve(metricNames.flatMap(name => Array.from({ length: 60 }, (_, i) => ({
    bucket_ts: new Date(first(from, bucketMinutes) + i * bucketMinutes * MINUTE).toISOString(), asset_id: 'dev', metric_name: name,
    avg_double: null, min_double: null, max_double: null, last_double: null,
    last_string: name === 'Controller/EXECUTION' ? 'RUNNING' : null, last_bool: name === 'Door/OPEN' ? false : null,
    n_rows: 1, is_carried: false,
  }))))
  /** Past raw: the program's bucket at 10 min uncounted and the one at 20 min, inside raw, counted; the door's at 2 min. */
  const retention = ({ from, bucketMinutes, metricNames }) => {
    const base = first(from, bucketMinutes)
    const ts = (m) => new Date(base + m * MINUTE).toISOString()
    return Promise.resolve(metricNames.map(name => (name === 'Door/OPEN'
      ? { metric_name: name, read: 'retention', marked_ts: [ts(2)], marked_values: [null], raw_from: ts(15) }
      : { metric_name: name, read: 'retention', marked_ts: [ts(10), ts(20)], marked_values: [null, 3], raw_from: ts(15) })))
  }
  const pointAt = (figure, mark) => {
    const box = figure.querySelector('.chart-box-states')
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 34, right: 600, bottom: 34 })
    fireEvent.pointerMove(box, { clientX: ((parseFloat(mark.style.left) + parseFloat(mark.style.width) / 2) / 100) * 600 })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation((p) => {
      if (p.startsWith('/api/v1/devices')) return Promise.resolve([device])
      if (p.startsWith('/api/v1/metric-catalog')) return Promise.resolve(catalog)
      return Promise.resolve([])
    })
    api.readCarriedTelemetry.mockImplementation(buckets)
    api.readTelemetryChanges.mockImplementation(retention)
  })

  afterEach(() => {
    window.history.pushState({}, '', '/')
  })

  it('marks each bucket that held more than one value, and says more than one where it has no count', async () => {
    window.history.pushState({}, '', `/history/device/${CELL}?range=1h`)
    render(<HistoryTab showToast={vi.fn()} userRole="Shopfloor_Manager" />)
    const figure = await screen.findByRole('figure', { name: 'Controller/EXECUTION' })
    await waitFor(() => expect(figure.querySelectorAll('.chart-state-mixed')).toHaveLength(2))
    const [uncounted, counted] = figure.querySelectorAll('.chart-state-mixed')
    expect([...figure.querySelectorAll('.chart-state-key li')].map(li => li.textContent)).toContain('more than one value in the bucket')
    pointAt(figure, uncounted)
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/ · more than one value in this bucket, RUNNING last$/)
    pointAt(figure, counted)
    expect(figure.querySelector('.history-chart-hover')).toHaveTextContent(/ · 3 values in this bucket, RUNNING last$/)
    expect(screen.getByRole('img', { name: 'Controller/EXECUTION' }))
      .toHaveAccessibleDescription(/older than raw retention.*2 of \d+ buckets held more than one value, and show the last\./)

    const door = screen.getByRole('figure', { name: 'Door/OPEN' })
    const [mark] = door.querySelectorAll('.chart-state-mixed')
    pointAt(door, mark)
    expect(door.querySelector('.history-chart-hover')).toHaveTextContent(/ · both values in this bucket, false last$/)
  })
})
