/**
 * History's Device tab with a bucket choice on each group's heading: Auto, 1 min, 5 min, 1 hour
 * and 1 day as one SegmentedControl at the heading's right-hand end, each group read at its own
 * size and counting its own row cap, the choices in the address as `?bucket=Double:5m,String:1h`,
 * an older link's one size read for every group and rewritten, Clear filters, and a closed group
 * keeping its choice. uPlot draws on a canvas jsdom does not have, so a stand-in gives each chart a
 * plot area.
 */
import React from 'react'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HistoryTab } from '../components/tabs/HistoryTab'
import { CLOSED_GROUPS_KEY } from '../components/tabs/HistoryDevice'
import { api } from '../api'

vi.mock('uplot', () => {
  class FakePlot {
    constructor(opts, data, target) {
      this.opts = opts
      this.over = document.createElement('div')
      this.over.className = 'u-over'
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
  return { ...actual, api: { get: vi.fn(), readCarriedTelemetry: vi.fn(), readTelemetryChanges: vi.fn() } }
})

const ROBOT = '2b3e0c4a-6666-4000-8000-000000000006'
const device = {
  asset_id: ROBOT, asset_name: 'Cell 6 robot',
  last_birth_metrics: ['Arm/TORQUE', 'Axis/COUNT', 'Axis/FEED', 'Controller/EXECUTION', 'Door/OPEN'],
}
// Double, two Int32s, a String and a Boolean: Double, Int32, Boolean, String in the heading order.
const catalog = [
  { name: 'Arm/TORQUE', datatype: 10 }, { name: 'Axis/COUNT', datatype: 3 }, { name: 'Axis/FEED', datatype: 3 },
  { name: 'Controller/EXECUTION', datatype: 12 }, { name: 'Door/OPEN', datatype: 11 },
]

/** A reading in each of the first buckets of every metric the read names. */
const buckets = ({ from, bucketMinutes, metricNames }) => {
  const width = bucketMinutes * 60000
  const first = Math.floor(Date.parse(from) / width) * width
  return Promise.resolve(metricNames.flatMap(name => [0, 1, 2].map(i => ({
    bucket_ts: new Date(first + i * width).toISOString(), asset_id: 'dev', metric_name: name,
    avg_double: ['Controller/EXECUTION', 'Door/OPEN'].includes(name) ? null : 5, min_double: null, max_double: null,
    last_double: ['Controller/EXECUTION', 'Door/OPEN'].includes(name) ? null : 5,
    last_string: name === 'Controller/EXECUTION' ? 'RUNNING' : null, last_bool: name === 'Door/OPEN' ? true : null, n_rows: 1, is_carried: false,
  }))))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/devices') ? [device] : p.startsWith('/api/v1/metric-catalog') ? catalog : []))
  api.readCarriedTelemetry.mockImplementation(buckets)
  api.readTelemetryChanges.mockResolvedValue([])
  window.localStorage.removeItem(CLOSED_GROUPS_KEY)
})
afterEach(() => {
  window.localStorage.removeItem(CLOSED_GROUPS_KEY)
  window.history.replaceState(null, '', '/')
})

// Three days: 4,320 one-minute buckets, so a group of one metric fits them and a group of two does not.
const THREE_DAYS = 'from=2026-10-01T00:00&to=2026-10-04T00:00'

const show = async (search = '', charts = 5) => {
  window.history.replaceState(null, '', `/history/device/${ROBOT}${search}`)
  render(<HistoryTab hasPermission={() => true} showToast={vi.fn()} userRole="Administrator" />)
  await waitFor(() => expect(screen.getAllByRole('figure').length).toBe(charts))
}
const bucketOf = (search = window.location.search) => new URLSearchParams(search).get('bucket')
/** What each read asked for: the metrics and the bucket width, in the order of the reads. */
const readsOf = () => api.readCarriedTelemetry.mock.calls.map(([a]) => [a.metricNames, a.bucketMinutes])
const sizes = (group) => screen.getByRole('radiogroup', { name: `${group} buckets` })
const segment = (group, name) => within(sizes(group)).getByRole('radio', { name })
const checkedIn = (group) => within(sizes(group)).getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true').textContent
/** A group's heading named for what it says: its name, its charts, and the size it is read in. */
const headingOf = (group, words) => screen.getByRole('button', { name: new RegExp(`^${group}, \\d+ charts?, ${words}`) })

describe("a group's bucket choice", () => {
  it('is on its heading, at the right-hand end, with Auto and the four sizes in one switch', async () => {
    await show()
    const heads = [...document.querySelectorAll('.history-group-head')]
    expect(heads).toHaveLength(4)
    for (const head of heads) {
      const [button, group] = head.children
      expect(button).toHaveClass('group-heading')
      // After the heading button: the row's right-hand end.
      expect(group).toHaveClass('segmented')
      expect(group).toHaveAttribute('role', 'radiogroup')
      expect(within(group).getAllByRole('radio').map(r => r.textContent)).toEqual(['Auto', '1 min', '5 min', '1 hour', '1 day'])
    }
    expect(heads.map(h => h.querySelector('.segmented').getAttribute('aria-label'))).toEqual(['Double buckets', 'Int32 buckets', 'Boolean buckets', 'String buckets'])
    // Not in the toolbar.
    const bar = document.querySelector('.filter-bar')
    expect(within(bar).queryByRole('radiogroup', { name: /buckets/ })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /^Buckets/ })).toBeNull()
  })

  it('starts every group on Auto, with the size Auto took on its heading and each size named in its tooltip', async () => {
    await show('?range=24h')
    for (const group of ['Double', 'Int32', 'Boolean', 'String']) expect(checkedIn(group)).toBe('Auto')
    expect(segment('Double', '5 min')).toHaveAccessibleDescription('5-minute buckets')
    expect(segment('Double', 'Auto')).toHaveAccessibleDescription("Auto takes the finest buckets that fit one read of this group's metrics: 1-minute buckets now.")
    expect(segment('String', 'Auto')).toHaveAccessibleDescription("Auto takes the finest buckets that stay readable and fit one read of this group's metrics: 5-minute buckets now.")
    expect(headingOf('Double', '1-minute buckets')).toBeInTheDocument()
    expect(headingOf('String', '5-minute buckets')).toBeInTheDocument()
  })

  it("reads each group at its own size under Auto, counting its own metrics: the page's line no longer lists a size", async () => {
    await show(`?${THREE_DAYS}`)
    // The Double metric alone fits one-minute buckets over three days; the two Int32s do not, and text reads wider.
    expect(readsOf()).toEqual([
      [['Arm/TORQUE'], 1], [['Axis/COUNT', 'Axis/FEED'], 5], [['Door/OPEN'], 1], [['Controller/EXECUTION'], 60],
    ])
    expect(headingOf('Double', '1-minute buckets')).toBeInTheDocument()
    expect(headingOf('Int32', '5-minute buckets')).toBeInTheDocument()
    expect(headingOf('String', '1-hour buckets')).toBeInTheDocument()
    expect(screen.getByText('5 metrics')).toBeInTheDocument()
    expect(document.querySelector('.history-meta')).not.toHaveTextContent(/bucket/)
    // Each chart's summary, for a screen reader, still names its own bucket.
    expect(screen.getByRole('img', { name: 'Arm/TORQUE' })).toHaveAccessibleDescription(/, in 1-minute buckets\./)
    expect(screen.getByRole('img', { name: 'Axis/COUNT' })).toHaveAccessibleDescription(/, in 5-minute buckets\./)
    expect(screen.getByRole('img', { name: 'Controller/EXECUTION' })).toHaveAccessibleDescription(/, in 1-hour buckets\./)
  })

  it("turns off, with the reason, a size too fine for that group's own metrics over this window", async () => {
    await show(`?${THREE_DAYS}`)
    const reason = 'Too many buckets for this window: choose fewer metrics or a shorter window.'
    // One metric fits one-minute buckets; two do not.
    expect(segment('Double', '1 min')).not.toHaveAttribute('aria-disabled')
    expect(segment('Int32', '1 min')).toHaveAttribute('aria-disabled', 'true')
    expect(segment('Int32', '1 min')).toHaveAccessibleDescription(reason)
    expect(segment('Int32', '5 min')).not.toHaveAttribute('aria-disabled')
    const reads = api.readCarriedTelemetry.mock.calls.length
    fireEvent.click(segment('Int32', '1 min'))
    expect(bucketOf()).toBeNull()
    expect(api.readCarriedTelemetry).toHaveBeenCalledTimes(reads)
    expect(checkedIn('Int32')).toBe('Auto')
  })

  it('reads that group at the size chosen and the others as they were, and writes one entry for it in the address', async () => {
    await show('?range=24h')
    api.readCarriedTelemetry.mockClear()
    fireEvent.click(segment('String', '1 hour'))
    await waitFor(() => expect(headingOf('String', '1-hour buckets')).toBeInTheDocument())
    expect(bucketOf()).toBe('String:1h')
    // The colon is written as a colon.
    expect(window.location.search).toContain('bucket=String:1h')
    expect(checkedIn('String')).toBe('1 hour')
    expect(checkedIn('Double')).toBe('Auto')
    await waitFor(() => expect(readsOf()).toContainEqual([['Controller/EXECUTION'], 60]))
    expect(readsOf()).toContainEqual([['Arm/TORQUE'], 1])
    // A second group adds its own, and Auto takes an entry out again.
    fireEvent.click(segment('Double', '5 min'))
    await waitFor(() => expect(bucketOf()).toBe('String:1h,Double:5m'))
    fireEvent.click(segment('String', 'Auto'))
    await waitFor(() => expect(bucketOf()).toBe('Double:5m'))
    fireEvent.click(segment('Double', 'Auto'))
    await waitFor(() => expect(bucketOf()).toBeNull())
    expect(window.location.search).not.toContain('bucket')
  })

  it('replaces the history entry rather than adding one, as a filter does', async () => {
    await show('?range=24h')
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(segment('Int32', '1 hour'))
    await waitFor(() => expect(bucketOf()).toBe('Int32:1h'))
    expect(push).not.toHaveBeenCalled()
  })

  it('reproduces a view from a link: each entry on its own group, and a group it does not name on Auto', async () => {
    await show('?range=24h&bucket=Double:5m,String:1h')
    expect(readsOf()).toEqual(expect.arrayContaining([[['Arm/TORQUE'], 5], [['Controller/EXECUTION'], 60], [['Axis/COUNT', 'Axis/FEED'], 1]]))
    expect(checkedIn('Double')).toBe('5 min')
    expect(checkedIn('String')).toBe('1 hour')
    expect(checkedIn('Int32')).toBe('Auto')
    expect(checkedIn('Boolean')).toBe('Auto')
    // A link that names a group this device has none of, or a size this page does not offer, is left to the groups it can read.
    expect(bucketOf()).toBe('Double:5m,String:1h')
  })

  it('drops from the address a value that names no size and no group, and reads every group at Auto', async () => {
    await show('?range=24h&bucket=nonsense')
    await waitFor(() => expect(bucketOf()).toBeNull())
    expect(window.location.search).toBe('')
    for (const group of ['Double', 'Int32', 'Boolean', 'String']) expect(checkedIn(group)).toBe('Auto')
  })

  it('reads a link that asks for a size too fine for its group at Auto, says so on the heading, and keeps the choice', async () => {
    await show(`?${THREE_DAYS}&bucket=Int32:1m`)
    expect(headingOf('Int32', '5-minute buckets, as 1-minute buckets are too many here')).toBeInTheDocument()
    expect(readsOf()).toContainEqual([['Axis/COUNT', 'Axis/FEED'], 5])
    expect(checkedIn('Int32')).toBe('1 min')
    expect(bucketOf()).toBe('Int32:1m')
  })
})

