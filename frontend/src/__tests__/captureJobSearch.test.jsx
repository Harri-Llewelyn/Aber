import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { HISTORY_PAGE, SEARCH_ROWS, SEARCH_STEP, jobSearchText } from '../components/tabs/CaptureHistory'
import { focusPageSearch } from '../components/common/SearchInput'
import { currentTabLink, tabLink } from '../test/tabBar'
import { formatDateTime } from '../utils/format'

/**
 * The Captures and Playbacks tabs can be searched and narrowed to one job. The search is the first
 * control of the toolbar, lives in the address as `?search=`, and reads on through the older jobs
 * until it has them all. `?job=<id>` lists that one job, as a notification opens it.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      listCaptures: vi.fn(),
      activeCaptureJob: vi.fn(),
      recentCaptureJobs: vi.fn(),
      playbackTargets: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      jobHistory: vi.fn(),
      displayNamesFor: vi.fn()
    }
  }
})

vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

import { api } from '../api'

const GATEWAY = { id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000', is_archived: false, is_simulated: false }
const DEVICE = { id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000', gateway_id: 'gw-1', is_archived: false }
const HARRI = '7d1b6a52-3c4e-4f10-9a2b-0c5d6e7f8a91'
const SIAN = '91a8f7e6-d5c0-4b2a-901f-4e3c25a6b1d7'

const jobId = (base, n) => `${base}-4000-8000-${String(n).padStart(12, '0')}`
const stamp = (n) => `2026-10-29T10:${String(59 - (n % 60)).padStart(2, '0')}:07.123456+00:00`

/** A finished recording, its fields each different so a query finds one. */
const captureJob = (n, over = {}) => ({
  id: jobId('00000000', 1000 + n),
  status: 'COMPLETED',
  subject_kind: 'gateway',
  gateway_id: 'gw-1',
  gateways: { name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000' },
  devices: null,
  subject_sparkplug_id: 'gwy120000000000400080000',
  device_sparkplug_id: null,
  storage_path: `gwy120000000000400080000/${jobId('00000000', 1000 + n)}.json`,
  note: null,
  created_at: stamp(n),
  elapsed_seconds: 125,
  bytes: 2 * 1048576,
  requested_by: HARRI,
  error: null,
  ...over
})

/** A finished playback. */
const playbackJob = (n, over = {}) => ({
  id: jobId('00000000', 0xb000 + n),
  status: 'COMPLETED',
  capture_storage_path: 'gwy120000000000400080000/baseline-run.json',
  captures: { note: null, subject_sparkplug_id: 'gwy120000000000400080000' },
  gateways: { name: 'Playback', sparkplug_id: 'gwy130000000000400080000' },
  created_at: stamp(n),
  elapsed_seconds: 40,
  messages_sent: 5,
  messages_total: 5,
  requested_by: HARRI,
  error: null,
  ...over
})

const page = (rows, { remaining = rows.length, more = false } = {}) => ({ rows, remaining, more })

function renderTab() {
  const props = { showToast: vi.fn(), userRole: 'Administrator' }
  return { ...render(<main><CaptureTab {...props} /></main>), props }
}

const at = (url) => window.history.replaceState(null, '', url)
const address = () => window.location.pathname + window.location.search
const card = () => document.querySelector('.card.card-fill')
const table = () => card().querySelector(':scope > .table-wrap > table')
const bodyRows = () => (table() ? within(table()).getAllByRole('row').slice(1) : [])
/** When each listed job was started: the fixtures differ by the minute, so this names the jobs. */
const startedOf = () => bodyRows().map(row => row.cells[0].textContent)
const startedAt = (jobs, indexes) => indexes.map(n => formatDateTime(jobs[n].created_at))
const toolbar = () => document.querySelector('.card.card-fill > .tab-strip + .filter-bar')
const typeSearch = (label, text) => fireEvent.change(within(toolbar()).getByLabelText(label), { target: { value: text } })

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(path => Promise.resolve(path.includes('gateways') ? [GATEWAY] : [DEVICE]))
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([])
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
  api.jobHistory.mockResolvedValue(page([]))
  api.displayNamesFor.mockResolvedValue(new Map([[HARRI, 'Harri Williams'], [SIAN, 'Sian Evans']]))
})

afterEach(() => at('/'))

