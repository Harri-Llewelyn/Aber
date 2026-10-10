import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BackupsTab, BACKUP_STALE_HOURS, physicalBackupState, keptBecause } from '../components/tabs/BackupsTab'
import { nextHistorianBackup } from '../utils/historianBackupSchedule'
import { tabIsVisible, TABS, groupedNav } from '../navigation'

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
      newestBackupIds: vi.fn(),
      backupOffsiteDestination: vi.fn(),
      setBackupOffsiteDestination: vi.fn(),
      setBackupOffsiteCredential: vi.fn(),
      clearBackupOffsiteDestination: vi.fn(),
      requestBackup: vi.fn(),
      cancelBackupJob: vi.fn(),
      releaseBackup: vi.fn(),
      historianBackupState: vi.fn(),
      platformBackupState: vi.fn()
    }
  }
})

vi.mock('../hooks/usePolling', () => ({ usePolling: vi.fn() }))

import { api } from '../api'
import { expectCardHeading } from '../test/cardHeading'

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
    return { runs: matching.slice(0, limit), total: matching.length }
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
  api.newestBackupIds.mockResolvedValue([])
  api.backupOffsiteDestination.mockResolvedValue({
    endpoint: '', region: '', bucket: '', prefix: '', access_key_id: '', recipient: '', path_style: false, credentialSet: false
  })
  api.historianBackupState.mockResolvedValue(null)
  api.platformBackupState.mockResolvedValue(null)
  delete globalThis.__ABER_CONFIG__
})

