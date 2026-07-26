import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { usePermissions } from '../hooks/usePermissions'

describe('usePermissions hook', () => {
  it('resolves Administrator role and grants permissions', async () => {
    const session = {
      user: {
        id: 'user-admin-1',
        app_metadata: { role: 'Administrator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.userRole).toBe('Administrator')
    })

    expect(result.current.hasPermission('any-permission-uuid')).toBe(true)
  })

  it('resolves Shopfloor_Manager role and grants permissions', async () => {
    const session = {
      user: {
        id: 'user-mgr-2',
        app_metadata: { role: 'Shopfloor_Manager' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.userRole).toBe('Shopfloor_Manager')
    })

    expect(result.current.hasPermission('any-permission-uuid')).toBe(true)
  })

  it('resolves Operator role and denies write permissions (fail-closed)', async () => {
    const session = {
      user: {
        id: 'user-op-3',
        app_metadata: { role: 'Operator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.userRole).toBe('Operator')
    })

    expect(result.current.hasPermission('any-permission-uuid')).toBe(false)
  })

  it('denies permissions when user metadata lacks a role claim (fail-closed)', async () => {
    const session = {
      user: {
        id: 'user-norole-4',
        app_metadata: {},
        user_metadata: {}
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.userRole).toBeNull()
    })

    expect(result.current.hasPermission('any-permission-uuid')).toBe(false)
  })

  it('denies permissions when no session is active', async () => {
    const { result } = renderHook(() => usePermissions(null, vi.fn()))

    expect(result.current.userRole).toBeNull()
    expect(result.current.hasPermission('any-permission-uuid')).toBe(false)
  })
})
