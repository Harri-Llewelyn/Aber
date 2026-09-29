import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ArchivesTab } from '../components/tabs/ArchivesTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    assetExportDownloadUrl: vi.fn()
  }
}))

// The bundle is a ZIP handed to an anchor; jsdom has no object URLs, and the file is not the fact
// under test.
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))

const ARCHIVED_CELL = {
  entity_id: 'Cell_1', name: 'Assembly Line 1', entity_type: 'cell',
  archived_at: '2026-07-25T10:00:00Z', auto_delete_at: null
}

const showArchives = async (hasPermission = () => true, rows = [ARCHIVED_CELL]) => {
  api.get.mockResolvedValue(rows)
  const showToast = vi.fn()
  render(<ArchivesTab showToast={showToast} hasPermission={hasPermission} />)
  await waitFor(() => expect(screen.getByText(rows[0].name)).toBeInTheDocument())
  return { showToast }
}

const purgeButton = () => screen.getByRole('button', { name: /Permanent Delete/i })

describe('ArchivesTab Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders archived items table and enables restore button for authorized user', async () => {
    const mockArchives = [
      { entity_id: 'Cell_1', name: 'Assembly Line 1', entity_type: 'cell', archived_at: '2026-07-25T10:00:00Z', auto_delete_at: null }
    ]
    api.get.mockResolvedValue(mockArchives)

    const hasPermission = vi.fn().mockReturnValue(true) // Authorized
    const showToast = vi.fn()

    render(<ArchivesTab showToast={showToast} hasPermission={hasPermission} />)

    await waitFor(() => {
      expect(screen.getByText('Assembly Line 1')).toBeInTheDocument()
    })

    const restoreBtn = screen.getByRole('button', { name: /Restore/i })
    expect(restoreBtn).not.toBeDisabled()
  })

  it('disables restore button when user lacks archive management permission', async () => {
    const mockArchives = [
      { entity_id: 'Cell_1', name: 'Assembly Line 1', entity_type: 'cell', archived_at: '2026-07-25T10:00:00Z', auto_delete_at: null }
    ]
    api.get.mockResolvedValue(mockArchives)

    const hasPermission = vi.fn().mockReturnValue(false) // Unauthorized
    const showToast = vi.fn()

    render(<ArchivesTab showToast={showToast} hasPermission={hasPermission} />)

    await waitFor(() => {
      expect(screen.getByText('Assembly Line 1')).toBeInTheDocument()
    })

    const restoreBtn = screen.getByRole('button', { name: /Restore/i })
    expect(restoreBtn).toBeDisabled()
  })
})

/**
 * Permanent Delete: the manual half of the retention policy. The row is really deleted; only the
 * digital thread survives, because audit rows are immutable and independent of the entity.
 */
/**
 * Open the dialog and satisfy its typed-name gate, so the tests about what happens after a
 * confirmed delete do not restate the setup. The gate itself is asserted in its own describe.
 */
const confirmPurge = async (name = 'Assembly Line 1') => {
  fireEvent.click(purgeButton())
  const field = await screen.findByLabelText(/Type the .* to confirm/i)
  fireEvent.change(field, { target: { value: name } })
  fireEvent.click(await screen.findByRole('button', { name: /^Confirm$/ }))
}