describe('the list of runs', () => {
  it('names the page in its card header, with the destination and the action, and no count', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    const header = expectCardHeading('Backups', /newest first/)
    expect(header.querySelector('.section-count')).toBeNull()
    const buttons = within(header).getAllByRole('button').map(b => b.textContent.trim())
    expect(buttons).toEqual(['Set a destination', 'Take a backup'])
  })

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

  it('cuts a long reason to one line on the row, and gives the whole of it in the run\'s panel', async () => {
    const reason = `pg_dump supabase-db failed: ${'x'.repeat(400)}`
    serveRuns([{ ...FAILED, error: reason }])
    renderTab()
    const failed = await screen.findByTestId('run-j-3')
    expect(within(failed).getByTitle(reason)).toHaveClass('truncate')
    fireEvent.click(within(failed).getAllByRole('cell')[2])
    expect(within(panel()).getByText(reason)).toBeInTheDocument()
  })

  it('keeps the short columns on one line', async () => {
    renderTab()
    const cells = within(await screen.findByTestId('run-j-1')).getAllByRole('cell')
    // When, Origin, Size, Retention and Off site; Holds cuts to a line like the reason.
    for (const i of [0, 2, 4, 6, 7]) expect(cells[i]).toHaveClass('backup-run-short')
    expect(cells[5].firstElementChild).toHaveClass('truncate')
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

  it('puts the outcome of a run with no backup under its status, and a dash in the file columns', async () => {
    renderTab()
    const failed = await screen.findByTestId('run-j-3')
    const cells = within(failed).getAllByRole('cell')
    // When, Status, Origin, Note, Size, Holds, Retention, Off site, actions.
    expect(cells).toHaveLength(9)
    expect(cells[1]).toHaveTextContent('pg_dump timescaledb failed: connection refused')
    for (const i of [4, 5, 6, 7]) expect(cells[i]).toHaveTextContent('—')
  })

  it('says how many runs under the filter are loaded at the foot, beside Show more', async () => {
    serveRuns(Array.from({ length: 45 }, (_, i) => ({ ...PRUNED, id: `m-${i}` })))
    renderTab()
    await screen.findByTestId('run-m-0')
    const foot = document.querySelector('.list-foot')
    expect(foot).toHaveTextContent('30 of 45')
    expect(within(foot).getByRole('button', { name: 'Show 15 more' })).toBeInTheDocument()
    expect(document.querySelector('.section-count')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more' }))
    await waitFor(() => expect(document.querySelector('.list-foot')).toHaveTextContent('All 45 shown.'))
  })

  it('shows no count when nothing has run', async () => {
    api.backupRunSummary.mockResolvedValue({ firstRecordedAt: null, lastSuccess: null, latestOutcome: null })
    serveRuns([])
    renderTab()
    await screen.findByText('No backups yet.')
    expect(document.querySelector('.section-count')).toBeNull()
    expect(document.querySelector('.list-foot')).toBeNull()
  })

  it('lists newest first, in the order the query returns', async () => {
    renderTab()
    await screen.findByTestId('run-j-3')
    expect(screen.getAllByTestId(/^run-/).map(r => r.dataset.testid)).toEqual(['run-j-3', 'run-j-1', 'run-j-2', 'run-j-4', 'run-j-5'])
  })
})

/** The run panel, while open. */
const panel = () => document.querySelector('.context-panel-open')

describe('a run\'s panel', () => {
  it('opens from anywhere on the row, with the times and the files', async () => {
    renderTab()
    const row = await screen.findByTestId('run-j-1')
    expect(row).toHaveClass('row-selectable')
    expect(panel()).toBeNull()

    fireEvent.click(within(row).getByText('On request'))
    expect(row).toHaveClass('row-selected')
    const open = panel()
    expect(open).toHaveAttribute('aria-label', expect.stringMatching(/backup run/))
    expect(open.querySelector('.context-panel-icon svg')).not.toBeNull()
    for (const label of ['Queued', 'Started', 'Finished']) expect(within(open).getByText(label)).toBeInTheDocument()
    expect(within(open).getByText('/backups/20260911T143000Z')).toBeInTheDocument()
    const files = [...open.querySelectorAll('.backup-files li')].map(li => li.textContent)
    expect(files).toEqual([
      'supabase-db-20260911T143000Z.sql.gz2.0 MiB',
      'timescaledb-20260911T143000Z.sql.gz1.0 MiB',
      'forge-20260911T143000Z.tar.gz1.0 KiB'
    ])

    // A second click on the same row closes it.
    fireEvent.click(within(row).getByText('On request'))
    expect(panel()).toBeNull()
  })

  it('opens on Enter or Space from the row, and not from the row\'s own Release button', async () => {
    renderTab()
    const row = await screen.findByTestId('run-j-1')
    expect(row).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(within(row).getByRole('button', { name: 'Release' }), { key: 'Enter' })
    expect(panel()).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Release' }))
    expect(panel()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(panel()).not.toBeNull()
    expect(panel()).toHaveTextContent('before the areas migration')

    fireEvent.keyDown(row, { key: ' ' })
    expect(panel()).toBeNull()
    fireEvent.keyDown(row, { key: ' ' })
    expect(panel()).not.toBeNull()
  })

  it('makes Release the one primary action on a pinned backup, and offers none on a failed run', async () => {
    renderTab()
    fireEvent.click(within(await screen.findByTestId('run-j-1')).getAllByRole('cell')[0])
    const actions = panel().querySelectorAll('.context-action')
    expect([...actions].map(a => a.textContent.trim())).toEqual(['Release'])
    expect(actions[0]).toHaveClass('btn-primary')

    fireEvent.click(within(screen.getByTestId('run-j-3')).getAllByRole('cell')[0])
    expect(panel()).toHaveTextContent('pg_dump timescaledb failed: connection refused')
    expect(panel().querySelector('.context-action')).toBeNull()
  })
})

describe('the retention floor', () => {
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
  const scheduled = (id, days) => ({
    ...SCHEDULED, id: `j-${id}`,
    backup: { ...SCHEDULED.backup, id: `b-${id}`, stamp: `2026090${id}T023000Z`, taken_at: daysAgo(days) }
  })

  it('says a backup past the window is kept as one of the newest three', async () => {
    globalThis.__ABER_CONFIG__ = { VITE_BACKUP_RETENTION_DAYS: '14' }
    serveRuns([scheduled(1, 20), scheduled(2, 21), scheduled(3, 22), scheduled(4, 23)])
    api.newestBackupIds.mockResolvedValue(['b-1', 'b-2', 'b-3'])
    renderTab()
    const kept = await screen.findByTestId('run-j-1')
    await waitFor(() => expect(kept).toHaveTextContent('Kept: one of the newest three'))
    expect(within(kept).getByTitle(/Older than the 14-day retention window/)).toBeInTheDocument()
    expect(screen.getByTestId('run-j-3')).toHaveTextContent('Kept: one of the newest three')
    // Past the window and outside the floor: the next prune takes it.
    expect(screen.getByTestId('run-j-4')).toHaveTextContent('Retention window')
    expect(api.newestBackupIds).toHaveBeenCalledWith(3)
  })

  it('says nothing about the floor for a backup still inside the window', async () => {
    globalThis.__ABER_CONFIG__ = { VITE_BACKUP_RETENTION_DAYS: '14' }
    serveRuns([scheduled(1, 2)])
    api.newestBackupIds.mockResolvedValue(['b-1'])
    renderTab()
    const row = await screen.findByTestId('run-j-1')
    expect(row).toHaveTextContent('Retention window')
    expect(row).not.toHaveTextContent('Kept')
  })

  it('says nothing about the floor when the page was not told the window', async () => {
    serveRuns([scheduled(1, 40)])
    api.newestBackupIds.mockResolvedValue(['b-1'])
    renderTab()
    expect(await screen.findByTestId('run-j-1')).toHaveTextContent('Retention window')
  })

  it('still lists the runs when the floor cannot be read', async () => {
    globalThis.__ABER_CONFIG__ = { VITE_BACKUP_RETENTION_DAYS: '14' }
    serveRuns([scheduled(1, 40)])
    api.newestBackupIds.mockRejectedValue(new Error('boom'))
    renderTab()
    expect(await screen.findByTestId('run-j-1')).toHaveTextContent('Retention window')
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('keeps Pinned for a pinned backup in the floor, and says when pruning is off', () => {
    const old = { taken_at: daysAgo(40), pinned: false }
    expect(keptBecause({ ...old, pinned: true }, { inFloor: true, retentionDays: 14 })).toBeNull()
    expect(keptBecause(old, { inFloor: true, retentionDays: 14 })).toBe('floor')
    expect(keptBecause(old, { inFloor: false, retentionDays: 14 })).toBeNull()
    expect(keptBecause(old, { inFloor: false, retentionDays: 0 })).toBe('off')
    expect(keptBecause(old, { inFloor: true, retentionDays: null })).toBeNull()
  })
})

describe('the off-site copy', () => {
  const DESTINATION = {
    endpoint: 'https://s3.eu-west-2.amazonaws.com', region: 'eu-west-2', bucket: 'aber-backups',
    prefix: 'site-a/backups', access_key_id: 'AKIAEXAMPLE', path_style: false,
    recipient: 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p', credentialSet: true
  }
  const BASE = 'https://s3.eu-west-2.amazonaws.com/aber-backups/site-a/backups/'
  const withCopy = (id, fields) => ({
    ...SCHEDULED, id: `j-${id}`,
    backup: { ...SCHEDULED.backup, id: `b-${id}`, stamp: `2026091${id}T023000Z`, ...fields }
  })

  /** The header button, and the text its aria-describedby names. */
  const destinationButton = (name) => {
    const button = screen.getByRole('button', { name })
    const description = document.getElementById(button.getAttribute('aria-describedby'))
    return { button, description }
  }

  it('warns, with an icon and a description, that every backup shares a disk when no destination is set', async () => {
    renderTab()
    await screen.findByRole('button', { name: 'Set a destination' })
    const { button, description } = destinationButton('Set a destination')
    expect(button).toHaveClass('btn', 'btn-warning', 'btn-sm')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(description).toHaveClass('sr-only')
    expect(description).toHaveTextContent('Every backup is on the same disk as the data it protects')
    expect(button).toHaveAttribute('title', description.textContent)
    expect(screen.queryByTestId('offsite-line')).toBeNull()
  })

  it('names what is missing from a destination that cannot run', async () => {
    api.backupOffsiteDestination.mockResolvedValue({ ...DESTINATION, recipient: '', credentialSet: false })
    renderTab()
    await waitFor(() => expect(destinationButton('Complete the destination').description).toHaveTextContent('The off-site copy cannot run'))
    const { button, description } = destinationButton('Complete the destination')
    expect(button).toHaveClass('btn-warning')
    expect(description).toHaveTextContent('the encryption recipient, the secret access key')
  })

  it('shows where copies go, and each backup\'s copy', async () => {
    api.backupOffsiteDestination.mockResolvedValue(DESTINATION)
    serveRuns([
      withCopy(1, { offsite_state: 'COPIED', offsite_location: `${BASE}20260911T023000Z/`, offsite_copied_at: '2026-09-11T02:40:00Z' }),
      withCopy(2, { offsite_state: 'FAILED', offsite_error: 'aws s3api put-object: AccessDenied', offsite_attempts: 3, offsite_attempted_at: '2026-09-12T03:00:00Z' }),
      withCopy(3, { offsite_state: 'PENDING' }),
      withCopy(4, { offsite_state: 'COPIED', offsite_location: 'https://old.example/b/p/20260914T023000Z/' })
    ])
    renderTab()
    const change = await screen.findByRole('button', { name: 'Change destination' })
    expect(change).toHaveClass('btn-ghost')
    expect(change).not.toHaveAttribute('aria-describedby')
    expect(change).toHaveAttribute('title', `Every backup is copied, encrypted, to ${BASE}`)
    expect(screen.getByTestId('run-j-1')).toHaveTextContent('Copied')
    const failed = screen.getByTestId('run-j-2')
    expect(failed).toHaveTextContent('Failed, retrying')
    expect(within(failed).getByTitle(/AccessDenied/)).toBeInTheDocument()
    expect(screen.getByTestId('run-j-3')).toHaveTextContent('Waiting')
    // Copied to a destination since replaced: the service copies it again.
    expect(screen.getByTestId('run-j-4')).toHaveTextContent('Waiting')
  })

  it('saves the destination and the key through the dialog, and states the circularity', async () => {
    api.setBackupOffsiteDestination.mockResolvedValue(true)
    api.setBackupOffsiteCredential.mockResolvedValue(true)
    const { props } = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Set a destination' }))
    expect(screen.getByTestId('offsite-circularity')).toHaveTextContent('Keep the bucket credentials and the decryption key outside this stack')

    const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
    type('S3 endpoint', ' https://minio.example:9000 ')
    type('Region', 'us-east-1')
    type('Bucket', 'backups')
    type('Key prefix', 'site-a')
    type('Access key ID', 'backup-writer')
    type('Encryption recipient', DESTINATION.recipient)
    type('Secret access key', ' s3cret ')
    fireEvent.click(screen.getByLabelText(/Address the bucket by path/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.setBackupOffsiteDestination).toHaveBeenCalledWith({
      endpoint: 'https://minio.example:9000', region: 'us-east-1', bucket: 'backups', prefix: 'site-a',
      access_key_id: 'backup-writer', recipient: DESTINATION.recipient, path_style: true
    }))
    expect(api.setBackupOffsiteCredential).toHaveBeenCalledWith('s3cret')
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/destination saved/i), 'success')
    await waitFor(() => expect(screen.queryByTestId('offsite-circularity')).toBeNull())
  })

  it('keeps the stored key when the field is left empty, and shows a refusal in the dialog', async () => {
    api.backupOffsiteDestination.mockResolvedValue(DESTINATION)
    api.setBackupOffsiteDestination.mockRejectedValue(new Error('backup_offsite.bucket must be an S3 bucket name'))
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Change destination' }))
    expect(screen.getByLabelText('Secret access key')).toHaveAttribute('placeholder', expect.stringMatching(/Stored/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/must be an S3 bucket name/)).toBeInTheDocument()
    expect(api.setBackupOffsiteCredential).not.toHaveBeenCalled()
  })

  it('removes the destination after asking', async () => {
    api.backupOffsiteDestination.mockResolvedValue(DESTINATION)
    api.clearBackupOffsiteDestination.mockResolvedValue(true)
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Change destination' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the destination' }))
    expect(screen.getByText(/Copies already made stay in the bucket/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.clearBackupOffsiteDestination).toHaveBeenCalled())
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

  it('offers Show 15 more while there is an older page, and asks for 30 more runs', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      ...PRUNED, id: `m-${i}`, finished_at: new Date(Date.UTC(2026, 8, 20) - i * 86400000).toISOString()
    }))
    serveRuns(many)
    renderTab()
    await screen.findByTestId('run-m-0')
    expect(screen.getAllByTestId(/^run-/)).toHaveLength(30)

    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more' }))
    await waitFor(() => expect(screen.getAllByTestId(/^run-/)).toHaveLength(45))
    expect(api.listBackupRuns).toHaveBeenLastCalledWith({ statuses: ['COMPLETED', 'FAILED', 'CANCELLED'], limit: 60 })
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull()
    expect(screen.getByText('All 45 shown.')).toBeInTheDocument()
  })

  it('goes back to the first page when the filter changes', async () => {
    serveRuns(Array.from({ length: 45 }, (_, i) => ({ ...PRUNED, id: `m-${i}` })))
    renderTab()
    await screen.findByTestId('run-m-0')
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more' }))
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
    expect(screen.getByText('No backups yet.')).toBeInTheDocument()
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
    expect(await screen.findByText('No backups yet.')).toBeInTheDocument()
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

describe('the historian row', () => {
  const physical = () => { globalThis.__ABER_CONFIG__ = { VITE_HISTORIAN_PHYSICAL_BACKUP: 'true' } }
  const row = () => screen.queryByTestId('historian-row')
  const line = () => screen.queryByTestId('historian-state')
  /** A historian backing itself up daily at 01:00 UTC, full on Sundays, last good two hours ago. */
  const CURRENT = {
    hour_utc: 1, full_on: 0, first_recorded_at: hoursAgo(24 * 20),
    last_attempt_at: hoursAgo(2), last_success_at: hoursAgo(2), last_success_kind: 'diff',
    last_success_label: '20261003-010002F_20261003-010004D', last_full_at: hoursAgo(24 * 3),
    repo_bytes: 3 * 1024 * 1024 * 1024, last_failure_at: null, last_failure_kind: null, last_failure_detail: null,
    request_at: null, request_claimed_at: null, request_finished_at: null, request_succeeded: null
  }
  const serveHistorian = (h) => api.historianBackupState.mockResolvedValue(h)

  it('is absent, and never read, while the historian has no physical backup', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    expect(row()).toBeNull()
    expect(line()).toBeNull()
    expect(api.historianBackupState).not.toHaveBeenCalled()
  })

  it('shows a current backup with its age, type, label, the next one and the repository, and no line', async () => {
    physical()
    serveHistorian(CURRENT)
    renderTab()
    const strip = await screen.findByTestId('historian-row')
    expect(strip).toHaveTextContent('Last backup 2h ago, differential')
    expect(strip).toHaveTextContent('20261003-010002F_20261003-010004D')
    expect(strip).toHaveTextContent(/Next .*(differential|full)/)
    expect(strip).toHaveTextContent('3.0 GiB in the repository')
    expect(line()).toBeNull()
    // The line opens the panel, so it ends in a chevron, hidden from readers.
    expect(strip.lastElementChild).toHaveClass('backup-historian-chevron')
    expect(strip.querySelector('.backup-historian-chevron[aria-hidden="true"] svg')).not.toBeNull()
  })

  it('says a historian never backed up has no backup yet, and stays quiet while that is recent', async () => {
    physical()
    serveHistorian({ ...CURRENT, first_recorded_at: hoursAgo(1), last_attempt_at: null, last_success_at: null,
      last_success_kind: null, last_success_label: null, last_full_at: null, repo_bytes: 0 })
    renderTab()
    expect(await screen.findByTestId('historian-row')).toHaveTextContent('No backup yet')
    expect(row()).toHaveTextContent('Next: due now')
    expect(line()).toBeNull()
  })

  it(`reports a last success older than ${BACKUP_STALE_HOURS} hours`, async () => {
    physical()
    serveHistorian({ ...CURRENT, last_success_at: hoursAgo(BACKUP_STALE_HOURS + 6), last_attempt_at: hoursAgo(BACKUP_STALE_HOURS + 6) })
    renderTab()
    expect(await screen.findByTestId('historian-state')).toHaveTextContent(`No historian backup has succeeded in ${BACKUP_STALE_HOURS} hours`)
    expect(line()).toHaveClass('callout-warning')
    expect(line()).toHaveTextContent('The last good one finished')
    expect(row()).not.toBeNull()
  })

  it('reports a failure newer than the last success with pgBackRest\'s reason, whole in the panel', async () => {
    physical()
    const reason = `ERROR: [082]: WAL segment 000000010000000000000042 was not archived before the 60000ms timeout ${'x'.repeat(200)}`
    serveHistorian({ ...CURRENT, last_failure_at: hoursAgo(1), last_failure_kind: 'diff', last_failure_detail: reason })
    renderTab()
    const state = await screen.findByTestId('historian-state')
    expect(state).toHaveClass('callout-danger')
    expect(state).toHaveTextContent("The historian's last backup failed")
    expect(within(state).getByTitle(reason)).toHaveClass('truncate')

    fireEvent.click(screen.getByTestId('historian-row'))
    const open = panel()
    expect(open).toHaveAttribute('aria-label', expect.stringMatching(/historian backup/))
    expect(within(open).getByText(reason)).toBeInTheDocument()
    expect(open).toHaveTextContent('Failed')
  })

  it('says the historian is unreachable, never a blank, when the read returns no row or fails', async () => {
    physical()
    serveHistorian(null)
    renderTab()
    expect(await screen.findByTestId('historian-state')).toHaveTextContent('The historian cannot be read')
    expect(row()).toBeNull()

    api.historianBackupState.mockRejectedValue(new Error('boom'))
    const { unmount } = renderTab()
    await waitFor(() => expect(screen.getAllByTestId('historian-state')).toHaveLength(2))
    expect(screen.queryByText('boom')).toBeNull()
    unmount()
  })

  it('shows a request as queued, then being taken, then its result', async () => {
    physical()
    serveHistorian({ ...CURRENT, request_at: new Date().toISOString() })
    const first = renderTab()
    expect(await screen.findByTestId('historian-row')).toHaveTextContent('Requested: queued')
    first.unmount()

    serveHistorian({ ...CURRENT, request_at: hoursAgo(0.1), request_claimed_at: hoursAgo(0.05) })
    const second = renderTab()
    expect(await screen.findByTestId('historian-row')).toHaveTextContent('Requested: being taken')
    second.unmount()

    serveHistorian({ ...CURRENT, request_at: hoursAgo(1), request_claimed_at: hoursAgo(1), request_finished_at: hoursAgo(0.9), request_succeeded: true })
    renderTab()
    expect(await screen.findByTestId('historian-row')).toHaveTextContent('Requested: taken')
  })

  it('says a request waiting past a few minutes was not picked up', async () => {
    physical()
    serveHistorian({ ...CURRENT, request_at: hoursAgo(0.5) })
    renderTab()
    expect(await screen.findByTestId('historian-row')).toHaveTextContent('Requested: not picked up')
  })

  it('opens its panel with the schedule and the repository, and closes it on a second click', async () => {
    physical()
    serveHistorian(CURRENT)
    renderTab()
    const strip = await screen.findByTestId('historian-row')
    fireEvent.click(strip)
    expect(strip).toHaveAttribute('aria-pressed', 'true')
    const open = panel()
    expect(open).toHaveTextContent('Daily at 01:00 UTC: a full backup on Sundays')
    expect(open).toHaveTextContent('3.0 GiB, every backup it holds, WAL excluded')
    expect(within(open).getByText('20261003-010002F_20261003-010004D')).toBeInTheDocument()
    fireEvent.click(strip)
    expect(panel()).toBeNull()
  })

  it('says Take a backup asks the historian for a differential, and lists no historian in the platform backup', async () => {
    physical()
    serveHistorian(CURRENT)
    renderTab()
    await screen.findByTestId('historian-row')
    const modal = openDialog()
    expect(modal).toHaveTextContent("The historian's own backup takes a differential at the same time")
    expect(modal).not.toHaveTextContent('the historian,')
  })
})

describe('the platform database row', () => {
  const physical = (flags = {}) => {
    globalThis.__ABER_CONFIG__ = { VITE_PLATFORM_PHYSICAL_BACKUP: 'true', ...flags }
  }
  const row = () => screen.queryByTestId('platform-row')
  const line = () => screen.queryByTestId('platform-state')
  /** The platform database backing itself up daily at 01:00 UTC, full on Sundays, last good an hour ago. */
  const CURRENT = {
    hour_utc: 1, full_on: 0, first_recorded_at: hoursAgo(24 * 20),
    last_attempt_at: hoursAgo(1), last_success_at: hoursAgo(1), last_success_kind: 'full',
    last_success_label: '20261004-010002F', last_full_at: hoursAgo(1),
    repo_bytes: 40 * 1024 * 1024, last_failure_at: null, last_failure_kind: null, last_failure_detail: null
  }

  it('is absent, and never read, while the platform database has no physical backup', async () => {
    renderTab()
    await screen.findByTestId('run-j-1')
    expect(row()).toBeNull()
    expect(line()).toBeNull()
    expect(api.platformBackupState).not.toHaveBeenCalled()
  })

  it('shows a current backup with its type, label and repository, without a request, and no line', async () => {
    physical()
    api.platformBackupState.mockResolvedValue(CURRENT)
    renderTab()
    const strip = await screen.findByTestId('platform-row')
    expect(strip).toHaveTextContent('Platform database')
    expect(strip).toHaveTextContent('Last backup 1h ago, full')
    expect(strip).toHaveTextContent('20261004-010002F')
    expect(strip).toHaveTextContent('40.0 MiB in the repository')
    expect(strip).not.toHaveTextContent('Requested')
    expect(line()).toBeNull()
    expect(api.historianBackupState).not.toHaveBeenCalled()
  })

  it('says a platform database never backed up has no backup yet, not that it cannot be read', async () => {
    physical()
    api.platformBackupState.mockResolvedValue(Object.fromEntries(Object.keys(CURRENT).map(k => [k, null])))
    renderTab()
    expect(await screen.findByTestId('platform-row')).toHaveTextContent('No backup yet')
    expect(row()).toHaveTextContent('Next: not known yet')
    expect(line()).toBeNull()
  })

  it('reports a failure with pgBackRest\'s reason under its own name, and whole in its panel', async () => {
    physical()
    const reason = 'ERROR: [039]: HTTP request failed with 403 (Forbidden)'
    api.platformBackupState.mockResolvedValue({ ...CURRENT, last_failure_at: hoursAgo(0.5), last_failure_kind: 'diff', last_failure_detail: reason })
    renderTab()
    const state = await screen.findByTestId('platform-state')
    expect(state).toHaveClass('callout-danger')
    expect(state).toHaveTextContent("The platform database's last backup failed")

    fireEvent.click(screen.getByTestId('platform-row'))
    const open = panel()
    expect(open).toHaveAttribute('aria-label', expect.stringMatching(/platform database backup details/))
    expect(within(open).getByText(reason)).toBeInTheDocument()
    expect(open).toHaveTextContent('Daily at 01:00 UTC: a full backup on Sundays')
  })

  it(`reports a last success older than ${BACKUP_STALE_HOURS} hours, naming where to look`, async () => {
    physical()
    api.platformBackupState.mockResolvedValue({ ...CURRENT, last_success_at: hoursAgo(BACKUP_STALE_HOURS + 2), last_attempt_at: hoursAgo(BACKUP_STALE_HOURS + 2) })
    renderTab()
    const state = await screen.findByTestId('platform-state')
    expect(state).toHaveTextContent(`No platform database backup has succeeded in ${BACKUP_STALE_HOURS} hours`)
    expect(state).toHaveTextContent('kubectl -n aber logs supabase-db-0 -c pgbackrest')
  })

  it('stands beside the historian, each opening its own panel, and keeps the platform backup whole', async () => {
    physical({ VITE_HISTORIAN_PHYSICAL_BACKUP: 'true' })
    api.platformBackupState.mockResolvedValue(CURRENT)
    api.historianBackupState.mockResolvedValue({ ...CURRENT, last_success_label: 'H1', request_at: null })
    renderTab()
    const platform = await screen.findByTestId('platform-row')
    const historian = await screen.findByTestId('historian-row')
    expect(platform.compareDocumentPosition(historian) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(historian)
    expect(panel()).toHaveAttribute('aria-label', expect.stringMatching(/historian backup details/))
    fireEvent.click(platform)
    expect(panel()).toHaveAttribute('aria-label', expect.stringMatching(/platform database backup details/))
    expect(historian).toHaveAttribute('aria-pressed', 'false')

    // Take a backup still dumps the platform database: only the historian leaves the dump.
    const modal = openDialog()
    expect(modal).toHaveTextContent('the platform database')
    expect(modal).not.toHaveTextContent('the historian,')
  })
})

describe('when the historian is next backed up', () => {
  const at = (iso) => new Date(iso).getTime()
  // Saturday 3 October 2026, 09:00 UTC.
  const NOW = at('2026-10-03T09:00:00Z')
  const base = { hour_utc: 1, full_on: 0, last_full_at: '2026-09-27T01:05:00Z' }

  it('is tomorrow at the hour once today\'s slot was attempted', () => {
    expect(nextHistorianBackup({ ...base, last_attempt_at: '2026-10-03T01:00:10Z' }, NOW))
      .toEqual({ at: at('2026-10-04T01:00:00Z'), due: false, kind: 'full' })
  })

  it('is due now while the latest slot has not been attempted', () => {
    expect(nextHistorianBackup({ ...base, last_attempt_at: '2026-10-02T01:00:10Z' }, NOW))
      .toMatchObject({ at: at('2026-10-03T01:00:00Z'), due: true })
  })

  it('is a differential between fulls, and a full once the newest is over a week old', () => {
    const recent = { ...base, last_full_at: '2026-10-01T01:05:00Z', last_attempt_at: '2026-10-03T01:00:10Z', full_on: 3 }
    expect(nextHistorianBackup(recent, NOW).kind).toBe('diff')
    expect(nextHistorianBackup({ ...recent, last_full_at: '2026-09-24T01:05:00Z' }, NOW).kind).toBe('full')
  })

  it('is not known without a schedule', () => {
    expect(nextHistorianBackup({ hour_utc: null }, NOW)).toBeNull()
  })

  it('reads unreachable from no row, and nothing from a historian that is off', () => {
    expect(physicalBackupState(null)).toEqual({ kind: 'unreachable' })
    expect(physicalBackupState(undefined)).toBeNull()
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
