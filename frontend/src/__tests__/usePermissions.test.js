import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePermissions } from '../hooks/usePermissions'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn()
  },
  setGlobalToken: vi.fn()
}))

describe('usePermissions hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false during loading and updates permissions on fetch success', async () => {
    const auth = {
      isAuthenticated: true,
      user: { access_token: 'fake-jwt-token' }
    }
    const mockPerms = {
      permissions: [
        { permission_uuid: '00000000-0000-0000-0000-000000000001' },
        { permission_uuid: '00000000-0000-0000-0000-000000000002' }
      ]
    }
    api.get.mockResolvedValue(mockPerms)

    const { result } = renderHook(() => usePermissions(auth, vi.fn()))

    await waitFor(() => {
      expect(result.current.userPerms.length).toBe(2)
    })

    expect(result.current.loadingPerms).toBe(false)
    expect(result.current.hasPermission('00000000-0000-0000-0000-000000000001')).toBe(true)
    expect(result.current.hasPermission('00000000-0000-0000-0000-000000000002')).toBe(true)
    expect(result.current.hasPermission('00000000-0000-0000-0000-000000000099')).toBe(false)
  })

  it('handles fetch failure safely by resetting permissions and setting error state', async () => {
    const auth = {
      isAuthenticated: true,
      user: { access_token: 'fake-jwt-token' }
    }
    const showToast = vi.fn()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.get.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => usePermissions(auth, showToast))

    await waitFor(() => {
      expect(result.current.errorPerms).toBeTruthy()
    })

    expect(result.current.loadingPerms).toBe(false)
    expect(result.current.hasPermission('00000000-0000-0000-0000-000000000001')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('Failed to load user permissions from database', 'error')
    consoleSpy.mockRestore()
  })
})
