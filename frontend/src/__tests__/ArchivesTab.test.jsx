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
