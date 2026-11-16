import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'
import { useNavSignals } from '../hooks/useNavSignals'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'

/**
 * The rail's alert counts read the list the header's counter already holds. The hook is handed it:
 * it makes the four reads it always made, none for alerts, and opens no channel or query of its own
 * on the alerts tables.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}))

const manager = {
  userRole: 'Shopfloor_Manager',
  userId: 'me',
  hasPermission: (p) => DEFAULT_ROLE_PERMISSIONS_MAP.Shopfloor_Manager.includes(p),
}

const alert = (over = {}) => ({
  id: 'a-1', fingerprint: 'fp-1', entity_type: 'device', entity_id: 'dev-1', sparkplug_id: 'dev_1',
  alert_name: 'Spindle hot', severity: 'critical', acknowledged_at: null, suppressed: false, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue([])
})

describe('useNavSignals reads the alerts it is handed', () => {
  it('flags the devices with an alert from the list, and re-flags when the list changes, with no further read', async () => {
    const { result, rerender } = renderHook(({ alerts }) => useNavSignals({ ...manager, alerts }), { initialProps: { alerts: [] } })
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(result.current.devices).toBeUndefined()
    const reads = api.get.mock.calls.length

    rerender({ alerts: [alert(), alert({ alert_name: 'Vibration' })] })
    expect(result.current.devices).toMatchObject({ tone: 'danger', count: 1, note: '1 device with a firing alert' })

    // Acknowledged, the device drops out of the rail with the counter, on the same list.
    rerender({ alerts: [alert({ acknowledged_at: '2026-11-16T10:00:00Z' })] })
    expect(result.current.devices).toBeUndefined()
    expect(api.get.mock.calls.length).toBe(reads)
  })

  it('reads cells, gateways, devices and proposals as it always did, and no alerts', async () => {
    renderHook(() => useNavSignals({ ...manager, alerts: [alert()] }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4))
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual([
      '/api/v1/cells', '/api/v1/devices', '/api/v1/gateways', '/api/v1/proposals',
    ])
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
