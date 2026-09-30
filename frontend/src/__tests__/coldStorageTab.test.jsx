import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ColdStorageTab } from '../components/tabs/ColdStorageTab'
import { coldStorageSummary, coldStateLabel, formatWindow, rawWindowStatement } from '../utils/coldStorage'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listColdStorage: vi.fn(),
    coldArchiveBacklog: vi.fn(),
    rawTelemetryWindow: vi.fn(),
    archiveCredentialIsSet: vi.fn(),
    setArchiveCredential: vi.fn(),
    get: vi.fn(),
  },
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

/** The backlog row. Archiving is off by default, matching the setting, so only the tests about
 *  the backlog have to think about it. */
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
  api.setArchiveCredential.mockResolvedValue(true)
  render(<ColdStorageTab showToast={vi.fn()} userRole={userRole} />)
  await waitFor(() => expect(api.listColdStorage).toHaveBeenCalled())
}

/** The catalogue card. The Destination card above it legitimately repeats some of the same words
 *  -- "Archiving is", "Settings -> Cold Storage" -- so an unscoped match now finds two. */
const catalogue = () => screen.getByText(/^Cold telemetry/).closest('.card')

/** Archiving on AND somewhere to write: the state the on-and-idle empty text describes. Without a
 *  destination the page now says something else, correctly, so these rows are load-bearing. */
const ENABLED_AND_CONFIGURED = [
  { key: 'archive.enabled', value: true },
  { key: 'archive.endpoint', value: 'https://s3.eu-west-2.amazonaws.com' },
  { key: 'archive.region', value: 'eu-west-2' },
  { key: 'archive.bucket', value: 'plant-history' },
  { key: 'archive.access_key_id', value: 'AKIAEXAMPLE' },
  { key: 'archive.site_key', value: 'broughton-7f3a9c21' },
]