describe('ArchivesTab permanent delete', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('never deletes on the first click', async () => {
    await showArchives()

    fireEvent.click(purgeButton())

    expect(api.delete).not.toHaveBeenCalled()
    expect(await screen.findByText(/cannot be restored/i)).toBeInTheDocument()
  })

  // The archives table is a mixed list of cells, gateways and devices and the rows look alike,
  // so the prompt names the one about to go rather than saying "this entity".
  it('names the entity and its type in the confirmation', async () => {
    await showArchives()
    fireEvent.click(purgeButton())

    const prompt = await screen.findByText(/cannot be restored/i)
    expect(prompt.textContent).toContain("'Assembly Line 1'")
    expect(prompt.textContent).toContain('cell')
  })

  it('cancelling deletes nothing', async () => {
    await showArchives()
    fireEvent.click(purgeButton())
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }))

    await waitFor(() => expect(screen.queryByText(/cannot be restored/i)).not.toBeInTheDocument())
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('deletes through the entity-type endpoint once confirmed', async () => {
    api.delete.mockResolvedValue(true)
    const { showToast } = await showArchives()

    await confirmPurge()

    // Pluralised to the collection route, the same shape restore uses -- entity_type is
    // singular on the row ('cell') and the API is not ('/cells/').
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/v1/cells/Cell_1'))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('permanently deleted'), 'success')
  })

  it('reloads the list after a delete, so the row does not linger', async () => {
    api.delete.mockResolvedValue(true)
    await showArchives()
    const before = api.get.mock.calls.length

    await confirmPurge()

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before))
  })

  it('reports a failure rather than pretending the row is gone', async () => {
    api.delete.mockRejectedValue(new Error('foreign key violation'))
    const { showToast } = await showArchives()

    await confirmPurge()

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('foreign key violation', 'error'))
  })

  it('is gated on the same permission as restore', async () => {
    await showArchives(() => false)

    expect(purgeButton()).toBeDisabled()
    fireEvent.click(purgeButton())
    expect(screen.queryByText(/cannot be restored/i)).not.toBeInTheDocument()
  })

  /**
   * Restore is a ghost button and Permanent Delete only takes its danger colour when pointed at:
   * two filled buttons side by side invite the wrong one to be clicked.
   */
  it('does not dress the two actions as equals', async () => {
    await showArchives()

    expect(screen.getByRole('button', { name: /Restore/i }).className).toMatch(/btn-ghost/)
    expect(purgeButton().className).toMatch(/btn-danger-reveal/)
    // Neither is the page's primary action.
    expect(screen.getByRole('button', { name: /Restore/i }).className).not.toMatch(/btn-primary/)
  })
})

/**
 * The typed-name gate on permanent delete. Every other ConfirmModal caller guards something
 * recoverable, and friction only buys attention while it is rare, so the prop is opt-in and these
 * tests pin that.
 */
describe('permanent delete asks for the name back', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('disables the confirming button until the name is typed', async () => {
    await showArchives()
    fireEvent.click(purgeButton())

    const confirm = await screen.findByRole('button', { name: /^Confirm$/ })
    expect(confirm).toBeDisabled()
  })

  it('stays disabled for a near miss', async () => {
    // The whole value of the gate is that it fails on the WRONG name -- the archives table is a
    // mixed list of look-alike rows, which is how the wrong one gets hit in the first place.
    await showArchives()
    fireEvent.click(purgeButton())
    fireEvent.change(await screen.findByLabelText(/Type the .* to confirm/i),
      { target: { value: 'Assembly Line 2' } })

    expect(await screen.findByRole('button', { name: /^Confirm$/ })).toBeDisabled()
  })

  it('stays disabled for the right name in the wrong case', async () => {
    // Exact, case included: a different case means they typed a different name.
    await showArchives()
    fireEvent.click(purgeButton())
    fireEvent.change(await screen.findByLabelText(/Type the .* to confirm/i),
      { target: { value: 'assembly line 1' } })

    expect(await screen.findByRole('button', { name: /^Confirm$/ })).toBeDisabled()
  })

  it('accepts the name with stray whitespace, which is what a copy-paste brings', async () => {
    // Trailing space off the table beside it teaches nothing, so it is trimmed rather than
    // refused. The characters themselves still have to match.
    api.delete.mockResolvedValue(true)
    await showArchives()
    await confirmPurge('  Assembly Line 1  ')

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/v1/cells/Cell_1'))
  })

  it('shows the name it wants, rather than making it a memory test', async () => {
    // The point is to make the operator look at WHICH asset is about to go. A dialog that made
    // them recall it would just send them back to the table with the dialog still open.
    await showArchives()
    fireEvent.click(purgeButton())

    const field = await screen.findByLabelText(/Type the .* to confirm/i)
    expect(field.getAttribute('placeholder')).toBe('Assembly Line 1')
  })

  it('leaves every other confirmation ungated', async () => {
    /* The opt-in, asserted: archiving shares the dialog, and this is what notices if `requireTyped`
       becomes the default. */
    const { ConfirmModal } = await import('../components/modals/ConfirmModal')
    const { container } = render(
      <ConfirmModal message="Archive it?" onConfirm={vi.fn()} onCancel={vi.fn()} />
    )

    expect(container.querySelector('input')).toBeNull()
    expect(screen.getByRole('button', { name: /^Confirm$/ })).not.toBeDisabled()
  })
})

