/**
 * Settings › Notifications: the webhook's toolbar, its signing key shown once, a test that shows
 * how it went, and the delivery log, by role. Every role reads the log and the routes; only an
 * Administrator sees and changes the webhook, as the database decides (0247, 0248).
 */
import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsTab } from '../components/tabs/SettingsTab'
import { api } from '../api'
import { SETTINGS_TABS } from '../navigation'
import { deliveryOutcome, parseHosts, SEVERITIES } from '../utils/notifications'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      patchSetting: vi.fn(),
      notificationWebhook: vi.fn(),
      notificationDeliveries: vi.fn(),
      setNotificationWebhookUrl: vi.fn(),
      clearNotificationWebhookUrl: vi.fn(),
      issueNotificationSigningKey: vi.fn(),
      sendTestNotification: vi.fn(),
    },
  }
})

// The Notifications rows alone, so the category is the page's first tab. The allowed hosts are
// edited in the webhook's dialog, so the table leaves them out.
const SETTINGS = [
  {
    id: '1', key: 'notifications.reminder_hours', value: 12, value_type: 'number', category: 'Notifications',
    label: 'Remind every (hours)', description: 'How often an alert still firing is sent again.',
    fallback_source: null, min_value: 1, max_value: 168,
  },
  {
    id: '2', key: 'notifications.webhook_allowed_hosts', value: ['hooks.example.net'], value_type: 'json',
    category: 'Notifications', label: 'Hosts the webhook may post to', description: 'The hosts.', fallback_source: null,
  },
  {
    id: '3', key: 'notifications.webhook_min_severity', value: 'warning', value_type: 'string', category: 'Notifications',
    label: 'Lowest severity the webhook sends', description: 'info, warning or critical.', fallback_source: null,
  },
]

const SET_UP = { visible: true, urlSet: true, signingKeyIssuedAt: '2026-11-05T08:00:00Z', allowedHosts: ['hooks.example.net'] }
const NOTHING = { visible: true, urlSet: false, signingKeyIssuedAt: null, allowedHosts: [] }
const HIDDEN = { visible: false, urlSet: false, signingKeyIssuedAt: null, allowedHosts: [] }

const LOG = [
  { id: 'd-1', event: 'firing', channel: 'webhook', state: 'sent', attempts: 1, response_status: 204, last_error: null,
    created_at: '2026-11-05T09:00:00Z', platform_alerts: { alert_name: 'Device Offline', sparkplug_id: 'press-4' } },
  { id: 'd-2', event: 'reminder', channel: 'webhook', state: 'pending', attempts: 2, response_status: 503,
    last_error: 'The receiver answered 503.', created_at: '2026-11-05T08:00:00Z',
    platform_alerts: { alert_name: 'Gateway Stale', sparkplug_id: null } },
  { id: 'd-3', event: 'test', channel: 'webhook', state: 'dead', attempts: 1, response_status: null,
    last_error: "The webhook's host is not on its allowed hosts, so the message was refused.",
    created_at: '2026-11-05T07:00:00Z', platform_alerts: null },
]

let showToast

const show = async ({ readOnly = false } = {}) => {
  await act(async () => { render(<SettingsTab showToast={showToast} readOnly={readOnly} />) })
  await screen.findByText('Delivery log')
}

const toolbar = () => document.querySelector('.filter-bar')

beforeEach(() => {
  vi.clearAllMocks()
  showToast = vi.fn()
  window.history.replaceState(null, '', '/settings')
  api.get.mockResolvedValue(SETTINGS)
  api.notificationWebhook.mockResolvedValue(SET_UP)
  api.notificationDeliveries.mockResolvedValue(LOG)
})

describe('the category', () => {
  it('is a tab of its own, described by what it holds', () => {
    const tab = SETTINGS_TABS.find(t => t.id === 'notifications')
    expect(tab.label).toBe('Notifications')
    expect(tab.description).toMatch(/webhook/)
  })

  it('lists its routes in the table, the severity as a choice, and leaves the hosts to the dialog', async () => {
    await show()
    expect(screen.getByRole('columnheader', { name: 'Setting' })).toBeInTheDocument()
    const severity = screen.getByLabelText('Lowest severity the webhook sends')
    expect(severity.tagName).toBe('SELECT')
    expect(within(severity).getAllByRole('option').map(o => o.value)).toEqual(SEVERITIES.map(s => s.value))
    expect(screen.getByLabelText('Remind every (hours)')).toBeInTheDocument()
    expect(screen.queryByText('Hosts the webhook may post to')).toBeNull()
  })
})

