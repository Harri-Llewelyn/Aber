import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ArchivesTab } from '../components/tabs/ArchivesTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

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
