/**
 * A firing alert raises a browser notification for a person who turned them on. What would go wrong
 * quietly: one raised on every refresh or Grafana repeat (a notification per minute); one raised for
 * an alert somebody has already acknowledged, or a suppression window keeps quiet; one left on
 * screen after the alert resolved; one raised for everything already firing when the setting is
 * turned on; a click that opens nothing. Notification is a stand-in that records what was raised.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async () => ({ ...(await vi.importActual('../api')), api: { readAlertSubject: vi.fn() } }))

const { api } = await import('../api')
const { useDesktopAlerts, ASKED_KEY } = await import('../hooks/useDesktopAlerts')
const { SUBJECT_WAIT_MS } = await import('../utils/desktopNotifications')

const DEVICE = 'dddddddd-0000-4000-8000-000000000264'
const GATEWAY = 'cccccccc-0000-4000-8000-000000000264'

const alert = (over = {}) => ({
  id: 'occ-1',
  fingerprint: 'fp-offline-press4',
  entity_type: 'device',
  entity_id: DEVICE,
  sparkplug_id: 'devdddddddd000040008264',
  alert_name: 'Device Offline',
  severity: 'critical',
  summary: 'Press 4 has stopped reporting, 0 messages in 5 min',
  starts_at: '2026-11-09T09:00:00Z',
  acknowledged_at: null,
  suppressed: false,
  suppressed_until: null,
  ...over,
})

/** What the browser raised, newest last. */
let raised
let requestPermission
let focus

const browser = (permission = 'granted', answer = permission) => {
  raised = []
  const Fake = function Notification(title, options) {
    this.title = title
    this.options = options
    this.close = vi.fn()
    raised.push(this)
  }
  Fake.permission = permission
  requestPermission = vi.fn((done) => {
    Fake.permission = answer
    done?.(answer)
    return Promise.resolve(answer)
  })
  Fake.requestPermission = requestPermission
  vi.stubGlobal('Notification', Fake)
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  api.readAlertSubject.mockResolvedValue({ name: 'Press 4', place: 'Machine Shop › Cell 3' })
  focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  browser()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.isSecureContext
})

/** The hook, primed by a first read of `first`, and a `read` that feeds it the next one. */
async function mount({ enabled = true, first = [], onOpen = vi.fn(), userId = 'u1' } = {}) {
  const hook = renderHook((props) => useDesktopAlerts(props), { initialProps: { enabled, userId, onOpen } })
  const read = async (rows) => { await act(async () => { hook.result.current(rows) }) }
  await read(first)
  return { hook, read, onOpen }
}

describe('when it raises one', () => {
  it('raises nothing for what is already firing when the dashboard opens', async () => {
    const { read } = await mount({ first: [alert()] })
    expect(raised).toEqual([])
    await read([alert()])
    await settle()
    expect(raised).toEqual([])
  })

  it('raises one for an alert that starts firing, naming it, its subject, place and severity', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    expect(raised[0].title).toBe('Device Offline')
    expect(raised[0].options).toMatchObject({
      body: 'Critical on device Press 4, in Machine Shop › Cell 3.',
      tag: 'occ-1',
    })
    expect(raised[0].options.icon).toMatch(/\/favicon\.svg$/)
    // No value from the summary: the counter holds those.
    expect(raised[0].options.body).not.toMatch(/messages|5 min/)
    expect(api.readAlertSubject).toHaveBeenCalledTimes(1)
  })

  it('raises nothing on a refresh or a repeat of the same occurrence', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    // Grafana repeats the alert: the same row, upserted.
    await read([alert()])
    await read([alert({ summary: 'Press 4 has stopped reporting, 0 messages in 6 min' })])
    await settle()
    expect(raised).toHaveLength(1)
    // A different occurrence still raises its own.
    await read([alert(), alert({ id: 'occ-2', fingerprint: 'fp-other', alert_name: 'Other' })])
    await waitFor(() => expect(raised).toHaveLength(2))
    expect(raised.map(n => n.options.tag)).toEqual(['occ-1', 'occ-2'])
  })

  it('raises one again when the same alert fires anew, as a new occurrence', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    await read([])
    await read([alert({ id: 'occ-3', starts_at: '2026-11-09T10:00:00Z' })])
    await waitFor(() => expect(raised).toHaveLength(2))
    expect(raised[1].options.tag).toBe('occ-3')
  })

  it('names a gateway, and a platform or machine identity alert by what it is', async () => {
    api.readAlertSubject.mockImplementation(async (a) => (a.entity_type === 'gateway' ? { name: 'Line 2 gateway', place: 'Machine Shop' } : null))
    const { read } = await mount()
    await read([
      alert({ id: 'g1', entity_type: 'gateway', entity_id: GATEWAY, sparkplug_id: 'gwycccccccc000040008264', severity: 'warning', alert_name: 'Gateway Offline' }),
      alert({ id: 'p1', entity_type: 'platform', entity_id: null, sparkplug_id: null, severity: 'info', alert_name: 'Backup Stale' }),
      alert({ id: 's1', entity_type: 'service_identity', sparkplug_id: null, severity: 'warning', alert_name: 'Token Expires Soon' }),
    ])
    await waitFor(() => expect(raised).toHaveLength(3))
    const bodies = Object.fromEntries(raised.map(n => [n.options.tag, n.options.body]))
    expect(bodies).toEqual({
      g1: 'Warning on gateway Line 2 gateway, in Machine Shop.',
      p1: 'Info on the platform.',
      s1: 'Warning on a machine identity.',
    })
  })

  it('names the subject by its Sparkplug id when it cannot be read, and without a place when it has none', async () => {
    api.readAlertSubject.mockResolvedValue(null)
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    expect(raised[0].options.body).toBe('Critical on device devdddddddd000040008264.')
    api.readAlertSubject.mockResolvedValue({ name: 'Press 5', place: null })
    await read([alert(), alert({ id: 'occ-2' })])
    await waitFor(() => expect(raised).toHaveLength(2))
    expect(raised[1].options.body).toBe('Critical on device Press 5.')
  })

  it('does not wait for a slow read of the subject for more than a moment', async () => {
    vi.useFakeTimers()
    api.readAlertSubject.mockReturnValue(new Promise(() => {}))
    const { read } = await mount()
    await read([alert()])
    expect(raised).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(SUBJECT_WAIT_MS + 10) })
    expect(raised).toHaveLength(1)
    expect(raised[0].options.body).toBe('Critical on device devdddddddd000040008264.')
  })
})

