import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { usePermissions } from '../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../constants'
import { supabase } from '../lib/supabaseClient'

vi.mock('../lib/supabaseClient', () => {
  const mockQueryBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation((col, val) => {
      if (val === 'user-db-role-1') {
        return Promise.resolve({
          data: [
            {
              role_id: 1,
              roles: { name: 'Administrator' },
              role_permissions: Object.values(PERMISSION_UUIDS).map(id => ({ permission_id: id }))
            }
          ],
          error: null
        });
      }
      return Promise.resolve({ data: [], error: null });
    })
  };

  return {
    supabase: {
      from: vi.fn(() => mockQueryBuilder)
    }
  };
});

describe('usePermissions hook', () => {
  it('fetches permissions from public.user_roles database tables when present', async () => {
    const session = {
      user: {
        id: 'user-db-role-1',
        app_metadata: { role: 'Administrator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBe('Administrator')
    })

    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.TELEMETRY_READ)).toBe(true)
  })

  it('resolves Administrator role and grants all permissions including management actions via fallback', async () => {
    const session = {
      user: {
        id: 'user-admin-1',
        app_metadata: { role: 'Administrator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBe('Administrator')
    })

    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.CELL_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.TELEMETRY_READ)).toBe(true)
  })

  it('resolves Shopfloor_Manager role and grants management permissions', async () => {
    const session = {
      user: {
        id: 'user-mgr-2',
        app_metadata: { role: 'Shopfloor_Manager' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBe('Shopfloor_Manager')
    })

    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.CELL_MANAGE)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)).toBe(true)
  })

  it('resolves Operator role and denies all management permissions while allowing read permissions', async () => {
    const session = {
      user: {
        id: 'user-op-3',
        app_metadata: { role: 'Operator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBe('Operator')
    })

    // Management actions must be denied
    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.CELL_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.DEVICE_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.QUARANTINE_REJECT)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.DOCUMENT_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.SCHEMA_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.GITOPS_MANAGE)).toBe(false)

    // Read permissions should be allowed
    expect(result.current.hasPermission(PERMISSION_UUIDS.TELEMETRY_READ)).toBe(true)
    expect(result.current.hasPermission(PERMISSION_UUIDS.QUARANTINE_VIEW)).toBe(true)
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
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBeNull()
    })

    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.TELEMETRY_READ)).toBe(false)
  })

  it('ignores role set in user_metadata only and denies permissions (privilege-escalation prevention)', async () => {
    const session = {
      user: {
        id: 'user-attacker-5',
        app_metadata: {},
        user_metadata: { role: 'Administrator' }
      }
    }

    const { result } = renderHook(() => usePermissions(session, vi.fn()))

    await waitFor(() => {
      expect(result.current.loadingPerms).toBe(false)
      expect(result.current.userRole).toBeNull()
    })

    expect(result.current.userPerms.length).toBe(0)
    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(false)
    expect(result.current.hasPermission(PERMISSION_UUIDS.QUARANTINE_APPROVE)).toBe(false)
  })

  it('denies permissions when no session is active', async () => {
    const { result } = renderHook(() => usePermissions(null, vi.fn()))

    expect(result.current.userRole).toBeNull()
    expect(result.current.hasPermission(PERMISSION_UUIDS.GATEWAY_MANAGE)).toBe(false)
  })
})