/**
 * Restore asks before it acts but is not gated on typing the name, since it is recoverable. The
 * wording names two consequences: the retention timer is cleared rather than paused, and an
 * archived gateway's broker credential was rotated away, so restore returns it looking active and
 * unable to authenticate.
 */
const ARCHIVED_GATEWAY = {
  entity_id: 'gwy-1', name: 'Line_A_Gateway', entity_type: 'gateway',
  archived_at: '2026-07-25T10:00:00Z', auto_delete_at: '2026-08-25T10:00:00Z',
  credential_revoked_at: '2026-07-25T10:00:01Z'
}

const restoreButton = () => screen.getAllByRole('button', { name: /Restore/i })[0]
/** The confirming button inside the dialog, which shares its verb with the row's button. */
const confirmRestoreButton = async () => {
  const buttons = await screen.findAllByRole('button', { name: /^Restore$/ })
  return buttons[buttons.length - 1]
}

describe('ArchivesTab restore asks first', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('never restores on the first click', async () => {
    await showArchives()

    fireEvent.click(restoreButton())

    expect(api.post).not.toHaveBeenCalled()
    expect(await screen.findByText(/Restore the cell/i)).toBeInTheDocument()
  })

  it('names the entity and its type, since the rows look alike', async () => {
    await showArchives()
    fireEvent.click(restoreButton())

    const prompt = await screen.findByText(/Restore the cell/i)
    expect(prompt.textContent).toContain("'Assembly Line 1'")
  })

  it('cancelling restores nothing', async () => {
    await showArchives()
    fireEvent.click(restoreButton())
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }))

    await waitFor(() => expect(screen.queryByText(/Restore the cell/i)).not.toBeInTheDocument())
    expect(api.post).not.toHaveBeenCalled()
  })

  it('restores through the entity-type endpoint once confirmed', async () => {
    api.post.mockResolvedValue(true)
    const { showToast } = await showArchives()

    fireEvent.click(restoreButton())
    fireEvent.click(await confirmRestoreButton())

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/cells/Cell_1/restore', {}))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('restored'), 'success')
  })

  it('reloads the list after a restore, so the row does not linger', async () => {
    api.post.mockResolvedValue(true)
    await showArchives()
    const before = api.get.mock.calls.length

    fireEvent.click(restoreButton())
    fireEvent.click(await confirmRestoreButton())

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before))
  })

  it('reports a failure rather than pretending the row came back', async () => {
    api.post.mockRejectedValue(new Error('row level security'))
    const { showToast } = await showArchives()

    fireEvent.click(restoreButton())
    fireEvent.click(await confirmRestoreButton())

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('row level security', 'error'))
  })

  it('is gated on the same permission as delete', async () => {
    await showArchives(() => false)

    expect(restoreButton()).toBeDisabled()
    fireEvent.click(restoreButton())
    expect(screen.queryByText(/Restore the cell/i)).not.toBeInTheDocument()
  })

  it('says the retention timer is cleared rather than resumed', async () => {
    // The sentence that stops this reading as ceremony. An entity one day from auto-purge,
    // restored by accident and archived again, is now a full window away from it.
    await showArchives()
    fireEvent.click(restoreButton())

    expect((await screen.findByText(/Restore the cell/i)).textContent)
      .toMatch(/fresh retention window/i)
  })

  it('warns that a restored gateway does not get its broker credential back', async () => {
    // Archiving rotated the credential; restore flips is_archived and nothing else, so the failure
    // would land at the broker, not on this page.
    await showArchives(() => true, [ARCHIVED_GATEWAY])
    fireEvent.click(restoreButton())

    const prompt = await screen.findByText(/Restore the gateway/i)
    expect(prompt.textContent).toMatch(/broker credential was revoked/i)
    expect(prompt.textContent).toMatch(/Access Control/i)
  })

  it('says the repository comes back out of the forge and the deploy key does not', async () => {
    // Archiving reached the forge too (#197): the repository is read-only until a sweep restores
    // it, and the appliance's deploy key was deleted. Restoring reverses the first and cannot
    // reverse the second, which is the same shape of fact as the broker credential above.
    await showArchives(() => true, [{ ...ARCHIVED_GATEWAY, forge_archived_at: '2026-07-25T10:00:02Z' }])
    fireEvent.click(restoreButton())

    const prompt = await screen.findByText(/Restore the gateway/i)
    expect(prompt.textContent).toMatch(/out of the forge’s archive/i)
    expect(prompt.textContent).toMatch(/re-enrol the appliance/i)
  })

  it('says nothing about the forge for a gateway whose repository was never archived', async () => {
    // `forge_archived_at` is the sweep's answer, not an assumption from `is_archived`: a stack
    // with no forge, or a gateway with no repository, has nothing to bring back.
    await showArchives(() => true, [ARCHIVED_GATEWAY])
    fireEvent.click(restoreButton())

    expect((await screen.findByText(/Restore the gateway/i)).textContent).not.toMatch(/forge/i)
  })

  it('does not raise the credential warning for a gateway that never held one', async () => {
    // `credential_revoked_at` is the fact, not the entity type: a gateway archived before it was
    // given an account has nothing to re-mint.
    await showArchives(() => true, [{ ...ARCHIVED_GATEWAY, credential_revoked_at: null }])
    fireEvent.click(restoreButton())

    expect((await screen.findByText(/Restore the gateway/i)).textContent)
      .not.toMatch(/broker credential/i)
  })

  it('does not paint the confirming button as destructive', async () => {
    // A red button on a dialog guarding a constructive act tells the operator they are about to
    // destroy something. The colour is part of what a confirmation asks them to read.
    await showArchives()
    fireEvent.click(restoreButton())

    const confirm = await confirmRestoreButton()
    expect(confirm.className).not.toMatch(/btn-danger/)
    expect(confirm.className).toMatch(/btn-primary/)
  })

  it('says a deleted cell un-files what was in it rather than deleting it', async () => {
    // The dialog used to be silent about it while the database did the opposite: gateways were
    // ON DELETE CASCADE, so a cell's timer could take a gateway marked Permanent with it. 0112
    // made every child SET NULL, and this is the sentence that says so where it is decided.
    await showArchives()
    fireEvent.click(purgeButton())

    const prompt = await screen.findByText(/Permanently delete the cell/i)
    expect(prompt.textContent).toMatch(/un-filed rather than deleted/i)
    expect(prompt.textContent).toMatch(/Unassigned/i)
  })

  it('does not claim a deleted gateway un-files anything', async () => {
    // A gateway holds no assets of its own on this page's terms, and a sentence that applied to
    // every type would be read as boilerplate by the time it mattered.
    await showArchives(() => true, [ARCHIVED_GATEWAY])
    fireEvent.click(purgeButton())

    expect((await screen.findByText(/Permanently delete the gateway/i)).textContent)
      .not.toMatch(/un-filed/i)
  })

  it('still asks for the name back on delete, which stays the rare one', async () => {
    // THE GUARD ON THIS WHOLE CHANGE. Adding a second dialog to this page is exactly how the typed
    // gate gets diluted into ceremony -- so this pins that restore did NOT acquire one.
    await showArchives()
    fireEvent.click(restoreButton())
    expect(screen.queryByLabelText(/Type the .* to confirm/i)).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }))
    fireEvent.click(purgeButton())
    expect(await screen.findByLabelText(/Type the .* to confirm/i)).toBeInTheDocument()
  })
})

