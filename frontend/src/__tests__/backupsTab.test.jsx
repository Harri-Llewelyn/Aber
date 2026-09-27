import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BackupsTab, BACKUP_STALE_HOURS } from '../components/tabs/BackupsTab'
import { tabIsVisible, TABS, groupedNav } from '../App'

/**
 * The Backups page. What has to hold: the page never takes a backup itself, only queues one and
 * shows what the service did; every finished run is listed, a failed one with its reason and a
 * pruned one saying so; the one line about the current state appears only while backups are not
 * working now, and says nothing on a stack that has never run the service; a queued request that
 * nobody claims says so; a pinned backup is released through a confirmation that says nothing is
 * deleted at that moment; and the page is an Administrator's alone.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listBackupRuns: vi.fn(),
      backupRunSummary: vi.fn(),
      activeBackupJob: vi.fn(),
      requestBackup: vi.fn(),
      cancelBackupJob: vi.fn(),
      releaseBackup: vi.fn()
    }
  }
})

vi.mock('../hooks/usePolling', () => ({ usePolling: vi.fn() }))

import { api } from '../api'

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

const PINNED_BACKUP = {
  id: 'b-1', stamp: '20260911T143000Z', origin: 'requested', note: 'before the areas migration',
  location: '/backups/20260911T143000Z', size_bytes: 3 * 1024 * 1024, pinned: true, released_at: null,
  taken_at: '2026-09-11T14:30:00.000Z',
  components: [
    { name: 'supabase-db', file: 'supabase-db-20260911T143000Z.sql.gz', size_bytes: 2 * 1024 * 1024, sha256: 'a' },
    { name: 'timescaledb', file: 'timescaledb-20260911T143000Z.sql.gz', size_bytes: 1024 * 1024, sha256: 'b' },
    { name: 'forge', file: 'forge-20260911T143000Z.tar.gz', size_bytes: 1024, sha256: 'c' }
  ]
}
const PINNED = {
  id: 'j-1', status: 'COMPLETED', origin: 'requested', note: 'before the areas migration', error: null,
  created_at: '2026-09-11T14:29:50.000Z', started_at: '2026-09-11T14:30:00.000Z',
  finished_at: '2026-09-11T14:33:00.000Z', backup: PINNED_BACKUP
}
const SCHEDULED = {
  ...PINNED, id: 'j-2', origin: 'scheduled', note: null,
  created_at: '2026-09-10T02:30:00.000Z', started_at: '2026-09-10T02:30:00.000Z', finished_at: '2026-09-10T02:33:00.000Z',
  backup: { ...PINNED_BACKUP, id: 'b-2', stamp: '20260910T023000Z', origin: 'scheduled', note: null, pinned: false, taken_at: '2026-09-10T02:30:00.000Z' }
}
const FAILED = {
  id: 'j-3', status: 'FAILED', origin: 'scheduled', note: null,
  error: 'pg_dump timescaledb failed: connection refused',
  created_at: '2026-09-12T02:30:00.000Z', started_at: '2026-09-12T02:30:05.000Z', finished_at: '2026-09-12T02:31:00.000Z',
  backup: null
}
const CANCELLED = {
  id: 'j-4', status: 'CANCELLED', origin: 'requested', note: 'wrong moment', error: null,
  created_at: '2026-09-09T10:00:00.000Z', started_at: null, finished_at: '2026-09-09T10:00:30.000Z', backup: null
}
const PRUNED = {
  ...SCHEDULED, id: 'j-5',
  created_at: '2026-08-20T02:30:00.000Z', started_at: '2026-08-20T02:30:00.000Z', finished_at: '2026-08-20T02:33:00.000Z',
  backup: null
}

/** Every run on the stack, newest first, as the database would hand them back. */
const ALL = [FAILED, PINNED, SCHEDULED, CANCELLED, PRUNED]

