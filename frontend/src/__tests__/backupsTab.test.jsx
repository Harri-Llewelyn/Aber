import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BackupsTab } from '../components/tabs/BackupsTab'
import { tabIsVisible, TABS, groupedNav } from '../App'

/**
 * The Backups page. What has to hold: the page never takes a backup itself, only queues one and
 * shows what the service did; a queued request that nobody claims says so, because a stack with
 * no service running is the likeliest reason; a pinned backup is released through a confirmation
 * that says nothing is deleted at that moment; and the page is an Administrator's alone.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listBackups: vi.fn(),
      activeBackupJob: vi.fn(),
      recentBackupJobs: vi.fn(),
      requestBackup: vi.fn(),
      cancelBackupJob: vi.fn(),
      releaseBackup: vi.fn()
    }
  }
})

vi.mock('../hooks/usePolling', () => ({ usePolling: vi.fn() }))

import { api } from '../api'

const PINNED = {
  id: 'b-1', stamp: '20260911T143000Z', origin: 'requested', note: 'before the areas migration',
  location: '/backups/20260911T143000Z', size_bytes: 3 * 1024 * 1024, pinned: true, released_at: null,
  taken_at: '2026-09-11T14:30:00.000Z',
  components: [
    { name: 'supabase-db', file: 'supabase-db-20260911T143000Z.sql.gz', size_bytes: 2 * 1024 * 1024, sha256: 'a' },
    { name: 'timescaledb', file: 'timescaledb-20260911T143000Z.sql.gz', size_bytes: 1024 * 1024, sha256: 'b' },
    { name: 'forge', file: 'forge-20260911T143000Z.tar.gz', size_bytes: 1024, sha256: 'c' }
  ]
}
const SCHEDULED = {
  ...PINNED, id: 'b-2', stamp: '20260910T023000Z', origin: 'scheduled', note: null, pinned: false,
  taken_at: '2026-09-10T02:30:00.000Z'
}

function renderTab() {
  const props = { showToast: vi.fn() }
  const result = render(<BackupsTab {...props} />)
  return { ...result, props }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listBackups.mockResolvedValue([PINNED, SCHEDULED])
  api.activeBackupJob.mockResolvedValue(null)
  api.recentBackupJobs.mockResolvedValue([])
})

describe('what exists', () => {
  it('lists each backup with its note, size, components and retention state', async () => {
    renderTab()
    const pinned = await screen.findByTestId('backup-20260911T143000Z')
    expect(pinned).toHaveTextContent('before the areas migration')
    expect(pinned).toHaveTextContent('3.0 MiB')
    expect(pinned).toHaveTextContent('platform database, historian, forge')
    expect(pinned).toHaveTextContent('Pinned')
    expect(pinned).toHaveTextContent('On request')

    const scheduled = screen.getByTestId('backup-20260910T023000Z')
    expect(scheduled).toHaveTextContent('Scheduled')
    expect(scheduled).toHaveTextContent('Retention window')
    // Only a pinned backup can be released.
    expect(pinned.querySelector('button')).toHaveTextContent('Release')
    expect(scheduled.querySelector('button')).toBeNull()
  })

  it('shows a failed job with the reason the service gave', async () => {
    api.recentBackupJobs.mockResolvedValue([
      { id: 'j-9', status: 'FAILED', origin: 'scheduled', note: null, error: 'pg_dump timescaledb failed: connection refused', finished_at: '2026-09-11T02:31:00.000Z' }
    ])
    renderTab()
    expect(await screen.findByText(/pg_dump timescaledb failed/)).toBeInTheDocument()
  })
})

describe('asking', () => {
  it('queues a backup with the note and clears the field', async () => {
    api.requestBackup.mockResolvedValue('j-1')
    const { props } = renderTab()
    await screen.findByTestId('backup-20260911T143000Z')

    fireEvent.change(screen.getByLabelText('Backup note'), { target: { value: '  pre-upgrade  ' } })
    fireEvent.click(screen.getByRole('button', { name: /Take a backup/ }))

    await waitFor(() => expect(api.requestBackup).toHaveBeenCalledWith('pre-upgrade'))
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/queued/i), 'success')
    await waitFor(() => expect(screen.getByLabelText('Backup note')).toHaveValue(''))
  })

  it("surfaces the gate's refusal verbatim", async () => {
    api.requestBackup.mockRejectedValue(new Error('request_backup: a scheduled backup is running. One backup runs at a time; wait for it to finish.'))
    const { props } = renderTab()
    await screen.findByTestId('backup-20260911T143000Z')
    fireEvent.click(screen.getByRole('button', { name: /Take a backup/ }))
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/One backup runs at a time/), 'error'))
  })

  it('disables the request while one is in flight, and offers Cancel only while it is queued', async () => {
    api.activeBackupJob.mockResolvedValue({ id: 'j-2', status: 'PENDING', origin: 'requested', note: 'now', created_at: new Date().toISOString() })
    api.cancelBackupJob.mockResolvedValue(true)
    const { props } = renderTab()
    const button = await screen.findByRole('button', { name: /Take a backup/ })
    expect(button).toBeDisabled()
    expect(screen.getByText('Queued')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(api.cancelBackupJob).toHaveBeenCalledWith('j-2'))
    expect(props.showToast).toHaveBeenCalledWith('Backup cancelled.', 'success')
  })

  it('does not offer Cancel on a running backup', async () => {
    api.activeBackupJob.mockResolvedValue({ id: 'j-3', status: 'RUNNING', origin: 'scheduled', started_at: new Date().toISOString(), created_at: new Date().toISOString() })
    renderTab()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
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
    const pinned = await screen.findByTestId('backup-20260911T143000Z')
    fireEvent.click(pinned.querySelector('button'))

    const modal = screen.getByText(/Nothing is deleted now/).closest('.modal')
    expect(modal).toHaveTextContent('before the areas migration')
    fireEvent.click(within(modal).getByRole('button', { name: 'Release' }))

    await waitFor(() => expect(api.releaseBackup).toHaveBeenCalledWith('b-1'))
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/retention window now applies/), 'success')
  })
})

describe('the page is an Administrator page', () => {
  it('sits in the administration group for an Administrator and nowhere for anyone else', () => {
    const grant = () => true
    const forAdmin = groupedNav(TABS.filter(t => tabIsVisible(t, grant, 'Administrator')))
    expect(forAdmin.find(g => g.id === 'admin').tabs.map(t => t.id)).toEqual(['access-control', 'backups', 'settings'])

    for (const role of ['Shopfloor_Manager', 'Auditor', 'Operator']) {
      const visible = TABS.filter(t => tabIsVisible(t, grant, role)).map(t => t.id)
      expect(visible).not.toContain('backups')
    }
  })
})