// =============================================================================================
describe('the search on the Captures tab', () => {
  const RECORDINGS = [
    captureJob(0, { note: 'pre-trip bearing baseline' }),
    captureJob(1, { storage_path: 'gwy120000000000400080000/night-run.json' }),
    captureJob(2, { subject_kind: 'device', gateways: null, devices: { name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000' }, subject_sparkplug_id: 'dev270000000000400080000', device_sparkplug_id: 'dev270000000000400080000' }),
    captureJob(3, { requested_by: SIAN }),
    captureJob(4, { status: 'FAILED', error: 'the broker refused the subscription' }),
    captureJob(5, { status: 'CANCELLED' }),
  ]

  const visit = async (url = '/capture/captures') => {
    at(url)
    api.jobHistory.mockResolvedValue(page(RECORDINGS))
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(RECORDINGS.length))
  }

  it('is the first control of the toolbar, which `/` focuses, and the Gateways search is not on this tab', async () => {
    await visit()
    const search = within(toolbar()).getByLabelText('Search captures')
    expect(toolbar().firstElementChild).toContainElement(search)
    expect(search).toHaveAttribute('placeholder', 'Search note, subject, person or status…')
    expect(within(toolbar()).queryByLabelText('Search subjects')).toBeNull()
    expect(focusPageSearch()).toBe(true)
    expect(document.activeElement).toBe(search)
    // Play a file… stays the page's, at the end.
    expect(within(toolbar()).getByRole('button', { name: /Play a file/ })).toBeInTheDocument()
  })

  it.each([
    ['the note', 'BEARING baseline', [0]],
    ['the file name', 'night-run', [1]],
    ['the subject name', 'cnc spindle', [2]],
    ['the subject Sparkplug ID', 'dev270000000000400080000', [2]],
    ['the Sparkplug ID of a gateway', 'gwy12000', [0, 1, 3, 4, 5]],
    ['who started it, by name', 'sian', [3]],
    ['who started it, by id', SIAN.slice(0, 8), [3]],
    ['the status as the tab says it', 'cancelled', [5]],
    ['the status as the database says it', 'failed', [4]],
    ['the failure reason', 'refused the subscription', [4]],
    ['the job id', jobId('00000000', 1003), [3]],
  ])('matches %s', async (_what, query, expected) => {
    await visit()
    typeSearch('Search captures', query)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected.length))
    expect(startedOf()).toEqual(startedAt(RECORDINGS, expected))
  })

  it('writes the search in the address, and a link with it opens the filtered list', async () => {
    await visit()
    typeSearch('Search captures', 'refused')
    await waitFor(() => expect(address()).toBe('/capture/captures?search=refused'))
    expect(bodyRows()).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
  })

  it('opens from `?search=` with the box filled and the list narrowed', async () => {
    at('/capture/captures?search=night-run')
    api.jobHistory.mockResolvedValue(page(RECORDINGS))
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(within(toolbar()).getByLabelText('Search captures')).toHaveValue('night-run')
  })

  it('says nothing matches, and clears with Clear filters', async () => {
    await visit()
    typeSearch('Search captures', 'zebra')
    expect(await screen.findByText(/No finished recordings match/)).toBeInTheDocument()
    expect(screen.getByText('zebra', { selector: 'strong' })).toBeInTheDocument()
    expect(table()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    await waitFor(() => expect(bodyRows()).toHaveLength(RECORDINGS.length))
    expect(address()).toBe('/capture/captures')
  })

  it('says how many of the jobs match, under the list', async () => {
    await visit()
    typeSearch('Search captures', 'sian')
    expect(await screen.findByText('1 of 6 finished recordings match.')).toBeInTheDocument()
  })

  it('does not search a match across two fields', () => {
    const job = captureJob(0, { note: 'abc', storage_path: 'gwy/def.json' })
    expect(jobSearchText('capture', job)).not.toContain('abcdef')
    expect(jobSearchText('capture', job).split('\n')).toEqual(expect.arrayContaining(['abc', 'def.json']))
  })
})

// =============================================================================================
describe('a search reads on through the older jobs', () => {
  it('asks for the next page from the last row it holds, until it has them all, and finds an older job', async () => {
    const first = Array.from({ length: HISTORY_PAGE }, (_, n) => captureJob(n))
    const older = [captureJob(20, { note: 'zebra crossing test' }), captureJob(21)]
    api.jobHistory.mockImplementation((kind, { before }) => Promise.resolve(before
      ? page(older, { remaining: 2 })
      : page(first, { remaining: 22, more: true })))
    at('/capture/captures?search=zebra')
    renderTab()

    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(api.jobHistory).toHaveBeenLastCalledWith('capture', {
      before: { created_at: first[19].created_at, id: first[19].id },
      limit: SEARCH_STEP,
    })
    expect(api.jobHistory).toHaveBeenCalledTimes(2)
    expect(screen.getByText('1 of 22 finished recordings match.')).toBeInTheDocument()
  })

  it('says it is searching older jobs while it reads, rather than that nothing matches', async () => {
    const first = Array.from({ length: HISTORY_PAGE }, (_, n) => captureJob(n))
    let release
    api.jobHistory.mockImplementation((kind, { before }) => (before
      ? new Promise(resolve => { release = () => resolve(page([captureJob(20, { note: 'zebra' })], { remaining: 1 })) })
      : Promise.resolve(page(first, { remaining: 21, more: true }))))
    at('/capture/captures?search=zebra')
    renderTab()

    expect(await screen.findByText(/Loading older finished recordings/)).toBeInTheDocument()
    expect(screen.queryByText(/No finished recordings match/)).toBeNull()
    release()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
  })

  it('stops at the most it searches, and says how many it did not', async () => {
    const many = Array.from({ length: SEARCH_ROWS }, (_, n) => captureJob(n, { note: n === 3 ? 'zebra' : null }))
    api.jobHistory.mockResolvedValue(page(many, { remaining: 1432, more: true }))
    at('/capture/captures?search=zebra')
    renderTab()

    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(screen.getByText('Searched the newest 1,000 of 1,432 finished recordings. Older ones are not searched.')).toBeInTheDocument()
    expect(api.jobHistory).toHaveBeenCalledTimes(1)
  })

  it('reads nothing more with no search, and keeps what it read when the search is cleared', async () => {
    const first = Array.from({ length: HISTORY_PAGE }, (_, n) => captureJob(n))
    api.jobHistory.mockImplementation((kind, { before }) => Promise.resolve(before
      ? page([captureJob(20, { note: 'zebra' })], { remaining: 1 })
      : page(first, { remaining: 21, more: true })))
    at('/capture/captures')
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(HISTORY_PAGE))
    expect(api.jobHistory).toHaveBeenCalledTimes(1)

    typeSearch('Search captures', 'zebra')
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    typeSearch('Search captures', '')
    await waitFor(() => expect(bodyRows()).toHaveLength(HISTORY_PAGE + 1))
    expect(screen.getByText('All 21 shown.')).toBeInTheDocument()
  })
})

