import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A link to one backup run opens its drawer, whatever the list has loaded. The list holds the 30
 * newest runs, and a pinned backup is kept until it is released, so its run can be older than every
 * loaded page; a status filter in the address can leave it out too. Such a run is read on its own,
 * the filter that leaves it out is cleared as the page is arrived at, and a run nobody has is said
 * where the drawer would be.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listBackupRuns: vi.fn(),
      backupRun: vi.fn(),
      backupRunSummary: vi.fn(),
      activeBackupJob: vi.fn(),
      newestBackupIds: vi.fn(),
      backupOffsiteDestination: vi.fn(),
      releaseBackup: vi.fn(),
    }
  }
})
vi.mock('../hooks/usePolling', () => ({ usePolling: vi.fn() }))

import { api } from '../api'
import { BackupsTab } from '../components/tabs/BackupsTab'
import { dropdownButton, pick } from '../test/listFilters'

const OLD_ID = 'b0c4e000-0000-4000-8000-000000001672'
const NOBODY_ID = 'b0c4e000-0000-4000-8000-00000000dead'

const OLD_BACKUP = {
  id: 'b0c4e000-0000-4000-8000-0000000016b1', job_id: OLD_ID, stamp: '20260611T143000Z', origin: 'requested',
  note: 'before the summer shutdown', location: '/backups/20260611T143000Z', size_bytes: 1024, pinned: true,
  released_at: null, taken_at: '2026-06-11T14:30:00.000Z', components: [],
}
const OLD_RUN = {
  id: OLD_ID, status: 'COMPLETED', origin: 'requested', note: 'before the summer shutdown', error: null,
  created_at: '2026-06-11T14:29:50.000Z', started_at: '2026-06-11T14:30:00.000Z',
  finished_at: '2026-06-11T14:33:00.000Z', backup: OLD_BACKUP,
}

/** Thirty nightly runs since, newest first: the whole first page, none of them the old one. */
const NIGHTLY = Array.from({ length: 30 }, (_, i) => {
  const day = String(30 - i).padStart(2, '0')
  return {
    id: `nightly-${day}`, status: i % 10 === 3 ? 'FAILED' : 'COMPLETED', origin: 'scheduled', note: null,
    error: i % 10 === 3 ? 'pg_dump failed' : null,
    created_at: `2026-09-${day}T02:30:00.000Z`, started_at: `2026-09-${day}T02:30:00.000Z`,
    finished_at: `2026-09-${day}T02:33:00.000Z`, backup: null,
  }
})

function serveRuns(rows) {
  api.listBackupRuns.mockImplementation(async ({ statuses, limit }) => {
    const matching = rows.filter(r => statuses.includes(r.status))
    return { runs: matching.slice(0, limit), total: matching.length }
  })
}

const drawer = () => document.querySelector('.context-panel-open')
const query = () => new URLSearchParams(window.location.search)