/** listBackupRuns over a fixed set of runs, honouring the filter and the page size as the query does. */
function serveRuns(rows) {
  api.listBackupRuns.mockImplementation(async ({ statuses, limit }) => {
    const matching = rows.filter(r => statuses.includes(r.status))
    return { runs: matching.slice(0, limit), more: matching.length > limit }
  })
}

/** A stack whose last run succeeded two hours ago. */
const HEALTHY = {
  firstRecordedAt: '2026-08-01T02:30:00.000Z',
  lastSuccess: { id: 'j-9', status: 'COMPLETED', started_at: hoursAgo(2), finished_at: hoursAgo(2) },
  latestOutcome: { id: 'j-9', status: 'COMPLETED', started_at: hoursAgo(2), finished_at: hoursAgo(2) }
}

function renderTab() {
  const props = { showToast: vi.fn() }
  const result = render(<BackupsTab {...props} />)
  return { ...result, props }
}

beforeEach(() => {
  vi.clearAllMocks()
  serveRuns(ALL)
  api.backupRunSummary.mockResolvedValue(HEALTHY)
  api.activeBackupJob.mockResolvedValue(null)
})

describe('the list of runs', () => {
  it('lists a completed run with its backup: note, size, contents and retention', async () => {
    renderTab()
    const pinned = await screen.findByTestId('run-j-1')
    expect(pinned).toHaveTextContent('Completed')
    expect(pinned).toHaveTextContent('20260911T143000Z')
    expect(pinned).toHaveTextContent('before the areas migration')
    expect(pinned).toHaveTextContent('3.0 MiB')
    expect(pinned).toHaveTextContent('platform database, historian, forge')
    expect(pinned).toHaveTextContent('Pinned')
    expect(pinned).toHaveTextContent('On request')

    const scheduled = screen.getByTestId('run-j-2')
    expect(scheduled).toHaveTextContent('Scheduled')
    expect(scheduled).toHaveTextContent('Retention window')
    // Only a pinned backup can be released.
    expect(pinned.querySelector('button')).toHaveTextContent('Release')
    expect(scheduled.querySelector('button')).toBeNull()
  })

  it('lists a failed run with its status and the reason the service gave', async () => {
    renderTab()
    const failed = await screen.findByTestId('run-j-3')
    expect(failed).toHaveTextContent('Failed')
    expect(failed).toHaveTextContent('pg_dump timescaledb failed: connection refused')
    expect(failed.querySelector('button')).toBeNull()
  })

  it('shows the start of a long reason on the row and the whole of it in the tooltip', async () => {
    const reason = `pg_dump supabase-db failed: ${'x'.repeat(400)}`
    serveRuns([{ ...FAILED, error: reason }])
    renderTab()
    const failed = await screen.findByTestId('run-j-3')
    const cell = within(failed).getByTitle(reason)
    expect(cell.textContent.length).toBeLessThan(reason.length)
    expect(cell.textContent.endsWith('…')).toBe(true)
  })

  it('lists a cancelled run as cancelled, with no backup', async () => {
    renderTab()
    const cancelled = await screen.findByTestId('run-j-4')
    expect(cancelled).toHaveTextContent('Cancelled')
    expect(cancelled).toHaveTextContent('Withdrawn before the service claimed it')
    expect(cancelled).toHaveTextContent('wrong moment')
  })

  it('keeps a completed run whose backup the retention window pruned, and says so', async () => {
    renderTab()
    const pruned = await screen.findByTestId('run-j-5')
    expect(pruned).toHaveTextContent('Completed')
    expect(pruned).toHaveTextContent('Pruned by the retention window')
    expect(pruned.querySelector('button')).toBeNull()
  })

  it('lists newest first, in the order the query returns', async () => {
    renderTab()
    await screen.findByTestId('run-j-3')
    expect(screen.getAllByTestId(/^run-/).map(r => r.dataset.testid)).toEqual(['run-j-3', 'run-j-1', 'run-j-2', 'run-j-4', 'run-j-5'])
  })
})