describe('what raises nothing', () => {
  it('an acknowledged alert, and an alert in a suppression window', async () => {
    const { read } = await mount()
    await read([
      alert({ id: 'a1', acknowledged_at: '2026-11-09T09:00:05Z' }),
      alert({ id: 'q1', suppressed: true, suppressed_until: '2026-11-09T12:00:00Z' }),
    ])
    await settle()
    expect(raised).toEqual([])
  })

  it('an alert whose acknowledgement is withdrawn, which started firing earlier', async () => {
    const { read } = await mount({ first: [alert({ acknowledged_at: '2026-11-09T09:05:00Z' })] })
    await read([alert()])
    await settle()
    expect(raised).toEqual([])
  })

  it('anything while the setting is off, and nothing for what was firing when it is turned on', async () => {
    const { hook, read } = await mount({ enabled: false })
    await read([alert()])
    await settle()
    expect(raised).toEqual([])
    hook.rerender({ enabled: true, userId: 'u1', onOpen: vi.fn() })
    await read([alert()])
    await settle()
    expect(raised).toEqual([])
    await read([alert(), alert({ id: 'occ-2' })])
    await waitFor(() => expect(raised).toHaveLength(1))
    expect(raised[0].options.tag).toBe('occ-2')
  })

  it.each(['default', 'denied'])('a browser whose permission is %s', async (permission) => {
    browser(permission)
    const { read } = await mount()
    await read([alert()])
    await settle()
    expect(raised).toEqual([])
  })

  it('a browser that has no Notification, or that throws on one', async () => {
    vi.stubGlobal('Notification', undefined)
    const { read } = await mount()
    await read([alert()])
    await settle()
    expect(raised).toEqual([])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Throws = function Notification() { throw new TypeError('Illegal constructor') }
    Throws.permission = 'granted'
    vi.stubGlobal('Notification', Throws)
    await read([alert(), alert({ id: 'occ-2' })])
    await waitFor(() => expect(warn).toHaveBeenCalled())
  })
})