describe('an older link with one size', () => {
  it('reads that size for every group, and the address is rewritten to one entry for each, replacing the entry', async () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    await show('?range=24h&bucket=1h')
    await waitFor(() => expect(bucketOf()).toBe('Double:1h,Int32:1h,Boolean:1h,String:1h'))
    expect(replace).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    for (const group of ['Double', 'Int32', 'Boolean', 'String']) expect(checkedIn(group)).toBe('1 hour')
    expect(readsOf().every(([, minutes]) => minutes === 60)).toBe(true)
    expect(window.location.search).toContain('bucket=Double:1h,Int32:1h')
  })

  it('keeps an entry of the new form beside it, which wins for its own group', async () => {
    await show('?range=24h&bucket=5m')
    await waitFor(() => expect(bucketOf()).toBe('Double:5m,Int32:5m,Boolean:5m,String:5m'))
    fireEvent.click(segment('Double', '1 hour'))
    await waitFor(() => expect(bucketOf()).toBe('Double:1h,Int32:5m,Boolean:5m,String:5m'))
  })

  it('is rewritten once a choice is made before the rewrite has landed, not lost', async () => {
    await show('?range=24h&bucket=1d')
    fireEvent.click(segment('Boolean', 'Auto'))
    await waitFor(() => expect(bucketOf()).toBe('Double:1d,Int32:1d,String:1d'))
  })
})