/**
 * The lifecycle's other rows: an area archives like everything else, a device can be taken away
 * before it is taken out, and what has been deleted leaves a tombstone on a second card. The page
 * reads three lists, so these route the mock by path rather than answering every GET alike.
 */
import { downloadBlob } from '../utils/downloadBlob'

const ARCHIVED_AREA = {
  entity_id: 'area-1', name: 'Building A', entity_type: 'area',
  archived_at: '2026-09-01T10:00:00Z', auto_delete_at: null, plan_path: 'area-1/plan.svg'
}
const ARCHIVED_DEVICE = {
  entity_id: 'dev-1', name: 'CNC_01', entity_type: 'device',
  archived_at: '2026-09-01T10:00:00Z', auto_delete_at: null
}
const EXPORT_ROW = {
  id: 'exp-1', entity_type: 'devices', entity_id: 'dev-1', name: 'CNC_01', sparkplug_id: 'abc123',
  object_bucket: 'asset-exports', object_key: 'assets/abc123/2026-09-01T10-00-00Z.aasx',
  taken_at: '2026-09-01T10:00:00Z', taken_by_email: 'ops@example.test'
}
const RETIRED_DEVICE = {
  entity_type: 'device', entity_id: 'dev-1', name: 'CNC_01', sparkplug_id: 'abc123',
  archived_at: '2026-09-01T10:00:00Z', retired_at: '2026-10-01T10:00:00Z',
  retired_by: null, retired_by_email: null, thread_id: 42, old_data: {}, exports: [EXPORT_ROW]
}
const RETIRED_GATEWAY = {
  entity_type: 'gateway', entity_id: 'gw-1', name: 'Line_A_Gateway', sparkplug_id: 'def456',
  archived_at: '2026-09-01T10:00:00Z', retired_at: '2026-10-02T10:00:00Z',
  retired_by: 'user-1', retired_by_email: 'admin@example.test', thread_id: 43,
  old_data: { forge_repository_at: '2026-08-01T00:00:00Z' }, exports: []
}