describe('the filter and the pages', () => {
  const filter = () => screen.getByLabelText('Run status filter')

  it('asks for every finished run by default, a page of 30', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED', 'FAILED', 'CANCELLED'], limit: 30 })
  })

  it('shows only the failed runs under Failed', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    fireEvent.change(filter(), { target: { value: 'failed' } })
    await waitFor(() => expect(screen.queryByTestId('run-j-1')).toBeNull())
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['FAILED'], limit: 30 })
    expect(screen.getAllByTestId(/^run-/).map(r => r.dataset.testid)).toEqual(['run-j-3'])
  })

  it('shows only the completed runs under Completed, pruned ones included, and no cancelled one', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    fireEvent.change(filter(), { target: { value: 'completed' } })
    await waitFor(() => expect(screen.queryByTestId('run-j-3')).toBeNull())
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED'], limit: 30 })
    expect(screen.getAllByTestId(/^run-/).map(r => r.dataset.testid)).toEqual(['run-j-1', 'run-j-2', 'run-j-5'])
  })

  it('says so when a filter matches nothing', async () => {
    serveRuns([PINNED, SCHEDULED])
    renderTab()
    await screen.findByTestId('run-j-1')
    fireEvent.change(filter(), { target: { value: 'failed' } })
    expect(await screen.findByText('No run has failed.')).toBeInTheDocument()
  })

  it('offers Show more while there is an older page, and asks for 30 more runs', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      ...PRUNED, id: `m-${i}`, finished_at: new Date(Date.UTC(2026, 8, 20) - i * 86400000).toISOString()
    }))
    serveRuns(many)
    renderTab()
    await screen.findByTestId('run-m-0')
    expect(screen.getAllByTestId(/^run-/)).toHaveLength(30)

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(screen.getAllByTestId(/^run-/)).toHaveLength(45))
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED', 'FAILED', 'CANCELLED'], limit: 60 })
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('goes back to the first page when the filter changes', async () => {
    serveRuns(Array.from({ length: 45 }, (_, i) => ({ ...PRUNED, id: `m-${i}` })))
    renderTab()
    await screen.findByTestId('run-m-0')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(api.listBackupRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 60 })))

    fireEvent.change(filter(), { target: { value: 'completed' } })
    await waitFor(() => expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED'], limit: 30 }))
  })
})