beforeEach(() => {
  // clearAllMocks() clears CALLS, not implementations, so a resolved value set by one test survives
  // into the next. Re-declaring the default here rather than inside show() lets a test override it
  // on the line before it renders.
  vi.clearAllMocks()
  api.archiveCredentialIsSet.mockResolvedValue(false)
  // No row: the historian could not say, so the page states no window.
  api.rawTelemetryWindow.mockResolvedValue(null)
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

  it('says the objects are the only copy, in the tooltip that explains the feature', async () => {
    /* The one thing a reader must not miss: for every other bucket an object is a copy; here it is
       the original. It is in the tooltip, so it is reachable before anything has been archived. */
    await show([row()])
    await waitFor(() => expect(screen.getByText('Oldest span held')).toBeInTheDocument())

    // Not rendered until asked for, which is the whole point of moving it.
    expect(screen.queryByText(/only copy/i)).toBeNull()

    fireEvent.click(within(catalogue()).getByRole('button', { name: /about cold telemetry/i }))
    const bubble = await screen.findByRole('tooltip')
    expect(bubble.textContent).toMatch(/only copy/i)
    // And that they are not in this cluster: the footer used to point at the storage volume and at
    // `dev:reset`, which stopped being where these objects live when the archive went remote.
    expect(bubble.textContent).toMatch(/outside the cluster/i)
  })

  it('offers that warning before anything has been archived too', async () => {
    /* WHAT THE FOOTER COULD NOT DO, and the reason this is not just a relocation. The footer was
       gated on summary.archived > 0 -- it appeared only once the first chunk's rows had already
       been dropped, which is after the decision it warns about has been taken. An operator turning
       the switch on can now read it first. */
    await show([])
    await waitFor(() => expect(within(catalogue()).getByRole('button', { name: /about cold telemetry/i })).toBeInTheDocument())
    fireEvent.click(within(catalogue()).getByRole('button', { name: /about cold telemetry/i }))
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/only copy/i)
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
    expect(within(catalogue()).getByText(/Settings → Cold Storage/)).toBeInTheDocument()
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
    api.get.mockResolvedValue(ENABLED_AND_CONFIGURED)
    api.archiveCredentialIsSet.mockResolvedValue(true)
    await show([])
    await waitFor(() => expect(within(catalogue()).getByText(/Archiving is/)).toBeInTheDocument())
    expect(screen.queryByText(/Cold storage is off/i)).toBeNull()
  })

  it('says it runs by itself, because it does', async () => {
    /* The empty state attributes the emptiness to nothing being eligible yet, and names the
       cold-archive CronJob that runs it. */
    api.get.mockResolvedValue(ENABLED_AND_CONFIGURED)
    api.archiveCredentialIsSet.mockResolvedValue(true)
    await show([])
    await waitFor(() => expect(within(catalogue()).getByText(/runs by itself/i)).toBeInTheDocument())
    // Exact: the CronJob is named twice on this page, once alone and once inside the kubectl line.
    expect(within(catalogue()).getByText('cold-archive')).toBeInTheDocument()
    expect(screen.queryByText(/cold-archiver/)).toBeNull()
    expect(screen.queryByText(/docker exec/)).toBeNull()
    // "eligible" appears twice by design -- as the cause, and again in the command that lists it --
    // so this asserts the cause rather than either occurrence.
    expect(within(catalogue()).getByText(/nothing is/i).textContent).toMatch(/eligible/i)
    expect(within(catalogue()).queryByText(/nothing schedules it/i)).toBeNull()
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

  it('leads the empty state with it rather than stranding it in a row of one', async () => {
    /* WHERE it is, not just that it is. The stats strip is a left-aligned flex row, so a catalogue
       with nothing in it put this figure alone at the far left above centred text -- reading as a
       stray label rather than the headline it is. Inside `.empty-state` it inherits the centring.

       Asserted through the DOM because that is the whole of the change: the figure renders from
       one definition either way, and a regression would move it, not reword it. */
    await show([], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 30 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(screen.getByText('Unexported since').closest('.empty-state')).not.toBeNull()
    // And it takes the decorative icon's place rather than stacking above it: one anchor, not two.
    expect(catalogue().querySelector('.empty-icon')).toBeNull()
  })

  it('keeps it in the strip once there is a catalogue to sit beside', async () => {
    // The other half. Centring it there would break the column the other figures line up in.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 30 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(screen.getByText('Unexported since').closest('.empty-state')).toBeNull()
    expect(screen.getByText('Oldest span held')).toBeInTheDocument()
  })

  it('withholds it from a reader who cannot see the catalogue', async () => {
    /* cold_archive_backlog() gates on the same three roles as cold_storage_rows(), so this reader
       gets nothing from it anyway -- but the mock cannot know that, and a page that rendered a
       backlog headline above "this list is empty because of your role" would be telling two
       stories at once. The role arm keeps its icon. */
    await show([], 'Operator', backlogRow({ enabled: true, overdue_seconds: 30 * 86400 }))
    await waitFor(() => expect(screen.getByText(/because of your role/i)).toBeInTheDocument())
    expect(screen.queryByText('Unexported since')).toBeNull()
    // Not via catalogue(): this arm's own text opens "Cold telemetry is readable by ...", so the
    // helper's /^Cold telemetry/ finds two elements here and nowhere else.
    const state = screen.getByText(/because of your role/i).closest('.empty-state')
    expect(state.querySelector('.empty-icon')).not.toBeNull()
  })

  it('says nothing about a backlog when archiving is off', async () => {
    // With archiving off every chunk is unexported for ever, so the figure would be alarming and
    // meaningless -- the state a stack that simply does not archive is permanently in.
    await show([row()], 'Administrator', backlogRow({ enabled: false }))
    await waitFor(() => expect(screen.getByText('Oldest span held')).toBeInTheDocument())
    expect(screen.queryByText('Unexported since')).toBeNull()
  })

  /** Whether the figure carries the warning tone, which is a class on the stat. */
  const backlogWarns = () =>
    screen.getByText('Unexported since').closest('.cold-stat').classList.contains('cold-stat-warning')

  it('stays neutral inside one chunk interval', async () => {
    // A chunk is not eligible until its whole span (up to seven days) has passed the threshold,
    // so a healthy site can be a few days behind. Colouring that amber would train the reader to
    // ignore the colour by the second week of every install.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 5 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(backlogWarns()).toBe(false)
  })

  it('warns once the backlog passes the tolerance the alert fires on', async () => {
    // The other half of the pair: a threshold that never colours anything would pass the test
    // above and ship dead. 20 days is past the 14 the Archive Backlog rule fires on.
    await show([row()], 'Administrator', backlogRow({ enabled: true, overdue_seconds: 20 * 86400 }))
    await waitFor(() => expect(screen.getByText('Unexported since')).toBeInTheDocument())
    expect(backlogWarns()).toBe(true)
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

describe('the destination card', () => {

  /** The settings the card reads come back through api.get, which useSetting calls. */
  const withDestination = (rows) => api.get.mockResolvedValue(rows)

  it('is not rendered for a reader who cannot see the destination', async () => {
    // The archive settings are flagged `sensitive`, so an Auditor's reads return the fallbacks, and
    // a card built from them would report a configured stack as unconfigured.
    withDestination([])
    await show([], 'Auditor')
    await waitFor(() => expect(screen.getByText(/^Cold telemetry/)).toBeInTheDocument())
    expect(screen.queryByText('Destination')).toBeNull()
  })

  it('names where objects go once the destination is set', async () => {
    withDestination([
      { key: 'archive.endpoint', value: 'https://s3.eu-west-2.amazonaws.com' },
      { key: 'archive.bucket', value: 'plant-history' },
      { key: 'archive.site_key', value: 'broughton-7f3a9c21' },
    ])
    await show([], 'Administrator')
    await waitFor(() => expect(
      screen.getByText('https://s3.eu-west-2.amazonaws.com/plant-history/site=broughton-7f3a9c21/')
    ).toBeInTheDocument())
  })

  it('says archiving is on and cannot run when the destination is incomplete', async () => {
    // The state this card exists for: the switch is an ordinary setting, so it can be turned on
    // before a destination exists.
    withDestination([{ key: 'archive.enabled', value: true }])
    await show([], 'Administrator')
    await waitFor(() => expect(screen.getByText(/cannot run/i)).toBeInTheDocument())
    // On the callout's whole text: the list is interpolated beside sibling nodes, so a text
    // matcher looking for one field finds a fragment rather than the sentence.
    const warning = screen.getByText(/cannot run/i).closest('.callout')
    expect(warning.textContent).toMatch(/S3 endpoint/)
    expect(warning.textContent).toMatch(/S3 bucket/)
    expect(warning.textContent).toMatch(/the secret access key/)
  })

  it('does not nag when archiving is off and nothing is configured', async () => {
    // An unconfigured destination is the ordinary state of a stack that does not archive. Warning
    // about it would put a permanent amber callout on every install that never uses the feature.
    withDestination([{ key: 'archive.enabled', value: false }])
    await show([], 'Administrator')
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument())
    expect(screen.queryByText(/cannot run/i)).toBeNull()
  })

  it('writes the credential and never reads one back', async () => {
    withDestination([])
    await show([], 'Administrator')
    // Nothing to type into until the dialog is opened: the field is no longer sitting on the card.
    await waitFor(() => expect(screen.getByRole('button', { name: /set key/i })).toBeInTheDocument())
    expect(screen.queryByLabelText(/secret access key/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /set key/i }))
    // Straight to the field: there is no key to destroy, so nothing to confirm.
    const input = await screen.findByLabelText(/secret access key/i)
    // A password field: nothing in the DOM ever holds the stored value, because no API returns it.
    expect(input).toHaveAttribute('type', 'password')

    fireEvent.change(input, { target: { value: 'wJalrXUtnFEMI' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(api.setArchiveCredential).toHaveBeenCalledWith('wJalrXUtnFEMI'))
    // The dialog closes, taking the typed key out of the DOM with it.
    await waitFor(() => expect(screen.queryByLabelText(/secret access key/i)).toBeNull())
  })

  it('asks before replacing a key that already exists', async () => {
    /* THE ACT WITH NO UNDO. set_archive_credential() calls vault.update_secret() when a secret is
       already there, so Save overwrites in place -- and since nothing reads either value back, a
       mistyped replacement is not discovered until the CronJob fails to authenticate, with the
       original unrecoverable from this stack. The field does not appear until that is acknowledged. */
    withDestination([])
    api.archiveCredentialIsSet.mockResolvedValue(true)
    await show([], 'Administrator')
    await waitFor(() => expect(screen.getByRole('button', { name: /replace/i })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /^replace$/i }))
    await waitFor(() => expect(screen.getByText(/overwrites it in the vault/i)).toBeInTheDocument())
    // The gate is the point: no way to type a key while the warning is unanswered.
    expect(screen.queryByLabelText(/secret access key/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /replace it/i }))
    expect(await screen.findByLabelText(/secret access key/i)).toBeInTheDocument()
  })

  it('lets a first key through without that question', async () => {
    // The other half. A dialog that always asked would pass the test above and make every new
    // install answer for a vault with nothing in it.
    withDestination([])
    await show([], 'Administrator')
    fireEvent.click(await screen.findByRole('button', { name: /set key/i }))
    expect(await screen.findByLabelText(/secret access key/i)).toBeInTheDocument()
    expect(screen.queryByText(/overwrites it in the vault/i)).toBeNull()
  })

  it('keeps the typed key when the write is refused', async () => {
    /* A refused save must not throw the secret away. It cannot be pasted back from anywhere -- the
       operator has it from the provider's console, once -- so closing the dialog on a 403 would
       cost them the trip back to fetch it again. */
    withDestination([])
    api.setArchiveCredential.mockRejectedValue(new Error('not permitted'))
    const toast = vi.fn()
    api.listColdStorage.mockResolvedValue([])
    api.coldArchiveBacklog.mockResolvedValue(backlogRow())
    render(<ColdStorageTab showToast={toast} userRole="Administrator" />)

    fireEvent.click(await screen.findByRole('button', { name: /set key/i }))
    const input = await screen.findByLabelText(/secret access key/i)
    fireEvent.change(input, { target: { value: 'wJalrXUtnFEMI' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith('not permitted', 'error'))
    expect(screen.getByLabelText(/secret access key/i).value).toBe('wJalrXUtnFEMI')
  })

  it('does not blame eligibility when the destination is the problem', async () => {
    // THE PAGE CONTRADICTED ITSELF. The Destination card said "cannot run" while the catalogue
    // below said "runs by itself ... nothing is eligible" -- which sends a reader to check their
    // retention threshold when the actual cause is that there is nowhere to write.
    withDestination([{ key: 'archive.enabled', value: true }])
    await show([], 'Administrator')
    await waitFor(() => expect(screen.getByText(/nowhere to write it yet/i)).toBeInTheDocument())
    expect(within(catalogue()).queryByText(/runs by itself/i)).toBeNull()
    expect(within(catalogue()).queryByText(/eligible/i)).toBeNull()
  })

  it('still explains eligibility once the destination is complete', async () => {
    // The other side: with somewhere to write, an empty catalogue really IS about eligibility, and
    // that explanation must not have been thrown away with the wrong one.
    withDestination([
      { key: 'archive.enabled', value: true },
      { key: 'archive.endpoint', value: 'https://s3.eu-west-2.amazonaws.com' },
      { key: 'archive.region', value: 'eu-west-2' },
      { key: 'archive.bucket', value: 'plant-history' },
      { key: 'archive.access_key_id', value: 'AKIAEXAMPLE' },
      { key: 'archive.site_key', value: 'broughton-7f3a9c21' },
    ])
    api.archiveCredentialIsSet.mockResolvedValue(true)
    await show([], 'Administrator')
    await waitFor(() => expect(within(catalogue()).getByText(/runs by itself/i)).toBeInTheDocument())
    expect(screen.queryByText(/cannot run/i)).toBeNull()
  })

  it('will not submit an empty credential', async () => {
    // set_archive_credential() refuses an empty string too -- a vault holding one authenticates
    // against nothing -- but the button is the cheaper of the two places to say so.
    withDestination([])
    await show([], 'Administrator')
    fireEvent.click(await screen.findByRole('button', { name: /set key/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())
    // Whitespace is not a key either.
    fireEvent.change(screen.getByLabelText(/secret access key/i), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(api.setArchiveCredential).not.toHaveBeenCalled()
  })

  it('copies the destination rather than making it be retyped', async () => {
    /* The address goes into an IAM policy, an `aws s3 ls` and a ticket to whoever runs the bucket.
       Retyping it invites a wrong site prefix, which does not fail -- it reads back as an empty
       archive under a key nobody is looking at. */
    withDestination(ENABLED_AND_CONFIGURED)
    await show([], 'Administrator')
    const copy = await screen.findByRole('button', { name: /copy destination/i })
    expect(copy).toHaveAccessibleName(
      /https:\/\/s3\.eu-west-2\.amazonaws\.com\/plant-history\/site=broughton-7f3a9c21\//,
    )
  })
})

describe('the raw window statement', () => {
  const FOURTEEN_DAYS = 14 * 86400

  it('formats whole days as days and anything else as hours', () => {
    expect(formatWindow(FOURTEEN_DAYS)).toBe('14 days')
    expect(formatWindow(86400)).toBe('1 day')
    expect(formatWindow(12 * 3600)).toBe('12 hours')
    expect(formatWindow(null)).toBeNull()
  })

  it('says nothing when the historian could not be read', () => {
    expect(rawWindowStatement(null, true)).toBeNull()
  })

  it('names the rollups alone as the older copy while archiving is off', () => {
    expect(rawWindowStatement({ raw_window_seconds: FOURTEEN_DAYS, archive_armed: false }, false))
      .toBe('Raw telemetry is kept for 14 days. Older readings are in the 1-minute, 5-minute and 1-hour rollups only.')
  })

  it('adds cold storage once the archiver has reported archiving on', () => {
    const s = rawWindowStatement({ raw_window_seconds: FOURTEEN_DAYS, archive_armed: true }, true)
    expect(s).toMatch(/and here on cold storage.$/)
    expect(s).not.toMatch(/has not run/)
  })

  it('warns while archiving is on and the archiver has not reported it', () => {
    // The retention job obeys the report, so until then it drops chunks it has not exported.
    expect(rawWindowStatement({ raw_window_seconds: FOURTEEN_DAYS, archive_armed: false }, true))
      .toMatch(/has not run since archiving was switched on/)
  })

  it('states an indefinite window without naming an older copy', () => {
    expect(rawWindowStatement({ raw_window_seconds: null, archive_armed: false }, false))
      .toBe('Raw telemetry is kept indefinitely.')
  })

  it('is rendered under the page heading', async () => {
    api.rawTelemetryWindow.mockResolvedValue({ raw_window_seconds: FOURTEEN_DAYS, archive_armed: false })
    await show([row()])
    expect(await screen.findByText(/^Raw telemetry is kept for 14 days./)).toHaveClass('page-heading-note')
  })
})

describe('the page layout', () => {
  it('scrolls the catalogue inside its card and counts the chunks', async () => {
    await show([row(), row({ chunk_name: '_hyper_1_39_chunk' })])
    await screen.findByText('_hyper_1_38_chunk')
    expect(document.querySelector('.page-layout.page-fill')).not.toBeNull()
    const card = catalogue()
    expect(card).toHaveClass('card-fill')
    expect(card.querySelector(':scope > .table-wrap')).not.toBeNull()
    expect(card.querySelector('.card-header .section-count').textContent).toBe('2')
  })

  it('titles the page as the rail does, and puts the key action in the Destination header', async () => {
    api.get.mockResolvedValue([])
    await show([row()])
    expect(await screen.findByRole('heading', { name: 'Cold Storage' })).toBeInTheDocument()
    const header = screen.getByText('Destination').closest('.card-header')
    expect(within(header).getByRole('button', { name: 'Set key' })).toBeInTheDocument()
  })
})
