import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrokerSubscriberModal } from '../components/modals/BrokerSubscriberModal'
import { api } from '../api'
import { BROKER_DIRECTORY_ID } from '../utils/edgeNodeSettings'

/**
 * New Read-Only Account asks what the account is for, makes it through broker-subscriber, then
 * shows everything a consumer is configured with: the broker's address, the username, the password
 * once, the topics it may read and the root certificate. The password is shown the way a gateway
 * credential's is, and goes when the dialog closes.
 */

vi.mock('../api', () => ({
  api: { createBrokerSubscriber: vi.fn(), get: vi.fn() }
}))

const ACCOUNT = {
  mqtt_username: 'sub0a1b2c3d4e5f60718293a',
  // Made up, and low in entropy so a secret scan does not read it as a credential.
  password: 'readonly-readonly-readonly',
  name: 'Line 4 OEE board',
  description: 'The contractor dashboard on line 4.',
  role: 'subscriber',
  audit_recorded: true,
}
const TOPICS = ['spBv1.0/#', 'plant/uns/#']
const DIRECTORY = [
  { service_uuid: BROKER_DIRECTORY_ID, service_type: 'MQTT_BROKER', endpoint_url: 'mqtts://mqtt.plant.example:8883' }
]

let written
beforeEach(() => {
  vi.clearAllMocks()
  written = []
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) } })
  api.get.mockResolvedValue(DIRECTORY)
  api.createBrokerSubscriber.mockResolvedValue(ACCOUNT)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function open(props = {}) {
  const handlers = { onClose: vi.fn(), onCreated: vi.fn(), showToast: vi.fn() }
  render(<BrokerSubscriberModal topics={TOPICS} {...handlers} {...props} />)
  return handlers
}

const nameBox = () => screen.getByLabelText('Name')
const purposeBox = () => screen.getByLabelText('What it is for')
const createButton = () => screen.getByRole('button', { name: /Create Read-Only Account/ })

async function create(handlers) {
  fireEvent.change(nameBox(), { target: { value: `  ${ACCOUNT.name} ` } })
  fireEvent.change(purposeBox(), { target: { value: ACCOUNT.description } })
  await act(async () => { fireEvent.click(createButton()) })
  await waitFor(() => expect(screen.getByDisplayValue(ACCOUNT.password)).toBeInTheDocument())
  await waitFor(() => expect(screen.getByLabelText('Broker address').value).toBe('mqtt.plant.example'))
  return handlers
}

describe('New Read-Only Account', () => {
  it('says what the account can do before anything is made, and starts on the name', () => {
    open()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/publishes nothing/)).toBeTruthy()
    expect(within(dialog).getByText('subscriber')).toBeTruthy()
    expect(document.activeElement).toBe(nameBox())
    expect(api.createBrokerSubscriber).not.toHaveBeenCalled()
  })

  it('needs a name and what it is for before it creates anything', () => {
    open()
    expect(createButton()).toBeDisabled()
    fireEvent.change(nameBox(), { target: { value: ACCOUNT.name } })
    expect(createButton()).toBeDisabled()
    fireEvent.change(purposeBox(), { target: { value: '   ' } })
    expect(createButton()).toBeDisabled()
    fireEvent.change(purposeBox(), { target: { value: ACCOUNT.description } })
    expect(createButton()).not.toBeDisabled()
    expect(nameBox()).toHaveAttribute('maxLength', '80')
    expect(purposeBox()).toHaveAttribute('maxLength', '500')
  })

  it('keeps what it is for on one line, as the broker stores it', () => {
    open()
    fireEvent.change(purposeBox(), { target: { value: 'Line 4\nOEE board' } })
    expect(purposeBox().value).toBe('Line 4 OEE board')
  })

  it('creates it with the trimmed name and description, then shows the password once with every setting', async () => {
    const handlers = await create(open())
    expect(api.createBrokerSubscriber).toHaveBeenCalledWith({ name: ACCOUNT.name, description: ACCOUNT.description })
    expect(handlers.onCreated).toHaveBeenCalledWith(ACCOUNT)
    expect(handlers.showToast).toHaveBeenCalledWith(
      'Read-only account “Line 4 OEE board” created', 'success', { to: '/access-control/accounts' }
    )

    const value = (label) => screen.getByLabelText(label).value
    expect(value('Broker address')).toBe('mqtt.plant.example')
    expect(value('TLS port')).toBe('8883')
    expect(value('Username')).toBe(ACCOUNT.mqtt_username)
    expect(value('Password')).toBe(ACCOUNT.password)
    expect(value('Root certificate')).toMatch(/\/\.well-known\/aber\/ca\.pem$/)
    const topics = screen.getByRole('list', { name: 'Topics it may read' })
    expect(within(topics).getAllByRole('listitem').map(li => li.textContent)).toEqual(TOPICS)
    expect(screen.getByText(/not a Sparkplug Host Application/)).toBeTruthy()
    expect(screen.getByText(/it is not shown again/)).toBeTruthy()
    // The password is in the dialog alone: never in a toast.
    expect(JSON.stringify(handlers.showToast.mock.calls)).not.toContain(ACCOUNT.password)

    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }))
    await waitFor(() => expect(written).toEqual([ACCOUNT.password]))
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }))
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it('says when the broker did not report what it may read', async () => {
    await create(open({ topics: null }))
    expect(screen.queryByRole('list', { name: 'Topics it may read' })).toBeNull()
    expect(screen.getByText(/did not report the subscriber role’s rules/)).toBeTruthy()
  })

  it('says when the Directory could not be read, rather than guessing the broker', async () => {
    api.get.mockRejectedValue(new Error('unreachable'))
    open()
    fireEvent.change(nameBox(), { target: { value: ACCOUNT.name } })
    fireEvent.change(purposeBox(), { target: { value: ACCOUNT.description } })
    await act(async () => { fireEvent.click(createButton()) })
    await waitFor(() => expect(screen.getByText(/The Directory could not be read/)).toBeTruthy())
    expect(screen.getByLabelText('Broker address').value).toBe('')
  })

  it('keeps the form as typed when the account could not be created', async () => {
    api.createBrokerSubscriber.mockRejectedValue(new Error('The broker credential service could not create it. Nothing was changed; retry.'))
    const handlers = open()
    fireEvent.change(nameBox(), { target: { value: ACCOUNT.name } })
    fireEvent.change(purposeBox(), { target: { value: ACCOUNT.description } })
    await act(async () => { fireEvent.click(createButton()) })
    await waitFor(() => expect(screen.getByText(/could not create it/)).toBeTruthy())
    expect(nameBox().value).toBe(ACCOUNT.name)
    expect(handlers.onCreated).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('shows the password and says the record was not written when it was not', async () => {
    api.createBrokerSubscriber.mockResolvedValue({ ...ACCOUNT, audit_recorded: false })
    const handlers = await create(open())
    expect(screen.getByText(/the Audit Trail entry could not be written/)).toBeTruthy()
    expect(handlers.showToast).toHaveBeenCalledWith(expect.stringMatching(/Audit Trail entry could not be written/), 'error')
  })
})