// =============================================================================================
describe('the search on the Playbacks tab', () => {
  const PLAYBACKS = [
    playbackJob(0, { captures: { note: 'vibration baseline for the lathe', subject_sparkplug_id: 'gwy120000000000400080000' } }),
    playbackJob(1, { capture_storage_path: 'gwy120000000000400080000/night-run.json' }),
    playbackJob(2, { captures: null, capture_storage_path: 'dev270000000000400080000/gone.json' }),
    playbackJob(3, { requested_by: SIAN }),
    playbackJob(4, { status: 'FAILED', error: 'publishing stopped after 7 of 9 messages' }),
    playbackJob(5, { status: 'CANCELLED' }),
  ]

  const visit = async (url = '/capture/playbacks') => {
    at(url)
    api.jobHistory.mockResolvedValue(page(PLAYBACKS))
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(PLAYBACKS.length))
  }

  it('is the first control of the toolbar', async () => {
    await visit()
    const search = within(toolbar()).getByLabelText('Search playbacks')
    expect(toolbar().firstElementChild).toContainElement(search)
    expect(focusPageSearch()).toBe(true)
    expect(document.activeElement).toBe(search)
  })

  it.each([
    ['the capture note', 'LATHE', [0]],
    ['the file name', 'night-run', [1]],
    ['the subject name, from the subject tables', 'line 1 gateway', [0, 1, 3, 4, 5]],
    ['the subject Sparkplug ID of a deleted capture', 'dev270000000000400080000', [2]],
    ['who started it', 'sian evans', [3]],
    ['the status as the tab says it, and the words of a failure', 'stopped', [4, 5]],
    ['the failure reason', 'after 7 of 9', [4]],
    ['the job id', jobId('00000000', 0xb004), [4]],
  ])('matches %s', async (_what, query, expected) => {
    await visit()
    // The subject tables name a played-back capture's subject once they have read.
    await screen.findAllByText('Line 1 Gateway')
    typeSearch('Search playbacks', query)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected.length))
    expect(startedOf()).toEqual(startedAt(PLAYBACKS, expected))
  })

  it('writes the search in the address', async () => {
    await visit()
    typeSearch('Search playbacks', 'stopped')
    await waitFor(() => expect(address()).toBe('/capture/playbacks?search=stopped'))
  })
})