describe('Clear filters', () => {
  it('counts a bucket choice, and resets every group to Auto with the window and the metrics', async () => {
    await show('?range=7d&metric=Arm/TORQUE,Axis/COUNT&bucket=Double:1h,Int32:1d', 2)
    const clear = await screen.findByRole('button', { name: /Clear filters \(3\)/ })
    fireEvent.click(clear)
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(`/history/device/${ROBOT}`))
    await waitFor(() => expect(screen.getAllByRole('figure')).toHaveLength(5))
    for (const group of ['Double', 'Int32', 'Boolean', 'String']) expect(checkedIn(group)).toBe('Auto')
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })

  it('counts nothing of a group left on Auto', async () => {
    await show('?range=24h&bucket=Double:5m')
    expect(await screen.findByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
    fireEvent.click(segment('Double', 'Auto'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull())
  })
})

describe('a closed group', () => {
  it('keeps its choice and its switch on its heading, and the choice is still read', async () => {
    await show('?range=24h&bucket=String:1h')
    const toggle = headingOf('String', '1-hour buckets')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('figure', { name: 'Controller/EXECUTION' })).toBeNull()
    // The switch is on the heading, not in what closes.
    expect(checkedIn('String')).toBe('1 hour')
    expect(bucketOf()).toBe('String:1h')
    // It can be chosen while closed, and the next open draws at it.
    api.readCarriedTelemetry.mockClear()
    fireEvent.click(segment('String', '5 min'))
    await waitFor(() => expect(bucketOf()).toBe('String:5m'))
    await waitFor(() => expect(readsOf()).toContainEqual([['Controller/EXECUTION'], 5]))
    fireEvent.click(headingOf('String', '5-minute buckets'))
    expect(await screen.findByRole('figure', { name: 'Controller/EXECUTION' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Controller/EXECUTION' })).toHaveAccessibleDescription(/, in 5-minute buckets\./)
  })
})

describe('the next device', () => {
  const OTHER = '2b3e0c4a-7777-4000-8000-000000000007'

  it('keeps the choices in the address, which the groups it has take', async () => {
    api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/devices')
      ? [device, { asset_id: OTHER, asset_name: 'Cell 7 robot', last_birth_metrics: ['Arm/TORQUE'] }]
      : p.startsWith('/api/v1/metric-catalog') ? catalog : []))
    await show('?range=24h&bucket=Double:5m,String:1h')
    fireEvent.click(screen.getByRole('button', { name: 'Device: Cell 6 robot' }))
    const panel = await screen.findByRole('dialog', { name: 'Choose a device' })
    const link = within(panel).getByRole('link', { name: /Cell 7 robot/ })
    expect(link.getAttribute('href')).toBe(`/history/device/${OTHER}?bucket=Double:5m,String:1h`)
    act(() => { window.history.pushState({}, '', link.getAttribute('href')); window.dispatchEvent(new PopStateEvent('popstate')) })
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Double buckets' })).toBeInTheDocument())
    expect(checkedIn('Double')).toBe('5 min')
    // A group this device has none of is not on the page; its entry waits in the address.
    expect(screen.queryByRole('radiogroup', { name: 'String buckets' })).toBeNull()
    expect(bucketOf()).toBe('Double:5m,String:1h')
  })
})