describe('the current-state line', () => {
  const line = () => screen.queryByTestId('backup-state')

  it('says nothing while the last run succeeded recently, whatever failed before it', async () => {
    renderTab()
    // The list still holds the failed run: history, not the current state.
    await screen.findByTestId('run-j-3')
    expect(line()).toBeNull()
  })

  it('reports a failure nothing has succeeded since, naming the last good backup', async () => {
    api.backupRunSummary.mockResolvedValue({
      ...HEALTHY,
      lastSuccess: { id: 'j-1', status: 'COMPLETED', started_at: '2026-09-11T14:30:00.000Z' },
      latestOutcome: { id: 'j-3', status: 'FAILED', started_at: hoursAgo(1), finished_at: hoursAgo(1) }
    })
    renderTab()
    await screen.findByTestId('run-j-3')
    expect(line()).toHaveTextContent('The last backup failed, and none has succeeded since.')
    expect(line()).toHaveTextContent(/The last good backup was taken .*2026/)
  })

  it('says no backup has succeeded yet when every run so far has failed', async () => {
    api.backupRunSummary.mockResolvedValue({
      firstRecordedAt: hoursAgo(3),
      lastSuccess: null,
      latestOutcome: { id: 'j-3', status: 'FAILED', started_at: hoursAgo(1), finished_at: hoursAgo(1) }
    })
    renderTab()
    await screen.findByTestId('run-j-3')
    expect(line()).toHaveTextContent('The last backup failed')
    expect(line()).toHaveTextContent('No backup has succeeded yet.')
  })

  it(`reports a last success older than ${BACKUP_STALE_HOURS} hours, which is how a stopped service shows`, async () => {
    const lastGood = hoursAgo(BACKUP_STALE_HOURS + 4)
    api.backupRunSummary.mockResolvedValue({
      ...HEALTHY,
      lastSuccess: { id: 'j-1', status: 'COMPLETED', started_at: lastGood },
      latestOutcome: { id: 'j-1', status: 'COMPLETED', started_at: lastGood }
    })
    renderTab()
    await screen.findByTestId('run-j-1')
    expect(line()).toHaveTextContent(`No backup has succeeded in ${BACKUP_STALE_HOURS} hours`)
    expect(line()).toHaveTextContent('The last good backup was taken')
    expect(line()).toHaveTextContent('the backup service is probably not running')
  })

  it(`says nothing at ${BACKUP_STALE_HOURS - 1} hours: the nightly schedule has half a day in hand`, async () => {
    const lastGood = hoursAgo(BACKUP_STALE_HOURS - 1)
    api.backupRunSummary.mockResolvedValue({
      ...HEALTHY,
      lastSuccess: { id: 'j-1', status: 'COMPLETED', started_at: lastGood },
      latestOutcome: { id: 'j-1', status: 'COMPLETED', started_at: lastGood }
    })
    renderTab()
    await screen.findByTestId('run-j-1')
    expect(line()).toBeNull()
  })

  it('counts from the first job recorded until one succeeds', async () => {
    // A scheduled job queued two days ago that no service ever claimed.
    api.backupRunSummary.mockResolvedValue({ firstRecordedAt: hoursAgo(48), lastSuccess: null, latestOutcome: null })
    api.activeBackupJob.mockResolvedValue({ id: 'j-6', status: 'PENDING', origin: 'scheduled', created_at: hoursAgo(48) })
    serveRuns([])
    renderTab()
    expect(await screen.findByTestId('backup-state')).toHaveTextContent(`No backup has succeeded in ${BACKUP_STALE_HOURS} hours`)
    expect(line()).toHaveTextContent('None has succeeded since the first was queued')
    expect(screen.getByText('No run has finished yet.')).toBeInTheDocument()
  })

  it('says nothing about a first job queued recently', async () => {
    api.backupRunSummary.mockResolvedValue({ firstRecordedAt: hoursAgo(1), lastSuccess: null, latestOutcome: null })
    api.activeBackupJob.mockResolvedValue({ id: 'j-6', status: 'RUNNING', origin: 'scheduled', created_at: hoursAgo(1), started_at: hoursAgo(1) })
    serveRuns([])
    renderTab()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(line()).toBeNull()
  })

  it('shows the empty state and no warning on a stack whose backup service has never run', async () => {
    api.backupRunSummary.mockResolvedValue({ firstRecordedAt: null, lastSuccess: null, latestOutcome: null })
    serveRuns([])
    renderTab()
    expect(await screen.findByText(/No backups exist yet/)).toBeInTheDocument()
    expect(line()).toBeNull()
    expect(screen.queryByLabelText('Run status filter')).toBeNull()
  })
})

/** The header button opens the dialog; the dialog's own button is the one that asks. */
function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /Take a backup/ }))
  return screen.getByLabelText('Note (optional)').closest('.modal')
}