describe('for anyone but an Administrator', () => {
  it('shows no webhook control, says whose it is, and still shows the log and the routes', async () => {
    api.notificationWebhook.mockResolvedValue(HIDDEN)
    await show({ readOnly: true })
    expect(within(toolbar()).queryAllByRole('button')).toEqual([])
    expect(toolbar()).toHaveTextContent('Only an Administrator sees and changes the webhook')
    expect(screen.getByLabelText('Lowest severity the webhook sends')).toBeDisabled()
    expect(screen.getAllByText('Device Offline · press-4').length).toBeGreaterThan(0)
  })
})

describe('for an Administrator', () => {
  it('marks a webhook with nothing set, and holds the test back until it can be signed', async () => {
    api.notificationWebhook.mockResolvedValue(NOTHING)
    await show()
    const setUp = within(toolbar()).getByRole('button', { name: /Set up the webhook/ })
    expect(setUp).toHaveClass('btn-warning')
    expect(setUp).toHaveAccessibleDescription('Nothing is sent: the webhook has no address.')
    expect(within(toolbar()).getByRole('button', { name: /Send a test/ })).toBeDisabled()
    // Greyed out as every refused action is, not only inert.
    expect(within(toolbar()).getByRole('button', { name: /Send a test/ })).toHaveClass('btn-disabled')
    expect(within(toolbar()).getByRole('button', { name: /Issue signing key/ })).toBeEnabled()
  })

  it('shows the signing key once, then never again', async () => {
    api.notificationWebhook.mockResolvedValueOnce({ ...SET_UP, signingKeyIssuedAt: null })
    api.issueNotificationSigningKey.mockResolvedValue('whsec_fixture-not-a-real-key')
    await show()
    fireEvent.click(within(toolbar()).getByRole('button', { name: /Issue signing key/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/shown/)).toBeInTheDocument()
    expect(within(dialog).queryByDisplayValue(/whsec_/)).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /Issue Key/ })) })

    expect(within(screen.getByRole('dialog')).getByDisplayValue('whsec_fixture-not-a-real-key')).toBeInTheDocument()
    expect(screen.getByText('Copy this now — it is not shown again.')).toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith('Signing key issued', 'success', { to: '/settings/notifications' })

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByDisplayValue(/whsec_/)).toBeNull()

    // Issued now, so asking again is a rotation, and asks before it shows anything.
    await waitFor(() => expect(within(toolbar()).getByRole('button', { name: /Rotate signing key/ })).toBeInTheDocument())
    fireEvent.click(within(toolbar()).getByRole('button', { name: /Rotate signing key/ }))
    const again = screen.getByRole('dialog')
    expect(within(again).getByText(/The old key stops signing at once/)).toBeInTheDocument()
    expect(within(again).getByRole('button', { name: /Rotate Key/ })).toHaveClass('btn-danger')
    expect(within(again).queryByDisplayValue(/whsec_/)).toBeNull()
    expect(api.issueNotificationSigningKey).toHaveBeenCalledTimes(1)
  })

  it('sends a test through the queue and says how it went', async () => {
    api.sendTestNotification.mockResolvedValue('t-1')
    api.notificationDeliveries.mockImplementation(async ({ id } = {}) => (id
      ? [{ id, event: 'test', state: 'sent', attempts: 1, response_status: 204, last_error: null, created_at: '2026-11-05T09:10:00Z' }]
      : LOG))
    await show()
    await act(async () => { fireEvent.click(within(toolbar()).getByRole('button', { name: /Send a test/ })) })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Test sent: the receiver answered 204.', 'success',
      { to: '/settings/notifications' }), { timeout: 4000 })
    expect(api.notificationDeliveries).toHaveBeenCalledWith({ id: 't-1', limit: 1 })
  })

  it('says why a test failed, in the dispatcher’s words', async () => {
    api.sendTestNotification.mockResolvedValue('t-2')
    api.notificationDeliveries.mockImplementation(async ({ id } = {}) => (id
      ? [{ id, event: 'test', state: 'dead', attempts: 1, response_status: 302,
        last_error: 'The receiver answered 302, a redirect, which is not followed.', created_at: '2026-11-05T09:10:00Z' }]
      : LOG))
    await show()
    await act(async () => { fireEvent.click(within(toolbar()).getByRole('button', { name: /Send a test/ })) })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Test failed: The receiver answered 302, a redirect, which is not followed.', 'error', { to: '/settings/notifications' }),
    { timeout: 4000 })
  })

  it('saves the hosts and then the address, and warns of an address whose host is not allowed', async () => {
    api.notificationWebhook.mockResolvedValue({ ...NOTHING, allowedHosts: [] })
    api.patchSetting.mockResolvedValue({})
    api.setNotificationWebhookUrl.mockResolvedValue(true)
    await show()
    fireEvent.click(within(toolbar()).getByRole('button', { name: /Set up the webhook/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'https://Hooks.Example.net/receiver/x' } })
    expect(within(dialog).getByTestId('webhook-host-unlisted')).toHaveTextContent('hooks.example.net is not an allowed host')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow It' }))
    expect(within(dialog).queryByTestId('webhook-host-unlisted')).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save' })) })

    expect(api.patchSetting).toHaveBeenCalledWith('notifications.webhook_allowed_hosts', ['hooks.example.net'])
    expect(api.setNotificationWebhookUrl).toHaveBeenCalledWith('https://Hooks.Example.net/receiver/x')
    expect(api.patchSetting.mock.invocationCallOrder[0]).toBeLessThan(api.setNotificationWebhookUrl.mock.invocationCallOrder[0])
    expect(showToast).toHaveBeenCalledWith('Webhook saved. Each alert is posted to it from now on.', 'success',
      { to: '/settings/notifications' })
  })

  it('removes the webhook after asking, and says what was dropped', async () => {
    api.clearNotificationWebhookUrl.mockResolvedValue(2)
    await show()
    fireEvent.click(within(toolbar()).getByRole('button', { name: /Change webhook/ }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove the webhook' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove the webhook' }))
    })
    expect(api.clearNotificationWebhookUrl).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Webhook removed. 2 waiting messages were dropped.', 'success',
      { to: '/settings/notifications' })
  })
})