const routed = ({ archives = [], retired = [], exports = [] } = {}) => (path) => {
  if (path.startsWith('/api/v1/archives/retired')) return Promise.resolve(retired)
  if (path.startsWith('/api/v1/archives/exports')) return Promise.resolve(exports)
  if (path.startsWith('/api/v1/archives')) return Promise.resolve(archives)
  return Promise.resolve([])
}

const showLifecycle = async (lists, props = {}) => {
  api.get.mockImplementation(routed(lists))
  const showToast = vi.fn()
  const onViewThread = vi.fn()
  render(<ArchivesTab showToast={showToast} hasPermission={() => true} onViewThread={onViewThread} {...props} />)
  const first = lists.archives?.[0] || lists.retired?.[0]
  await waitFor(() => expect(screen.getAllByText(first.name).length).toBeGreaterThan(0))
  return { showToast, onViewThread }
}

describe('ArchivesTab lists archived areas', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists an area beside the cells, gateways and devices, with the same two actions', async () => {
    await showLifecycle({ archives: [ARCHIVED_AREA] })
    expect(screen.getByText('AREA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restore/i })).not.toBeDisabled()
    expect(purgeButton()).not.toBeDisabled()
    // The export is a device's: an area has no shell and no readings of its own.
    expect(screen.queryByRole('button', { name: /Export Bundle/i })).toBeNull()
  })

  it('says a deleted area un-files its cells, loses its plan, and is refused by an Area-Wide asset', async () => {
    /* The three consequences that are decided elsewhere: cells.area_id is SET NULL, the plan goes
       with the row, and the purge job's DELETE is guarded by the Area-Wide assets that still name
       the area, so a manual delete meets the same refusal. */
    await showLifecycle({ archives: [ARCHIVED_AREA] })
    fireEvent.click(purgeButton())

    const prompt = await screen.findByText(/Permanently delete the area/i)
    expect(prompt.textContent).toMatch(/cells are kept and become unfiled/i)
    expect(prompt.textContent).toMatch(/area plan is deleted/i)
    expect(prompt.textContent).toMatch(/Area-Wide asset/i)
    expect(prompt.textContent).toMatch(/tombstone/i)
  })

  it('does not mention a plan the area never carried', async () => {
    await showLifecycle({ archives: [{ ...ARCHIVED_AREA, plan_path: null }] })
    fireEvent.click(purgeButton())

    expect((await screen.findByText(/Permanently delete the area/i)).textContent).not.toMatch(/area plan/i)
  })
})

describe('ArchivesTab exports a device before it goes', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('offers Export Bundle on a device, and posts the device id to the bundle route', async () => {
    api.post.mockResolvedValue({
      blob: new Blob(['zip']), filename: 'CNC_01-bundle.aasx', format: 'bundle',
      stats: { bundle: { stored: true, raw_rows: 10, hourly_rows: 2, thread_rows: 3, cold_objects: 1 } }
    })
    const { showToast } = await showLifecycle({ archives: [ARCHIVED_DEVICE] })

    fireEvent.click(screen.getByRole('button', { name: /Export Bundle/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/devices/asset-export', { device_id: 'dev-1' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'CNC_01-bundle.aasx'))
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/10 raw and 2 hourly readings.*1 cold object named/), 'success')
  })

  it('says so, loudly, when the bundle was downloaded but not kept on the platform', async () => {
    // The file still reaches the operator: a storage failure must not cost them the export, but it
    // does cost the tombstone its download, and the toast has to say which.
    api.post.mockResolvedValue({
      blob: new Blob(['zip']), filename: 'CNC_01-bundle.aasx', format: 'bundle',
      stats: { bundle: { stored: false, reason: 'bucket missing' } }
    })
    const { showToast } = await showLifecycle({ archives: [ARCHIVED_DEVICE] })

    fireEvent.click(screen.getByRole('button', { name: /Export Bundle/i }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/NOT stored.*bucket missing/), 'warning'))
    expect(downloadBlob).toHaveBeenCalled()
  })

  it('notes the latest export beside the row, so a second one is a choice rather than a habit', async () => {
    await showLifecycle({ archives: [ARCHIVED_DEVICE], exports: [EXPORT_ROW] })
    expect(screen.getByText(/Exported/)).toBeInTheDocument()
  })

  it('tells a device\'s delete dialog to export first', async () => {
    await showLifecycle({ archives: [ARCHIVED_DEVICE] })
    fireEvent.click(purgeButton())

    const prompt = await screen.findByText(/Permanently delete the device/i)
    expect(prompt.textContent).toMatch(/replay lane .* deleted with it/i)
    expect(prompt.textContent).toMatch(/Export a bundle first/i)
  })

  it('withholds the export from a reader who cannot manage archives', async () => {
    api.get.mockImplementation(routed({ archives: [ARCHIVED_DEVICE] }))
    render(<ArchivesTab showToast={vi.fn()} hasPermission={() => false} />)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: /Export Bundle/i })).toBeDisabled()
  })
})