// =============================================================================================
describe('a tab narrowed to one job', () => {
  const ONE = captureJob(2, { note: 'the one a notification names' })
  const OTHERS = [captureJob(0), captureJob(1), ONE]

  it('reads that job alone, lists only it, and says so with a way back', async () => {
    api.jobHistory.mockImplementation((kind, { job }) => Promise.resolve(job ? page([ONE]) : page(OTHERS)))
    at(`/capture/captures?job=${ONE.id}`)
    renderTab()

    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(api.jobHistory).toHaveBeenCalledWith('capture', { job: ONE.id, limit: 1 })
    expect(api.jobHistory).not.toHaveBeenCalledWith('capture', { limit: HISTORY_PAGE })
    expect(screen.getByText('Showing one recording.')).toBeInTheDocument()
    // The line is the card's, above the table, and the toolbar counts the narrowing.
    expect(screen.getByText('Showing one recording.').closest('.callout').nextElementSibling).toBe(table().parentElement)
    expect(screen.getByRole('button', { name: /Clear filters \(1\)/ })).toBeInTheDocument()
    expect(currentTabLink()).toHaveTextContent('Captures')
  })

  it('goes back to the whole list from Show all', async () => {
    api.jobHistory.mockImplementation((kind, { job }) => Promise.resolve(job ? page([ONE]) : page(OTHERS)))
    at(`/capture/captures?job=${ONE.id}`)
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Show all recordings' }))
    await waitFor(() => expect(bodyRows()).toHaveLength(3))
    expect(address()).toBe('/capture/captures')
    expect(screen.queryByText('Showing one recording.')).toBeNull()
  })

  it('goes back from Clear filters as well', async () => {
    api.jobHistory.mockImplementation((kind, { job }) => Promise.resolve(job ? page([ONE]) : page(OTHERS)))
    at(`/capture/captures?job=${ONE.id}`)
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    await waitFor(() => expect(bodyRows()).toHaveLength(3))
    expect(address()).toBe('/capture/captures')
  })

  it('leaves the job when a search is typed, which is a look for something else', async () => {
    api.jobHistory.mockImplementation((kind, { job }) => Promise.resolve(job ? page([ONE]) : page(OTHERS)))
    at(`/capture/captures?job=${ONE.id}`)
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))

    typeSearch('Search captures', 'capture')
    await waitFor(() => expect(address()).toBe('/capture/captures?search=capture'))
    expect(screen.queryByText('Showing one recording.')).toBeNull()
  })

  it('says a job that is not finished, or is none, is not listed, and where to see one in progress', async () => {
    api.jobHistory.mockResolvedValue(page([]))
    at(`/capture/captures?job=${jobId('00000000', 9999)}`)
    renderTab()
    expect(await screen.findByText(/No finished recording has this id\. One still in progress is in the strip above/)).toBeInTheDocument()
    expect(screen.getByText('Showing one recording.')).toBeInTheDocument()
    expect(screen.queryByText(/No finished recordings yet/)).toBeNull()
  })

  it('narrows the Playbacks tab the same way, in its own words', async () => {
    const played = playbackJob(1)
    api.jobHistory.mockImplementation((kind, { job }) => Promise.resolve(job ? page([played]) : page([playbackJob(0), played])))
    at(`/capture/playbacks?job=${played.id}`)
    renderTab()
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(api.jobHistory).toHaveBeenCalledWith('playback', { job: played.id, limit: 1 })
    expect(screen.getByText('Showing one playback.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all playbacks' })).toBeInTheDocument()
  })

  it('is on no other tab: the Gateways tab ignores it', async () => {
    at(`/capture?job=${ONE.id}`)
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    expect(screen.queryByText(/Showing one/)).toBeNull()
    expect(api.jobHistory).not.toHaveBeenCalled()
  })
})

// =============================================================================================
describe('the tabs and what they carry in the address', () => {
  it('keeps the search between Captures and Playbacks, and leaves the job and the other tabs behind', async () => {
    api.jobHistory.mockResolvedValue(page([captureJob(0)]))
    at('/capture/captures?search=lathe&job=abc')
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(tabLink('Playbacks')).toHaveAttribute('href', '/capture/playbacks?search=lathe')
    expect(tabLink('Gateways')).toHaveAttribute('href', '/capture')
    expect(tabLink('Devices')).toHaveAttribute('href', '/capture/device')
  })

  it('keeps the search and the stored filter between Gateways and Devices, and not on to the job tabs', async () => {
    at('/capture?stored=without&search=line')
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(tabLink('Devices')).toHaveAttribute('href', '/capture/device?stored=without&search=line')
    expect(tabLink('Captures')).toHaveAttribute('href', '/capture/captures')
    expect(tabLink('Playbacks')).toHaveAttribute('href', '/capture/playbacks')
  })
})
