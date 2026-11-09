/**
 * What a desktop notification needs from the browser (utils/notificationPermission.js), what it
 * says, and where a click on it leads (utils/desktopNotifications.js). Notification is a stand-in;
 * jsdom has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { alertNotificationText, alertOpener } from '../utils/desktopNotifications'
import { askNotificationPermission, notificationPermission, notificationSupport } from '../utils/notificationPermission'
import { deviceUrl, gatewayUrl, tabUrl } from '../routes'

const secure = (value) => Object.defineProperty(window, 'isSecureContext', { value, configurable: true })

beforeEach(() => secure(true))
afterEach(() => {
  vi.unstubAllGlobals()
  delete window.isSecureContext
})

describe('whether this browser can raise one', () => {
  it('can where there is a Notification API in a secure context', () => {
    vi.stubGlobal('Notification', { permission: 'default' })
    expect(notificationSupport()).toEqual({ ok: true })
  })

  it('cannot on plain HTTP, even where the browser still defines Notification', () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    secure(false)
    expect(notificationSupport()).toEqual({ ok: false, reason: 'insecure' })
    expect(notificationPermission()).toBeNull()
  })

  it('cannot where there is no Notification, and says that rather than the address', () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationSupport()).toEqual({ ok: false, reason: 'missing' })
    expect(notificationPermission()).toBeNull()
  })

  it.each(['default', 'granted', 'denied'])('reads %s from the browser', (held) => {
    vi.stubGlobal('Notification', { permission: held })
    expect(notificationPermission()).toBe(held)
  })

  it('reads a word it does not know as nothing', () => {
    vi.stubGlobal('Notification', { permission: 'maybe' })
    expect(notificationPermission()).toBeNull()
  })
})

describe('asking the browser', () => {
  it('answers with what a promise-returning browser says', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(() => Promise.resolve('granted')) })
    await expect(askNotificationPermission()).resolves.toBe('granted')
  })

  it('answers with what a callback-only browser passes to its callback', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn((done) => { done('denied') }) })
    await expect(askNotificationPermission()).resolves.toBe('denied')
  })

  it('answers as the browser already stands when asking throws or is rejected', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(() => { throw new TypeError('not from a gesture') }) })
    await expect(askNotificationPermission()).resolves.toBe('default')
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn(() => Promise.reject(new Error('no'))) })
    await expect(askNotificationPermission()).resolves.toBe('denied')
  })

  it('asks the browser once when two listeners answer one click', async () => {
    let answer
    const requestPermission = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const first = askNotificationPermission()
    const second = askNotificationPermission()
    answer('granted')
    await expect(Promise.all([first, second])).resolves.toEqual(['granted', 'granted'])
    expect(requestPermission).toHaveBeenCalledTimes(1)
    // A later question is a new one.
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(() => Promise.resolve('denied')) })
    await expect(askNotificationPermission()).resolves.toBe('denied')
  })

  it('does not ask where the browser cannot raise one', async () => {
    const requestPermission = vi.fn()
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    secure(false)
    await expect(askNotificationPermission()).resolves.toBeNull()
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

describe('what it says', () => {
  const alert = { entity_type: 'device', sparkplug_id: 'devaaaaaaaa000040008264', alert_name: 'Spindle Overtemperature', severity: 'warning' }

  it('is the alert name, then the severity in words, the subject and its place', () => {
    expect(alertNotificationText(alert, { name: 'Press 4', place: 'Machine Shop › Cell 3' })).toEqual({
      title: 'Spindle Overtemperature',
      body: 'Warning on device Press 4, in Machine Shop › Cell 3.',
    })
  })

  it('leaves out a place the subject has, and names it by Sparkplug id when no name was read', () => {
    expect(alertNotificationText(alert, { name: 'Press 4', place: null }).body).toBe('Warning on device Press 4.')
    expect(alertNotificationText(alert, null).body).toBe('Warning on device devaaaaaaaa000040008264.')
    expect(alertNotificationText({ ...alert, sparkplug_id: null }, null).body).toBe('Warning on a device.')
  })

  it('treats a row with no entity type as a device, as the counter does', () => {
    expect(alertNotificationText({ ...alert, entity_type: undefined }, { name: 'Press 4' }).body).toBe('Warning on device Press 4.')
  })

  it('says every severity in words, and never carries a value from the summary', () => {
    for (const [severity, word] of [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']]) {
      expect(alertNotificationText({ ...alert, severity, summary: 'Spindle at 94 °C, limit 80' }, null).body).toMatch(new RegExp(`^${word} on `))
    }
    expect(alertNotificationText({ ...alert, summary: 'Spindle at 94 °C, limit 80' }, null).body).not.toMatch(/94|80/)
  })

  it('names a platform alert and a machine identity alert by what they are', () => {
    expect(alertNotificationText({ entity_type: 'platform', alert_name: 'Backup Stale', severity: 'info' }).body).toBe('Info on the platform.')
    expect(alertNotificationText({ entity_type: 'service_identity', alert_name: 'Token Expires Soon', severity: 'warning' }).body).toBe('Warning on a machine identity.')
  })
})

describe('where a click leads', () => {
  const helpers = () => ({ showDevice: vi.fn(), showGateway: vi.fn(), navigate: vi.fn(), open: vi.fn() })

  it('opens a device through showDevice, by its Sparkplug id, and a gateway through showGateway', () => {
    const h = helpers()
    const open = alertOpener(h)
    open({ entity_type: 'device', sparkplug_id: 'devaaaaaaaa000040008264' })
    open({ sparkplug_id: 'devbbbbbbbb000040008264' })
    open({ entity_type: 'gateway', sparkplug_id: 'gwyaaaaaaaa000040008264' })
    expect(h.showDevice.mock.calls).toEqual([['devaaaaaaaa000040008264'], ['devbbbbbbbb000040008264']])
    expect(h.showGateway.mock.calls).toEqual([['gwyaaaaaaaa000040008264']])
    // The helpers go to the asset's own address (routes.js).
    expect(deviceUrl('devaaaaaaaa000040008264')).toContain('devaaaaaaaa000040008264')
    expect(gatewayUrl('gwyaaaaaaaa000040008264')).toContain('gwyaaaaaaaa000040008264')
    expect(h.navigate).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('opens the page the counter would for a machine identity or a capture job', () => {
    const h = helpers()
    const open = alertOpener(h)
    open({ entity_type: 'service_identity', entity_id: '9f1a0000-0000-4000-8000-000000000264' })
    open({ entity_type: 'platform', rule_uid: 'aber-playback-worker-stale' })
    expect(h.navigate).toHaveBeenCalledTimes(2)
    expect(h.navigate.mock.calls[1][0]).toBe(tabUrl('capture', 'playbacks'))
    expect(h.open).not.toHaveBeenCalled()
  })

  it('opens the rule in Grafana for any other alert, and for a device whose id matched no row', () => {
    const h = helpers()
    const open = alertOpener(h)
    open({ entity_type: 'platform', rule_uid: 'aber-backup-stale', alert_name: 'Backup Stale' })
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.open.mock.calls[0][0]).toContain('aber-backup-stale')
    open({ entity_type: 'device', sparkplug_id: null, rule_uid: 'aber-device-offline' })
    expect(h.open).toHaveBeenCalledTimes(2)
    expect(h.showDevice).not.toHaveBeenCalled()
  })
})
