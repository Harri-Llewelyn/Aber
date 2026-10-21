import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GatewayCredentialModal } from '../components/modals/GatewayCredentialModal'
import { ShowGatewayCredentialModal } from '../components/modals/ShowGatewayCredentialModal'
import { api } from '../api'
import { BROKER_DIRECTORY_ID } from '../utils/edgeNodeSettings'

/**
 * The credential dialog for a Third-party gateway gives its engineer every setting the edge node
 * is configured with, in one place, each with a copy button, and links the page that says what
 * the node must do. Issuing and showing again say the same thing.
 */

vi.mock('../api', () => ({
  api: { mintGatewayCredential: vi.fn(), showGatewayCredential: vi.fn(), get: vi.fn() }
}))

const GATEWAY = {
  gateway_id: '4c000000-0000-4000-8000-000000000001',
  gateway_name: 'Vendor Node 1',
  sparkplug_id: 'gwy4c0000000000400080000',
  sparkplug_group: 'Plant-A',
  deployment: 'third_party'
}

const CREDENTIAL = {
  gateway_name: GATEWAY.gateway_name,
  sparkplug_id: GATEWAY.sparkplug_id,
  mqtt_username: GATEWAY.sparkplug_id,
  password: 'third-party-password-0123456789ab',
  audit_recorded: true,
  credential_kept: true
}

const DIRECTORY = [
  { service_uuid: BROKER_DIRECTORY_ID, service_type: 'MQTT_BROKER', endpoint_url: 'mqtts://mqtt.plant.example:8883' }
]

let written
beforeEach(() => {
  vi.clearAllMocks()
  written = []
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) }
  })
  globalThis.__ABER_CONFIG__ = { VITE_PRIMARY_HOST_ID: 'plant1' }
  api.get.mockResolvedValue(DIRECTORY)
  api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
})

afterEach(() => {
  delete globalThis.__ABER_CONFIG__
  vi.unstubAllGlobals()
})

const issued = async (props = {}) => {
  render(<GatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={vi.fn()} {...props} />)
  if (props.confirmFirst !== false) {
    fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), {
      target: { value: GATEWAY.gateway_name }
    })
    fireEvent.click(screen.getByText(/Issue Credential/i))
  }
  await waitFor(() => expect(screen.getByDisplayValue(CREDENTIAL.password)).toBeInTheDocument())
  await waitFor(() => expect(screen.getByLabelText('Broker address').value).toBe('mqtt.plant.example'))
}