function arrive(search) {
  window.history.replaceState(null, '', `/backups?${search}`)
  return render(<BackupsTab showToast={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/backups')
  serveRuns([...NIGHTLY, OLD_RUN])
  api.backupRun.mockImplementation(async (id) => [...NIGHTLY, OLD_RUN].find(r => r.id === id) || null)
  api.backupRunSummary.mockResolvedValue({ firstRecordedAt: OLD_RUN.created_at, lastSuccess: NIGHTLY[0], latestOutcome: NIGHTLY[0] })
  api.activeBackupJob.mockResolvedValue(null)
  api.newestBackupIds.mockResolvedValue([])
  api.backupOffsiteDestination.mockResolvedValue(null)
  delete globalThis.__ABER_CONFIG__
})

describe('a link to a run past the first page', () => {
  it('reads that one run and opens its drawer', async () => {
    arrive(`run=${OLD_ID}`)
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(api.backupRun).toHaveBeenCalledWith(OLD_ID)
    expect(within(drawer()).getByText('20260611T143000Z')).toBeInTheDocument()
    expect(drawer()).toHaveTextContent('before the summer shutdown')
    // The list stays the first page: the run is in the drawer, not added to the rows.
    expect(screen.queryByTestId(`run-${OLD_ID}`)).toBeNull()
    expect(screen.getAllByTestId(/^run-nightly-/)).toHaveLength(30)
  })

  it('offers Release on its pinned backup, and reads it again after the release', async () => {
    api.releaseBackup.mockResolvedValue(true)
    arrive(`run=${OLD_ID}`)
    await waitFor(() => expect(drawer()).not.toBeNull())
    const reads = api.backupRun.mock.calls.length
    api.backupRun.mockResolvedValue({ ...OLD_RUN, backup: { ...OLD_BACKUP, pinned: false, released_at: '2026-09-30T09:00:00.000Z' } })

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Release' }))
    const dialog = screen.getByText(/Nothing is deleted now/).closest('.modal')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release' }))

    await waitFor(() => expect(api.releaseBackup).toHaveBeenCalledWith(OLD_BACKUP.id))
    await waitFor(() => expect(drawer()).toHaveTextContent(/Released /))
    expect(api.backupRun.mock.calls.length).toBeGreaterThan(reads)
    expect(within(drawer()).queryByRole('button', { name: 'Release' })).toBeNull()
  })

  it('does not read a run the list holds on its own', async () => {
    arrive('run=nightly-29')
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(screen.getByTestId('run-nightly-29')).toHaveClass('row-selected')
    expect(api.backupRun).not.toHaveBeenCalled()
  })
})

describe('a status filter in the address that leaves the run out', () => {
  it('is cleared for it, and the drawer opens', async () => {
    arrive(`run=${OLD_ID}&status=failed`)
    await waitFor(() => expect(drawer()).toHaveTextContent('before the summer shutdown'))
    await waitFor(() => expect(query().get('status')).toBeNull())
    expect(dropdownButton('Status')).toHaveTextContent('Any status')
    expect(query().get('run')).toBe(OLD_ID)
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED', 'FAILED', 'CANCELLED'], limit: 30 })
  })

  it('is cleared for a run the first page holds but the filter hides', async () => {
    arrive('run=nightly-30&status=failed')
    await waitFor(() => expect(screen.getByTestId('run-nightly-30')).toHaveClass('row-selected'))
    expect(query().get('status')).toBeNull()
    expect(drawer()).not.toBeNull()
  })

  it('is kept when it holds the run', async () => {
    arrive('run=nightly-27&status=failed')
    await waitFor(() => expect(screen.getByTestId('run-nightly-27')).toHaveClass('row-selected'))
    expect(query().get('status')).toBe('failed')
    expect(api.backupRun).not.toHaveBeenCalled()
  })

  it('stays when the reader chooses it with the drawer open', async () => {
    arrive('')
    fireEvent.click(within(await screen.findByTestId('run-nightly-30')).getAllByRole('cell')[0])
    expect(drawer()).not.toBeNull()
    pick('Status', 'failed')
    await waitFor(() => expect(screen.queryByTestId('run-nightly-30')).toBeNull())
    expect(query().get('status')).toBe('failed')
    await waitFor(() => expect(api.backupRun).toHaveBeenCalledWith('nightly-30'))
    expect(drawer()).not.toBeNull()
  })
})

describe('a link to a run nobody has', () => {
  it('says so where the drawer would be, and closes', async () => {
    arrive(`run=${NOBODY_ID}`)
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(drawer()).toHaveAttribute('aria-label', 'No such run backup run details')
    expect(within(drawer()).getByRole('list', { name: 'Warnings' }))
      .toHaveTextContent('No finished backup run has this id. One still queued or running is shown above the list, and is listed when it ends.')
    expect(drawer().querySelector('.context-action')).toBeNull()

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Close details' }))
    expect(drawer()).toBeNull()
    expect(query().get('run')).toBeNull()
  })

  it('says a read that failed, beside no run', async () => {
    api.backupRun.mockRejectedValue(new Error('permission denied for table backup_jobs'))
    arrive(`run=${OLD_ID}`)
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(within(drawer()).getByRole('list', { name: 'Warnings' }))
      .toHaveTextContent('Could not read this run: permission denied for table backup_jobs')
  })

  it('leaves a database\'s own backup to its panel, and reads no run for it', async () => {
    arrive('run=historian')
    await screen.findByTestId('run-nightly-30')
    expect(drawer()).toBeNull()
    expect(api.backupRun).not.toHaveBeenCalled()
  })
})