describe('when it closes', () => {
  it('on resolve, which drops the occurrence from the active set', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    await read([])
    expect(raised[0].close).toHaveBeenCalledTimes(1)
  })

  it('on acknowledgement, and raises no second one when the acknowledgement is withdrawn', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    await read([alert({ acknowledged_at: '2026-11-09T09:02:00Z' })])
    expect(raised[0].close).toHaveBeenCalledTimes(1)
    await read([alert()])
    await settle()
    expect(raised).toHaveLength(1)
  })

  it('when a suppression window opens over the alert, and raises one when the window ends while it still fires', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    await read([alert({ suppressed: true, suppressed_until: '2026-11-09T12:00:00Z' })])
    expect(raised[0].close).toHaveBeenCalledTimes(1)
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(2))
    expect(raised[1].options.tag).toBe('occ-1')
  })

  it('when the person turns the setting off, and when the dashboard closes', async () => {
    const { hook, read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    hook.rerender({ enabled: false, userId: 'u1', onOpen: vi.fn() })
    expect(raised[0].close).toHaveBeenCalledTimes(1)

    hook.rerender({ enabled: true, userId: 'u1', onOpen: vi.fn() })
    await read([alert(), alert({ id: 'occ-2' })])
    await waitFor(() => expect(raised).toHaveLength(2))
    hook.unmount()
    expect(raised[1].close).toHaveBeenCalledTimes(1)
  })

  it('and raises nothing for an alert that resolved while its subject was being read', async () => {
    let answer
    api.readAlertSubject.mockReturnValue(new Promise(resolve => { answer = resolve }))
    const { read } = await mount()
    await read([alert()])
    await read([])
    await act(async () => { answer({ name: 'Press 4', place: null }) })
    await settle()
    expect(raised).toEqual([])
  })

  it('and does not close it a second time once the person has dismissed it', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    raised[0].onclose()
    await read([])
    expect(raised[0].close).not.toHaveBeenCalled()
  })

  it('and raises none again for the occurrence the person dismissed, when Grafana repeats it', async () => {
    const { read } = await mount()
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    raised[0].onclose()
    await read([alert()])
    await read([alert({ summary: 'Press 4 has stopped reporting, 0 messages in 6 min' })])
    await settle()
    expect(raised).toHaveLength(1)
  })
})

describe('a click', () => {
  it('focuses the dashboard, closes the notification and opens the alert', async () => {
    const onOpen = vi.fn()
    const { read } = await mount({ onOpen })
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    raised[0].onclick()
    expect(focus).toHaveBeenCalled()
    expect(raised[0].close).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'occ-1', sparkplug_id: 'devdddddddd000040008264' }))
  })

  it('opens it with the opener the dashboard has now, not the one it had when the alert fired', async () => {
    const first = vi.fn()
    const later = vi.fn()
    const { hook, read } = await mount({ onOpen: first })
    await read([alert()])
    await waitFor(() => expect(raised).toHaveLength(1))
    hook.rerender({ enabled: true, userId: 'u1', onOpen: later })
    raised[0].onclick()
    expect(first).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledTimes(1)
  })
})

describe('the permission prompt', () => {
  it('comes at the first click or key press of a session when the setting is on and the browser has not been asked', async () => {
    browser('default', 'granted')
    await mount()
    expect(requestPermission).not.toHaveBeenCalled()
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    document.body.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(ASKED_KEY)).toBe('asked')
  })

  it('writes nothing of the person to storage: the tab remembers that it asked, not whom', async () => {
    browser('default', 'default')
    await mount({ userId: 'u1-person-id' })
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)
        expect(`${key}=${store.getItem(key)}`).not.toContain('u1-person-id')
      }
    }
  })

  it('is not asked again after a reload of a session that already asked, even if the person dismissed it', async () => {
    browser('default', 'default')
    const { hook } = await mount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(requestPermission).toHaveBeenCalledTimes(1)
    // A reload runs no cleanup, so the tab's marker stays: put back what unmounting clears.
    hook.unmount()
    sessionStorage.setItem(ASKED_KEY, 'asked')
    await mount()
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('is asked again when the next person signs in, after a sign-out or a different id', async () => {
    browser('default', 'default')
    const { hook } = await mount({ userId: 'u1' })
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    // The first prompt has been answered: one still showing would be asked once, not twice.
    await settle()
    // Another person's id arrives in the same tab.
    hook.rerender({ enabled: true, userId: 'u2', onOpen: vi.fn() })
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(2)
    await settle()
    // Signing out unmounts the dashboard.
    hook.unmount()
    expect(sessionStorage.getItem(ASKED_KEY)).toBeNull()
    await mount({ userId: 'u3' })
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(3)
  })

  it('is not asked again for the same person when the dashboard renders again', async () => {
    browser('default', 'default')
    const { hook } = await mount({ userId: 'u1' })
    document.body.click()
    hook.rerender({ enabled: true, userId: 'u1', onOpen: vi.fn() })
    document.body.click()
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the setting is off', { enabled: false }, 'default'],
    ['the browser has already answered', {}, 'granted'],
    ['the browser has refused', {}, 'denied'],
  ])('is not raised when %s', async (_label, props, permission) => {
    browser(permission)
    await mount(props)
    document.body.click()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('is not raised on plain HTTP, where the browser would refuse it', async () => {
    browser('default')
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    await mount()
    document.body.click()
    expect(requestPermission).not.toHaveBeenCalled()
  })
})
