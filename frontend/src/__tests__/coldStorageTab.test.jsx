import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ColdStorageTab } from '../components/tabs/ColdStorageTab'
import { coldStorageSummary, formatBytes, coldStateLabel } from '../utils/coldStorage'
import { api } from '../api'

vi.mock('../api', () => ({ api: { listColdStorage: vi.fn(), get: vi.fn() } }))

const row = (overrides = {}) => ({
  chunk_name: '_hyper_1_38_chunk',
  range_start: '2026-04-02T00:00:00Z',
  range_end: '2026-04-09T00:00:00Z',
  row_count: 1000,
  object_key: 'year=2026/month=04/_hyper_1_38_chunk.parquet',
  object_bytes: 4938,
  state: 'archived',
  on_cold_storage: true,
  claimed_at: '2026-08-30T09:40:00Z',
  dropped_at: '2026-08-30T09:41:00Z',
  last_error: null,
  ...overrides,
})

const show = async (rows, userRole = 'Administrator') => {
  api.listColdStorage.mockResolvedValue(rows)
  render(<ColdStorageTab showToast={vi.fn()} userRole={userRole} />)
  await waitFor(() => expect(api.listColdStorage).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  // The page reads `archive.enabled` through useSetting, which calls api.get. Defaulted to an empty
  // list -- no row means the fallback, which is `false`, so every test that is not ABOUT the switch
  // gets the same state it had before the switch was read.
  api.get.mockResolvedValue([])
})

describe('the cold storage catalogue', () => {

  it('reports the archived span, which the hypertable can no longer answer', async () => {
    // THE QUESTION THE PAGE EXISTS FOR. Once a chunk is dropped, "how far back does my history go"
    // is unanswerable from the telemetry table -- the manifest is the only record.
    await show([row()])
    await waitFor(() => expect(screen.getByText('Oldest span held')).toBeInTheDocument())
    // SCOPED TO THE TABLE. The row count appears twice by design -- once as a total above and once
    // per row -- so an unscoped match asserts nothing about which.
    expect(within(screen.getByRole('table')).getByText('1,000')).toBeInTheDocument()
  })

  it('names the object key so it can be found on storage', async () => {
    await show([row()])
    await waitFor(() => expect(
      screen.getByText('year=2026/month=04/_hyper_1_38_chunk.parquet')
    ).toBeInTheDocument())
  })

  it('says the objects are the only copy once anything is archived', async () => {
    // The one thing a reader must not miss, and the reason it is under the table rather than in a
    // tooltip: for every other bucket an object is a copy; here it is the original.
    await show([row()])
    await waitFor(() => expect(screen.getByText(/only copy/i)).toBeInTheDocument())
    expect(screen.getByText(/stack:reset/)).toBeInTheDocument()
  })

  it('does not claim the objects are the only copy when nothing has been dropped', async () => {
    // A chunk that is exported but not dropped has its rows in BOTH places, which is the safest
    // state in the sequence. Warning about it would train the reader to ignore the warning.
    await show([row({ state: 'verified', on_cold_storage: false, dropped_at: null })])
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument())
    expect(screen.queryByText(/only copy/i)).toBeNull()
  })

  it('surfaces the error on a failed chunk rather than hiding it behind the badge', async () => {
    // A chunk failing for a week is the one row on this page that needs a person.
    await show([row({ state: 'failed', on_cold_storage: false, dropped_at: null,
                      last_error: 'verification failed: object holds 998 rows, manifest says 1000' })])
    // "Failed" is both a summary stat label and the row's badge, so this reads the row.
    await waitFor(() => expect(
      within(screen.getByRole('table')).getByText('Failed')
    ).toBeInTheDocument())
    expect(screen.getByText(/object holds 998 rows/)).toBeInTheDocument()
  })

  /**
   * AN EMPTY LIST IS GENUINELY AMBIGUOUS HERE, and resolving it wrongly is a lie in one direction.
   *
   * `cold_storage_rows()` gates on the role in its BODY, so a caller without one gets zero rows
   * rather than a refusal -- exactly as every RLS-protected read on this schema behaves. Rendering
   * "nothing is archived" at somebody who simply cannot see it would be a claim the page has no
   * basis for making.
   */
  it('tells an unprivileged reader the list is empty because of their role', async () => {
    await show([], 'Operator')
    await waitFor(() => expect(screen.getByText(/empty because of your role/i)).toBeInTheDocument())
    expect(screen.queryByText(/No telemetry has been archived/i)).toBeNull()
  })

  it('tells a privileged reader that nothing is archived, and where the switch is', async () => {
    await show([], 'Administrator')
    await waitFor(() => expect(screen.getByText(/No telemetry has been archived/i)).toBeInTheDocument())
    expect(screen.getByText(/Settings → Cold Storage/)).toBeInTheDocument()
  })

  it('surfaces a read failure rather than rendering it as an empty archive', async () => {
    api.listColdStorage.mockRejectedValue(new Error('permission denied for function cold_storage_rows'))
    render(<ColdStorageTab showToast={vi.fn()} userRole="Administrator" />)
    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeInTheDocument())
  })
})

