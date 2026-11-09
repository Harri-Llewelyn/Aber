/**
 * A desktop notification follows the read the alert counter makes (usePlatformAlerts), through
 * the real hook: the first read raises nothing, the reconcile every minute and a Grafana repeat of
 * a row raise nothing, and a resolve closes what was raised. The toast keeps its own rule.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async () => ({ ...(await vi.importActual('../api')), api: { readAlertSubject: vi.fn() } }))

const { api } = await import('../api')
const { supabase } = await import('../lib/supabaseClient')
const { useDesktopAlerts } = await import('../hooks/useDesktopAlerts')
const { usePlatformAlerts, RECONCILE_MS } = await import('../hooks/usePlatformAlerts')

const row = (over = {}) => ({
  id: 'occ-1',
  fingerprint: 'fp-offline-press4',
  entity_type: 'device',
  entity_id: 'dddddddd-0000-4000-8000-000000000264',
  sparkplug_id: 'devdddddddd000040008264',
  alert_name: 'Device Offline',
  severity: 'critical',
  summary: 'Press 4 has stopped reporting',
  starts_at: '2026-11-09T09:00:00Z',
  acknowledged_at: null,
  suppressed: false,
  suppressed_until: null,
  ...over,
})

let current
let raised

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date('2026-11-09T09:00:00Z'))
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  raised = []
  const Fake = function Notification(title, options) {
    this.title = title
    this.options = options
    this.close = vi.fn()
    raised.push(this)
  }
  Fake.permission = 'granted'
  vi.stubGlobal('Notification', Fake)
  api.readAlertSubject.mockReset().mockResolvedValue({ name: 'Press 4', place: null })
  vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: {} } })
  vi.spyOn(supabase, 'from').mockImplementation((table) => {
    if (table === 'alert_suppression_windows') {
      const chain = { select: () => chain, gt: () => chain, order: () => chain, limit: () => Promise.resolve({ data: [], error: null }) }
      return chain
    }
    return { select: () => ({ order: () => Promise.resolve({ data: current, error: null }) }) }
  })
  vi.spyOn(supabase, 'channel').mockReturnValue({ on() { return this }, subscribe() { return this } })
  vi.spyOn(supabase, 'removeChannel').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.isSecureContext
})

const minute = () => act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_MS + 10) })

async function mount(rows) {
  current = rows
  const showToast = vi.fn()
  const hook = renderHook(() => usePlatformAlerts(showToast, useDesktopAlerts({ enabled: true, userId: 'u1', onOpen: vi.fn() })))
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  return { showToast, hook }
}

describe('a desktop notification and the alert counter read the same alerts', () => {
  it('raises nothing for what is firing at the first read, and nothing on any later read of it', async () => {
    await mount([row()])
    await minute()
    await minute()
    expect(raised).toEqual([])
  })

  it('raises one for an alert that starts firing, and none as Grafana repeats it or the counter reconciles', async () => {
    const { showToast } = await mount([])
    current = [row()]
    await minute()
    expect(raised).toHaveLength(1)
    expect(raised[0].title).toBe('Device Offline')
    expect(raised[0].options.tag).toBe('occ-1')
    // The webhook upserts the same occurrence on every repeat, with a later last-confirmed time.
    current = [row({ summary: 'Press 4 has stopped reporting, still' })]
    await minute()
    await minute()
    expect(raised).toHaveLength(1)
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('closes it when the alert resolves, which is also when the counter toasts it resolved', async () => {
    const { showToast } = await mount([])
    current = [row()]
    await minute()
    current = []
    await minute()
    expect(raised[0].close).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenLastCalledWith('Resolved — Device Offline', 'success', expect.objectContaining({ group: 'alert' }))
  })

  it('closes it when somebody acknowledges the alert', async () => {
    await mount([])
    current = [row()]
    await minute()
    current = [row({ acknowledged_at: '2026-11-09T09:03:00Z', acknowledged_by: 'u2', acknowledged_by_email: 'op@aber.local' })]
    await minute()
    expect(raised[0].close).toHaveBeenCalledTimes(1)
    expect(raised).toHaveLength(1)
  })
})