describe('the delivery log', () => {
  it('lists each message with its time, event, alert, outcome, attempts and last error', async () => {
    await show()
    const table = screen.getByText('Delivery log').closest('section').querySelector('table')
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent))
      .toEqual(['Time', 'Event', 'Alert', 'Outcome', 'Attempts', 'Last error'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Firing', 'Reminder', 'Test'])
    expect(rows.map(r => within(r).getAllByRole('cell')[3].textContent)).toEqual(['Sent', 'Retrying', 'Failed'])
    expect(within(rows[1]).getByText('The receiver answered 503.')).toBeInTheDocument()
    expect(within(rows[2]).getByText('A test, sent from this page')).toBeInTheDocument()
    expect(within(rows[0]).getByText('None')).toBeInTheDocument()
  })

  it('says when nothing has been sent', async () => {
    api.notificationDeliveries.mockResolvedValue([])
    await show()
    expect(screen.getByText('Nothing has been sent yet.')).toBeInTheDocument()
  })
})

describe('the helpers', () => {
  it('reads hosts one a line, lower-cased, each once, and a pasted address as its host', () => {
    expect(parseHosts('Hooks.Example.net\n hooks.example.net, 10.0.0.7  https://chat.example.org/x/y'))
      .toEqual(['hooks.example.net', '10.0.0.7', 'chat.example.org'])
  })

  it('names every outcome in words, never by colour alone', () => {
    expect(['sent', 'dropped', 'dead'].map(state => deliveryOutcome({ state, attempts: 1 }).label))
      .toEqual(['Sent', 'Not sent', 'Failed'])
    expect(deliveryOutcome({ state: 'pending', attempts: 0 }).label).toBe('Waiting')
    expect(deliveryOutcome({ state: 'pending', attempts: 3 }).detail).toBe('Tried 3 times; it is tried again.')
  })
})