describe('ArchivesTab shows what has been retired', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says when nothing has been retired, in a second card that is always there', async () => {
    await showLifecycle({ archives: [ARCHIVED_CELL] })
    expect(screen.getByText('Retired Entities')).toBeInTheDocument()
    expect(screen.getByText(/Nothing has been retired/)).toBeInTheDocument()
  })

  it('lists the tombstone with its name, type, who retired it and the historian id', async () => {
    await showLifecycle({ retired: [RETIRED_DEVICE, RETIRED_GATEWAY] })
    const rows = [...document.querySelectorAll('.card')].pop().querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('CNC_01')
    expect(rows[0].textContent).toContain('DEVICE')
    // Nobody: the retention timer deleted it.
    expect(rows[0].textContent).toContain('retention timer')
    expect(rows[0].textContent).toContain('abc123')
    expect(rows[1].textContent).toContain('admin@example.test')
  })

  it('opens the digital thread with deleted entities shown, since the row is gone', async () => {
    const { onViewThread } = await showLifecycle({ retired: [RETIRED_DEVICE] })
    fireEvent.click(screen.getByRole('button', { name: /Digital Thread/i }))
    expect(onViewThread).toHaveBeenCalledWith({ id: 'dev-1', type: 'DEVICE', purged: true })
  })

  it('links a gateway to its repository in the forge, which archiving kept', async () => {
    await showLifecycle({ retired: [RETIRED_DEVICE, RETIRED_GATEWAY] })
    const links = screen.getAllByRole('link', { name: /Forge repository/i })
    // Only the gateway, and only because the sweep recorded that it had a repository.
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('gateway-def456'))
  })

  it('offers a bundle exported while the device was alive, from the cold tier\'s bucket', async () => {
    api.assetExportDownloadUrl.mockResolvedValue('https://stack.example.test/signed?apikey=x')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await showLifecycle({ retired: [RETIRED_DEVICE] })

    fireEvent.click(screen.getByRole('button', { name: /^Bundle/i }))

    await waitFor(() => expect(api.assetExportDownloadUrl).toHaveBeenCalledWith(EXPORT_ROW))
    expect(open).toHaveBeenCalledWith('https://stack.example.test/signed?apikey=x', '_blank', 'noopener')
    open.mockRestore()
  })

  it('offers nothing to download for a device that was never exported', async () => {
    await showLifecycle({ retired: [{ ...RETIRED_DEVICE, exports: [] }] })
    expect(screen.queryByRole('button', { name: /^Bundle/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Digital Thread/i })).toBeInTheDocument()
  })

  it('still shows the archived card when the tombstones cannot be read', async () => {
    // The tombstone policy admits archive:manage or digital_thread:read; a reader with neither
    // still has the first card, and the page must not fail closed on the second.
    api.get.mockImplementation((path) => path.startsWith('/api/v1/archives/retired') || path.startsWith('/api/v1/archives/exports')
      ? Promise.reject(new Error('permission denied'))
      : Promise.resolve([ARCHIVED_CELL]))
    render(<ArchivesTab showToast={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    expect(screen.getByText(/Nothing has been retired/)).toBeInTheDocument()
  })
})