describe('asking', () => {
  it('asks for the note in a dialog, queues with it, and closes', async () => {
    api.requestBackup.mockResolvedValue('j-1')
    const { props } = renderTab()
    await screen.findByTestId('run-j-1')

    const modal = openDialog()
    expect(modal).toHaveTextContent(/pinned/)
    fireEvent.change(within(modal).getByLabelText('Note (optional)'), { target: { value: '  pre-upgrade  ' } })
    fireEvent.click(within(modal).getByRole('button', { name: /Take a backup/ }))

    await waitFor(() => expect(api.requestBackup).toHaveBeenCalledWith('pre-upgrade'))
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/queued/i), 'success')
    await waitFor(() => expect(screen.queryByLabelText('Note (optional)')).toBeNull())
  })

  it("keeps the dialog open and shows the gate's refusal verbatim", async () => {
    api.requestBackup.mockRejectedValue(new Error('request_backup: a scheduled backup is running. One backup runs at a time; wait for it to finish.'))
    const { props } = renderTab()
    await screen.findByTestId('run-j-1')
    const modal = openDialog()
    fireEvent.click(within(modal).getByRole('button', { name: /Take a backup/ }))
    await waitFor(() => expect(modal).toHaveTextContent(/One backup runs at a time/))
    expect(props.showToast).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument()
  })

  it('cancels the dialog without asking', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    const modal = openDialog()
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Note (optional)')).toBeNull()
    expect(api.requestBackup).not.toHaveBeenCalled()
  })

  it('disables the request while one is in flight, and offers Cancel only while it is queued', async () => {
    api.activeBackupJob.mockResolvedValue({ id: 'j-2', status: 'PENDING', origin: 'requested', note: 'now', created_at: new Date().toISOString() })
    api.cancelBackupJob.mockResolvedValue(true)
    const { props } = renderTab()
    const button = await screen.findByRole('button', { name: /Take a backup/ })
    expect(button).toBeDisabled()
    expect(screen.getByText('Queued')).toBeInTheDocument()
    // The icon sits on the label's baseline only if IconX forwards its style.
    expect(screen.getByRole('button', { name: /^Cancel$/ }).querySelector('svg')).toHaveStyle({ verticalAlign: '-2px' })

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    await waitFor(() => expect(api.cancelBackupJob).toHaveBeenCalledWith('j-2'))
    expect(props.showToast).toHaveBeenCalledWith('Backup cancelled.', 'success')
  })

  it('does not offer Cancel on a running backup', async () => {
    api.activeBackupJob.mockResolvedValue({ id: 'j-3', status: 'RUNNING', origin: 'scheduled', started_at: new Date().toISOString(), created_at: new Date().toISOString() })
    renderTab()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull()
  })

  it('says no service has claimed a request that has sat queued for minutes', async () => {
    api.activeBackupJob.mockResolvedValue({ id: 'j-4', status: 'PENDING', origin: 'requested', created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
    renderTab()
    expect(await screen.findByText(/No backup service has claimed this/)).toBeInTheDocument()
  })
})

describe('releasing', () => {
  it('confirms, saying nothing is deleted now, then releases', async () => {
    api.releaseBackup.mockResolvedValue(true)
    const { props } = renderTab()
    const pinned = await screen.findByTestId('run-j-1')
    fireEvent.click(pinned.querySelector('button'))

    const modal = screen.getByText(/Nothing is deleted now/).closest('.modal')
    expect(modal).toHaveTextContent('before the areas migration')
    fireEvent.click(within(modal).getByRole('button', { name: 'Release' }))

    await waitFor(() => expect(api.releaseBackup).toHaveBeenCalledWith('b-1'))
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/retention window now applies/), 'success')
  })
})

describe('the page is an Administrator page', () => {
  /**
   * Filed by retention rather than by permission: a backup is something kept against a timer and
   * restored from, which is what Cold Storage and Archived Entities are too. Administrator-only is
   * still true of the page, it just is not what the group means.
   */
  it('sits in the retention group for an Administrator and nowhere for anyone else', () => {
    const grant = () => true
    const forAdmin = groupedNav(TABS.filter(t => tabIsVisible(t, grant, 'Administrator')))
    expect(forAdmin.find(g => g.id === 'retention').tabs.map(t => t.id)).toEqual(['cold-storage', 'backups', 'archives'])

    for (const role of ['Shopfloor_Manager', 'Auditor', 'Operator']) {
      const visible = TABS.filter(t => tabIsVisible(t, grant, role)).map(t => t.id)
      expect(visible).not.toContain('backups')
    }
  })
})
