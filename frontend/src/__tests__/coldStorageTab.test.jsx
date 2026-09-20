import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ColdStorageTab } from '../components/tabs/ColdStorageTab'
import { coldStorageSummary, formatBytes, coldStateLabel } from '../utils/coldStorage'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { listColdStorage: vi.fn(), coldArchiveBacklog: vi.fn(), get: vi.fn() },
}))

const row = (overrides = {}) => ({
  chunk_name: '_hyper_1_38_chunk',
  range_start: '2026-04-02T00:00:00Z',
  range_end: '2026-04-09T00:00:00Z',
  row_count: 1000,
  object_key:
    'site=broughton-7f3a9c21/dataset=telemetry/v=1/year=2026/month=04/'
    + '20260402T000000Z-20260409T000000Z.parquet',
  object_bytes: 4938,
  state: 'archived',
  on_cold_storage: true,
  claimed_at: '2026-08-30T09:40:00Z',
  dropped_at: '2026-08-30T09:41:00Z',
  last_error: null,
  ...overrides,
})

/** 0133's one row. Archiving off by default, matching the setting, so only the tests about the
 *  backlog have to think about it. */
const backlogRow = (overrides = {}) => ({
  enabled: false,
  threshold_days: 90,
  oldest_unexported: '2026-04-09T00:00:00Z',
  age_seconds: 90 * 86400,
  overdue_seconds: 0,
  ...overrides,
})

const show = async (rows, userRole = 'Administrator', backlog = backlogRow()) => {
  api.listColdStorage.mockResolvedValue(rows)
  api.coldArchiveBacklog.mockResolvedValue(backlog)
  render(<ColdStorageTab showToast={vi.fn()} userRole={userRole} />)
  await waitFor(() => expect(api.listColdStorage).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  // The page reads `archive.enabled` through useSetting, which calls api.get. An empty list means
  // the fallback, `false`, so tests not about the switch get the same state.
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
      screen.getByText(
        'site=broughton-7f3a9c21/dataset=telemetry/v=1/year=2026/month=04/'
        + '20260402T000000Z-20260409T000000Z.parquet'
      )
    ).toBeInTheDocument())
  })

  it('says the objects are the only copy once anything is archived', async () => {
    // The one thing a reader must not miss, and the reason it is under the table rather than in a
    // tooltip: for every other bucket an object is a copy; here it is the original.
    await show([row()])
    await waitFor(() => expect(screen.getByText(/only copy/i)).toBeInTheDocument())
    // And that it is not in this cluster: the footer used to point at the storage volume and at
    // `dev:reset`, which stopped being where these objects live when the archive went remote.
    expect(screen.getByText(/outside the cluster/i)).toBeInTheDocument()
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
   * An empty list is ambiguous: `cold_storage_rows()` gates on the role in its body, so a caller
   * without one gets zero rows rather than a refusal, and "nothing is archived" would be a claim
   * the page has no basis for.
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
 * The state an operator hits first: turning `archive.enabled` on arms the exporter and does not run
 * it, so the empty state must not say cold storage is off.
 */
describe('the empty state distinguishes off from on-and-idle', () => {

  it('does not claim archiving is off when it is on', async () => {
    api.get.mockResolvedValue([{ key: 'archive.enabled', value: true }])
    await show([])
    await waitFor(() => expect(screen.getByText(/Archiving is/)).toBeInTheDocument())
    expect(screen.queryByText(/Cold storage is off/i)).toBeNull()
  })

  it('says it runs by itself, because it does', async () => {
    /* The empty state attributes the emptiness to nothing being eligible yet, not to a missing
       scheduler; the cold-archive CronJob schedules it.

       IT NAMES THE THING THAT ACTUALLY RUNS. This asserted `cold-archiver`, a Compose service that
       has not existed since Compose was dropped -- so the page told an operator to look for a
       container that is not there, and the test held it that way. */
    api.get.mockResolvedValue([{ key: 'archive.enabled', value: true }])
    await show([])
    await waitFor(() => expect(screen.getByText(/runs by itself/i)).toBeInTheDocument())
    // Exact: the CronJob is named twice on this page, once alone and once inside the kubectl line.
    expect(screen.getByText('cold-archive')).toBeInTheDocument()
    expect(screen.queryByText(/cold-archiver/)).toBeNull()
    expect(screen.queryByText(/docker exec/)).toBeNull()
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
    // useSetting swallows read errors by design, so the cautious default matters: claiming
    // archiving is on when the page could not find out would send somebody looking for a command
    // instead of a switch.
    api.get.mockRejectedValue(new Error('offline'))
    await show([])
    await waitFor(() => expect(screen.getByText(/Cold storage is off/i)).toBeInTheDocument())
  })
})

describe('how far behind the archive is', () => {

  it('names the date the unexported span begins once archiving is on', async () => {
    // THE FIGURE THAT SAYS A LINK IS DOWN. Every other stat describes what reached the endpoint;
    // this is where the data that has not begins, which is the number an outage moves.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 3 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
  })

  it('shows the backlog even when nothing has ever been archived', async () => {
    // THE CASE THE FIGURE EXISTS FOR, and the one the live stack caught. An archiver that has never
    // reached its endpoint has an EMPTY catalogue -- so a stats row gated on the catalogue hides
    // the only figure that could say so, exactly when it is the whole story.
    await show([], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 30 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    // And the catalogue's own figures stay away: they describe what reached the endpoint.
    expect(screen.queryByText('Oldest span held')).toBeNull()
  })

  it('says nothing about a backlog when archiving is off', async () => {
    // With archiving off every chunk is unexported for ever, so the figure would be alarming and
    // meaningless -- the state a stack that simply does not archive is permanently in.
    await show([row()], 'Administrator', backlogRow({ enabled: false }))
    await waitFor(() => expect(screen.getByText('Oldest span held')).toBeInTheDocument())
    expect(screen.queryByText('Unexported since')).toBeNull()
  })

  /** The figure's own value element, whose inline `color` is what `tone` actually sets. */
  const backlogColour = () =>
    screen.getByText('Unexported since').parentElement.querySelectorAll('div')[1].style.color

  it('stays neutral inside one chunk interval', async () => {
    // A chunk is not eligible until its whole seven-day span has passed the threshold, so a
    // healthy site is always a few days behind. Colouring that amber would train the reader to
    // ignore the colour by the second week of every install.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 5 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(backlogColour()).toBe('var(--text-primary)')
  })

  it('warns once the backlog passes the tolerance the alert fires on', async () => {
    // The other half of the pair: a threshold that never colours anything would pass the test
    // above and ship dead. 20 days is past the 14 the Archive Backlog rule fires on.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 20 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(backlogColour()).toBe('var(--warning-text)')
  })

  it('renders the catalogue even when the backlog cannot be read', async () => {
    // It fails SOFT. The catalogue is the page; losing one figure must not lose the rest of it.
    api.listColdStorage.mockResolvedValue([row()])
    api.coldArchiveBacklog.mockRejectedValue(new Error('fdw is down'))
    render(<ColdStorageTab showToast={vi.fn()} userRole="Administrator" />)
    await waitFor(() => expect(screen.getByText('Oldest span held')).toBeInTheDocument())
    expect(screen.queryByText('Unexported since')).toBeNull()
  })
})
