import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ArchivesTab } from '../components/tabs/ArchivesTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn()
  }
}))

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
 * Permanent Delete: the manual half of the retention policy.
 *
 * `auto_delete_at` already purges on a timer, and this page has always SHOWN that date without
 * offering any way to act on it -- so an asset archived by mistake sat in the list for thirty
 * days with no control that could clear it. The row is really deleted; only the digital thread
 * survives, which migration 0006 guarantees by making audit rows immutable and independent of
 * the entity they describe.
 */
/**
 * Open the dialog and satisfy its typed-name gate (issue #38).
 *
 * The three tests below assert what happens AFTER a confirmed delete, so each has to get past
 * the gate first. Sharing one helper keeps that setup from being restated -- and means the gate's
 * own behaviour is asserted in exactly one place, in its own describe, rather than incidentally in
 * three tests that are about something else.
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
   * Restore is the ordinary move; Permanent Delete is the irreversible one. They are deliberately
   * not peers -- restore is a ghost button, and delete only takes on its danger colour when
   * pointed at. Two filled buttons side by side invite the wrong one to be clicked at a glance,
   * and the wrong one here cannot be undone.
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
 * The typed-name gate on permanent delete (issue #38).
 *
 * WHY THIS ONE DIALOG AND NOT ALL OF THEM. `ConfirmModal` has ten callers and every other one
 * guards something recoverable -- archiving is a soft flag with a Restore button beside it,
 * deprecating a metric is reversible, discarding a draft costs a retype. Gating them all would
 * train an operator to type through the single dialog where reading it matters, which is the
 * opposite of what the issue asks for. Friction only buys attention while it is rare, so the
 * prop is opt-in and these tests pin that it stays opt-in.
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
    /*
     * THE OPT-IN, ASSERTED. Archiving is the reversible neighbour of this action and shares the
     * dialog; if a future change flipped `requireTyped` on by default, this is what would notice.
     */
    const { ConfirmModal } = await import('../components/modals/ConfirmModal')
    const { container } = render(
      <ConfirmModal message="Archive it?" onConfirm={vi.fn()} onCancel={vi.fn()} />
    )

    expect(container.querySelector('input')).toBeNull()
    expect(screen.getByRole('button', { name: /^Confirm$/ })).not.toBeDisabled()
  })
})

/**
 * Restore asks before it acts (issue #100).
 *
 * WHY IT IS NOT GATED ON TYPING THE NAME, unlike the delete above. The rule that dialog sets holds:
 * friction only buys attention while it is rare, and restore IS recoverable -- you can archive it
 * again. What restore is not is consequence-free, and a one-click act on a table of look-alike
 * mixed-type rows is how the wrong one gets hit.
 *
 * THE TWO CONSEQUENCES ARE THE POINT OF THE WORDING, because "you can just archive it again" is
 * what would make this dialog look like ceremony, and it is not quite true:
 *   * the retention timer is CLEARED rather than paused, so the undo does not restore the clock;
 *   * an archived gateway's broker credential was rotated to a password nobody records, and
 *     restore flips `is_archived` and nothing else -- so it returns looking active and cannot
 *     authenticate.
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
    // Archiving rotated it to a password nobody records; restore flips is_archived and nothing
    // else. Without this the gateway returns to the asset pages looking active and silently
    // cannot publish -- and the failure surfaces at the broker, not on this page.
    await showArchives(() => true, [ARCHIVED_GATEWAY])
    fireEvent.click(restoreButton())

    const prompt = await screen.findByText(/Restore the gateway/i)
    expect(prompt.textContent).toMatch(/broker credential was revoked/i)
    expect(prompt.textContent).toMatch(/Access Control/i)
  })

  it('does not raise the credential warning for a gateway that never held one', async () => {
    // `credential_revoked_at` is the fact, not the entity type. A gateway archived before it was
    // ever given an account has nothing to re-mint, and telling somebody to go and rotate a
    // credential that does not exist sends them to a page with nothing to do on it.
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
