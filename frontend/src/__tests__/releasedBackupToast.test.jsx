import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The toast for a released backup opens the run that took it. `?run=` is a run's id, a `backup_jobs`
 * row, and a backup is a row of its own with the run in `job_id`, so the two ids differ here.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listBackupRuns: vi.fn(),
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
import { ToastStack } from '../components/common/Toast'
import { useToast } from '../hooks/useToast'
import { currentUrl, navigate } from '../hooks/useUrlState'

const BACKUP = {
  id: 'backup-row', job_id: 'run-row', stamp: '20260911T143000Z', origin: 'requested', note: 'before the upgrade',
  location: '/backups/20260911T143000Z', size_bytes: 1024, pinned: true, released_at: null,
  taken_at: '2026-09-11T14:30:00.000Z', components: [],
}
const RUN = {
  id: 'run-row', status: 'COMPLETED', origin: 'requested', note: 'before the upgrade', error: null,
  created_at: '2026-09-11T14:29:50.000Z', started_at: '2026-09-11T14:30:00.000Z',
  finished_at: '2026-09-11T14:33:00.000Z', backup: BACKUP,
}

function Page() {
  const { toasts, showToast, dismissToast, expireToast } = useToast()
  return (
    <>
      <BackupsTab showToast={showToast} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} onExpire={expireToast} />
    </>
  )
}

const drawer = () => document.querySelector('.context-panel-open')

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.history.pushState({}, '', '/backups')
  api.listBackupRuns.mockResolvedValue({ runs: [RUN], total: 1 })
  api.backupRunSummary.mockResolvedValue({ firstRecordedAt: RUN.created_at, lastSuccess: RUN, latestOutcome: RUN })
  api.activeBackupJob.mockResolvedValue(null)
  api.newestBackupIds.mockResolvedValue([])
  api.backupOffsiteDestination.mockResolvedValue(null)
  delete globalThis.__ABER_CONFIG__
})

describe('the toast for a released backup', () => {
  it.each([
    ['released', true, /Released the backup from /],
    ['already released', false, /That backup was not pinned/],
  ])('opens the run of a backup that was %s', async (_, released, message) => {
    api.releaseBackup.mockResolvedValue(released)
    render(<Page />)
    const row = await screen.findByTestId('run-run-row')
    fireEvent.click(within(row).getByRole('button', { name: 'Release' }))
    const dialog = screen.getByText(/Nothing is deleted now/).closest('.modal')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release' }))

    await waitFor(() => expect(api.releaseBackup).toHaveBeenCalledWith('backup-row'))
    const link = await screen.findByRole('link', { name: message })
    // Followed from another page, as a toast read later is.
    act(() => navigate('/devices'))
    expect(drawer()).toBeNull()

    fireEvent.click(link)
    expect(currentUrl()).toBe('/backups?run=run-row')
    await waitFor(() => expect(drawer()).not.toBeNull())
    expect(within(drawer()).getByText('20260911T143000Z')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: message })).toBeNull()
  })
})