describe("a Third-party gateway's credential dialog", () => {
  it('warns that the edge node, not Node-RED, loses its connection', () => {
    render(<GatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={vi.fn()} />)
    expect(screen.getByText(/its edge node is using/)).toBeInTheDocument()
    expect(screen.queryByText(/a running Node-RED/)).toBeNull()
  })

  it('shows every setting the node is configured with, in one place', async () => {
    await issued()
    const value = (label) => screen.getByLabelText(label).value
    expect(value('Broker address')).toBe('mqtt.plant.example')
    expect(value('TLS port')).toBe('8883')
    expect(value('Username')).toBe(GATEWAY.sparkplug_id)
    expect(value('Password')).toBe(CREDENTIAL.password)
    expect(value('Edge node ID')).toBe(GATEWAY.sparkplug_id)
    expect(value('Sparkplug group')).toBe('Plant-A')
    expect(value('Primary host ID')).toBe('plant1')
    expect(value('Root certificate')).toMatch(/\/\.well-known\/aber\/ca\.pem$/)
    expect(screen.getByText('Copy these into the edge node now.')).toBeInTheDocument()
    expect(screen.queryByText(/Use it in Node-RED/i)).toBeNull()
  })

  it('gives each value a copy button that copies that value', async () => {
    await issued()
    const copies = [
      ['Copy broker address', 'mqtt.plant.example'],
      ['Copy port', '8883'],
      ['Copy username', GATEWAY.sparkplug_id],
      ['Copy password', CREDENTIAL.password],
      ['Copy edge node ID', GATEWAY.sparkplug_id],
      ['Copy Sparkplug group', 'Plant-A'],
      ['Copy primary host ID', 'plant1'],
    ]
    for (const [name, expected] of copies) {
      fireEvent.click(screen.getByRole('button', { name }))
      await waitFor(() => expect(written.at(-1)).toBe(expected))
    }
    fireEvent.click(screen.getByRole('button', { name: /Copy the root certificate/ }))
    await waitFor(() => expect(written.at(-1)).toMatch(/\/\.well-known\/aber\/ca\.pem$/))
  })

  it('offers the root certificate as a download from the dashboard', async () => {
    await issued()
    const link = screen.getByRole('link', { name: 'Download the root certificate' })
    expect(link.getAttribute('href')).toBe('/.well-known/aber/ca.pem')
    expect(link.hasAttribute('download')).toBe(true)
  })

  it('links the page on bringing your own edge node, for the help panel or GitHub', async () => {
    await issued()
    const link = screen.getByRole('link', { name: /Bringing your own edge node/ })
    expect(link.getAttribute('data-help')).toBe('site/bring-your-own-edge-node')
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/github\.com\/Harri-Llewelyn\/Aber\/blob\/(main|v\d+\.\d+\.\d+)\/help\/site\/bring-your-own-edge-node\.md$/)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('issues at once for a gateway just registered, and only once', async () => {
    await issued({ confirmFirst: false })
    expect(screen.queryByLabelText(`Type ${GATEWAY.gateway_name} to confirm`)).toBeNull()
    expect(api.mintGatewayCredential).toHaveBeenCalledTimes(1)
    expect(api.mintGatewayCredential).toHaveBeenCalledWith(GATEWAY.gateway_id)
  })

  it('offers to try again when issuing at once fails', async () => {
    api.mintGatewayCredential.mockRejectedValueOnce(new Error('The broker credential service is unreachable.'))
    render(<GatewayCredentialModal gateway={GATEWAY} confirmFirst={false} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText(/credential service is unreachable/).length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(screen.getByDisplayValue(CREDENTIAL.password)).toBeInTheDocument())
  })

  it('says when the broker address only resolves inside Aber', async () => {
    api.get.mockResolvedValue([{ ...DIRECTORY[0], endpoint_url: 'mqtt://mosquitto:1883' }])
    render(<GatewayCredentialModal gateway={GATEWAY} confirmFirst={false} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/resolves only inside Aber/)).toBeInTheDocument())
    expect(screen.getByLabelText('Port').value).toBe('1883')
  })

  it('says where the primary host id is set when the dashboard was not given it', async () => {
    delete globalThis.__ABER_CONFIG__
    await issued({ confirmFirst: false })
    expect(screen.getByLabelText('Primary host ID').value).toBe('')
    expect(screen.getByText('ingestion.primaryHostId')).toBeInTheDocument()
  })

  it('says so when the Directory cannot be read, rather than guessing an address', async () => {
    api.get.mockRejectedValue(new Error('permission denied'))
    render(<GatewayCredentialModal gateway={GATEWAY} confirmFirst={false} onClose={vi.fn()} showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/The Directory could not be read/)).toBeInTheDocument())
    expect(screen.getByLabelText('Broker address').value).toBe('')
  })
})

describe("showing a Third-party gateway's credential again", () => {
  it('shows the same settings as the issue', async () => {
    api.showGatewayCredential.mockResolvedValue({ mqtt_username: GATEWAY.sparkplug_id, password: 'kept', issued_at: null })
    render(<ShowGatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/i }))

    await waitFor(() => expect(screen.getByLabelText('Password').value).toBe('kept'))
    await waitFor(() => expect(screen.getByLabelText('Broker address').value).toBe('mqtt.plant.example'))
    expect(screen.getByLabelText('Sparkplug group').value).toBe('Plant-A')
    expect(screen.getByLabelText('Primary host ID').value).toBe('plant1')
    expect(within(document.body).queryByText(/Use it in Node-RED/i)).toBeNull()
    expect(api.showGatewayCredential).toHaveBeenCalledWith(GATEWAY.gateway_id)
  })
})