describe('the summary arithmetic', () => {

  it('counts rows and bytes only for what has actually been dropped', () => {
    // A total including chunks still in the hypertable answers no question: it is neither how much
    // has been moved off the operational database nor how much storage is in use.
    const summary = coldStorageSummary([
      row(),
      row({ chunk_name: 'b', state: 'verified', on_cold_storage: false, row_count: 500, object_bytes: 2000 }),
    ])
    expect(summary.total).toBe(2)
    expect(summary.archived).toBe(1)
    expect(summary.rows).toBe(1000)
    expect(summary.bytes).toBe(4938)
    // The one that means "there is work outstanding".
    expect(summary.verified).toBe(1)
  })

  it('reports the oldest span across every row, archived or not', () => {
    const summary = coldStorageSummary([
      row({ range_start: '2026-04-02T00:00:00Z' }),
      row({ chunk_name: 'older', range_start: '2026-01-05T00:00:00Z' }),
    ])
    expect(summary.oldest).toBe('2026-01-05T00:00:00Z')
  })

  it('is empty-safe, because the page renders before the first read resolves', () => {
    const summary = coldStorageSummary([])
    expect(summary).toMatchObject({ total: 0, archived: 0, rows: 0, bytes: 0, oldest: null })
    expect(coldStorageSummary(undefined).total).toBe(0)
  })
})

describe('byte formatting', () => {

  it('uses binary units, matching the bucket limits and Docker', () => {
    // A page saying "1.1 GB" beside a bucket configured for 1073741824 invites the reader to work
    // out which of the two numbers is wrong.
    expect(formatBytes(1073741824)).toBe('1.0 GiB')
    expect(formatBytes(104857600)).toBe('100 MiB')
    expect(formatBytes(4938)).toBe('4.8 KiB')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('renders an absent size as an em dash rather than 0 B', () => {
    // A chunk claimed but not yet exported has no object. "0 B" would read as an empty file.
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
  })
})

describe('state vocabulary', () => {

  it('calls the end state On cold storage rather than Archived', () => {
    // "Archived" is the Archives page's word for an entity lifecycle state. Reusing it here would
    // collide with that, which is why this page does not.
    expect(coldStateLabel('archived')).toBe('On cold storage')
  })
})


/**
 * THE STATE AN OPERATOR ACTUALLY HITS FIRST, and the one the page originally had no wording for.
 *
 * Turning `archive.enabled` on ARMS the exporter; it does not run it, and nothing on a Compose
 * stack schedules it. So the ordinary first experience is: switch it on, open this page, see
 * nothing -- and be told "cold storage is off", which is both wrong and the opposite of actionable.
 */
describe('the empty state distinguishes off from on-and-idle', () => {

  it('does not claim archiving is off when it is on', async () => {
    api.get.mockResolvedValue([{ key: 'archive.enabled', value: true }])
    await show([])
    await waitFor(() => expect(screen.getByText(/Archiving is/)).toBeInTheDocument())
    expect(screen.queryByText(/Cold storage is off/i)).toBeNull()
  })

  it('says it runs by itself, because it does', async () => {
    /*
     * THE COPY THIS REPLACES WAS STALE AND MISLED A READER INTO ASKING FOR A CRON JOB.
     *
     * It said "nothing schedules it, so on this stack it is a command somebody runs", which was
     * true when written and stopped being true one commit later when the `cold-archiver` service
     * landed. Nobody reading it could tell -- which is the failure this repository calls out by
     * name: a stale claim is worse than none, because it will be acted on.
     *
     * The empty state now attributes the emptiness to the right cause: not a missing scheduler, but
     * nothing being ELIGIBLE yet.
     */
    api.get.mockResolvedValue([{ key: 'archive.enabled', value: true }])
    await show([])
    await waitFor(() => expect(screen.getByText(/runs by itself/i)).toBeInTheDocument())
    expect(screen.getByText(/cold-archiver/)).toBeInTheDocument()
    // "eligible" appears twice by design -- as the cause, and again in the command that lists it --
    // so this asserts the cause rather than either occurrence.
    expect(screen.getByText(/nothing is/i).textContent).toMatch(/eligible/i)
    expect(screen.queryByText(/nothing schedules it/i)).toBeNull()
  })

  it('says where the switch is when it really is off', async () => {
    api.get.mockResolvedValue([{ key: 'archive.enabled', value: false }])
    await show([])
    await waitFor(() => expect(screen.getByText(/Cold storage is off/i)).toBeInTheDocument())
  })

  it('assumes off when the settings read fails, rather than claiming archiving is running', async () => {
    // useSetting swallows read errors by design. The cautious default matters here: telling
    // somebody archiving is on when the page could not find out would send them looking for a
    // command to run instead of a switch to flip.
    api.get.mockRejectedValue(new Error('offline'))
    await show([])
    await waitFor(() => expect(screen.getByText(/Cold storage is off/i)).toBeInTheDocument())
  })
})
