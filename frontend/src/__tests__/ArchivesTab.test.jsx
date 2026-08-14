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

    fireEvent.click(purgeButton())
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm$/ }))

    // Pluralised to the collection route, the same shape restore uses -- entity_type is
    // singular on the row ('cell') and the API is not ('/cells/').
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/v1/cells/Cell_1'))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('permanently deleted'), 'success')
  })

  it('reloads the list after a delete, so the row does not linger', async () => {
    api.delete.mockResolvedValue(true)
    await showArchives()
    const before = api.get.mock.calls.length

    fireEvent.click(purgeButton())
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm$/ }))

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(before))
  })

  it('reports a failure rather than pretending the row is gone', async () => {
    api.delete.mockRejectedValue(new Error('foreign key violation'))
    const { showToast } = await showArchives()

    fireEvent.click(purgeButton())
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm$/ }))

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
