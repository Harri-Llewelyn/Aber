import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GatewayCredentialModal } from '../components/modals/GatewayCredentialModal'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { mintGatewayCredential: vi.fn() }
}))

const GATEWAY = {
  gateway_id: '4a000000-0000-4000-8000-000000000001',
  gateway_name: 'Host Connector 2',
  sparkplug_id: 'gwy4a0000000000400080000'
}

const CREDENTIAL = {
  gateway_name: GATEWAY.gateway_name,
  sparkplug_id: GATEWAY.sparkplug_id,
  mqtt_username: GATEWAY.sparkplug_id,
  password: 'IIUitgPky5GeOZJVPTZYO_6yqToDEUrX',
  applied_to_running_broker: true,
  audit_recorded: true
}

let written
beforeEach(() => {
  vi.clearAllMocks()
  written = []
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const renderModal = () => {
  const showToast = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <GatewayCredentialModal gateway={GATEWAY} onClose={onClose} showToast={showToast} />
  )
  return { ...utils, showToast, onClose }
}

const confirmAndMint = async () => {
  fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), {
    target: { value: GATEWAY.gateway_name }
  })
  fireEvent.click(screen.getByText(/Issue Credential/i))
  await waitFor(() => expect(api.mintGatewayCredential).toHaveBeenCalled())
}

describe('GatewayCredentialModal', () => {
  /**
   * The confirmation is unconditional, unlike GatewayBundleModal, which skips its confirm step
   * straight after creating a gateway. Minting always replaces, since the broker holds one password
   * per username, so there is no safe moment.
   */
  it('opens on the confirmation step and mints nothing until the name matches', () => {
    renderModal()
    expect(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`)).toBeTruthy()
    expect(api.mintGatewayCredential).not.toHaveBeenCalled()
  })

  it('keeps the issue button disabled until the typed name matches', () => {
    renderModal()
    const button = screen.getByText(/Issue Credential/i).closest('button')
    expect(button.className).toContain('btn-disabled')

    fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), {
      target: { value: 'Host Connector' }
    })
    expect(button.className).toContain('btn-disabled')

    fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), {
      target: { value: '  host connector 2  ' }
    })
    // Case and surrounding space are forgiven: an operator reading the name off the drawer should
    // not be defeated by the label's capitalisation.
    expect(button.className).not.toContain('btn-disabled')

    // Inner runs of whitespace collapse too, as in GatewayBundleModal.
    fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), {
      target: { value: 'Host   Connector  2' }
    })
    expect(button.className).not.toContain('btn-disabled')
  })

  it('reveals the username and password once the mint succeeds', async () => {
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    renderModal()
    await confirmAndMint()

    await waitFor(() => {
      expect(screen.getByDisplayValue(CREDENTIAL.password)).toBeTruthy()
    })
    expect(screen.getAllByDisplayValue(CREDENTIAL.mqtt_username).length).toBeGreaterThan(0)
    expect(api.mintGatewayCredential).toHaveBeenCalledWith(GATEWAY.gateway_id)
  })

  /**
   * A host-run gateway's credential is typed on its broker node's Security tab, where Node-RED
   * keeps it. The editor drops a property a node type does not declare, so the dialog must not
   * send anyone to aberCredentialsEnv or a Secret.
   */
  it('tells a host-run gateway to enter the credential on its broker node in Node-RED', async () => {
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    renderModal()
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/Use it in Node-RED/i)).toBeTruthy())
    expect(screen.getByText('Security')).toBeInTheDocument()
    expect(screen.getByText('mqtt-broker')).toBeInTheDocument()
    expect(screen.getByText('mosquitto')).toBeInTheDocument()
    expect(screen.queryByText(/Copy block/i)).toBeNull()
    expect(screen.queryAllByText(/aberCredentialsEnv/)).toHaveLength(0)
    expect(screen.queryAllByText(/release Secret/i)).toHaveLength(0)
  })

  /**
   * A playback gateway's password goes to the playback worker, not Node-RED: it has no broker node,
   * and the worker reads one object keyed by sparkplug_id, so the block is pasteable whole.
   */
  it('points a playback gateway at the playback worker, not at Node-RED', async () => {
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    render(<GatewayCredentialModal gateway={{ ...GATEWAY, is_shadow: true }}
      onClose={vi.fn()} showToast={vi.fn()} />)
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/For secrets\.mqttPlaybackCredentials/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Copy block/i))

    await waitFor(() => expect(written.length).toBe(1))
    expect(written[0]).toBe(`{"${CREDENTIAL.mqtt_username}":"${CREDENTIAL.password}"}`)
    // No placeholder to substitute, and no mention of a flow it does not appear in.
    expect(written[0]).not.toContain('<NAME>')
    expect(screen.queryAllByText(/aberCredentialsEnv/)).toHaveLength(0)
    expect(screen.queryAllByText(/Node-RED/)).toHaveLength(0)
    // The chart's checksum on the value rolls the worker, so the upgrade is the whole step.
    expect(screen.getByText(/The upgrade restarts the playback worker/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/kubectl/)
  })

  describe('a delivered Playback gateway credential', () => {
    const PLAYBACK = { ...GATEWAY, is_shadow: true }
    const mintDelivered = async () => {
      api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, playback_delivered: true })
      render(<GatewayCredentialModal gateway={PLAYBACK} onClose={vi.fn()} showToast={vi.fn()} />)
      await confirmAndMint()
    }
    afterEach(() => { delete globalThis.__ABER_CONFIG__ })

    it('says it was delivered and that nothing more is needed', async () => {
      await mintDelivered()
      expect(await screen.findByText(/Delivered to the playback worker/)).toBeInTheDocument()
      expect(screen.getByText(/Nothing further to do/)).toBeInTheDocument()
    })

    /** playback.enabled off: the Secret holds the password, and no worker reads it. */
    it('does not claim delivery when the worker is not deployed, and names the setting', async () => {
      globalThis.__ABER_CONFIG__ = { VITE_PLAYBACK_ENABLED: 'false' }
      await mintDelivered()
      expect(await screen.findByText(/Saved for the playback worker/)).toBeInTheDocument()
      expect(screen.getByText('playback.enabled: true')).toBeInTheDocument()
      expect(screen.queryByText(/Delivered to the playback worker/)).toBeNull()
      expect(screen.queryByText(/Nothing further to do/)).toBeNull()
    })
  })

  /**
   * Decided by the gateway, not by what the server delivered. A server from before 0183 delivered
   * every Simulated gateway's password too; the dialog then hid the Node-RED steps and said there
   * was nothing to do, while re-issuing had just disconnected the running simulator.
   */
  describe('a Simulated gateway', () => {
    const SIMULATED = { ...GATEWAY, gateway_name: 'Line Simulator', is_simulated: true, is_shadow: false }
    const mint = async (credential) => {
      api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, ...credential })
      render(<GatewayCredentialModal gateway={SIMULATED} onClose={vi.fn()} showToast={vi.fn()} />)
      fireEvent.change(screen.getByLabelText(`Type ${SIMULATED.gateway_name} to confirm`), {
        target: { value: SIMULATED.gateway_name }
      })
      fireEvent.click(screen.getByText(/Issue Credential/i))
      await waitFor(() => expect(api.mintGatewayCredential).toHaveBeenCalled())
    }

    it.each([
      ['not delivered', { playback_delivered: null }],
      ['delivered by an older server', { playback_delivered: true }],
      ['a failed delivery', { playback_delivered: false }]
    ])('shows the Node-RED steps and the copy callout when %s', async (_, credential) => {
      await mint({ ...credential, credential_kept: true })
      expect(await screen.findByText(/Use it in Node-RED/i)).toBeInTheDocument()
      expect(screen.getByText(/Copy this into Node-RED now/i)).toBeInTheDocument()
      expect(screen.queryByText(/Delivered to the playback worker/)).toBeNull()
      expect(screen.queryByText(/Nothing further to do/)).toBeNull()
      expect(screen.queryByText(/For secrets\.mqttPlaybackCredentials/)).toBeNull()
    })
  })

  it('gives the Playback gateway the Helm value when its password was not delivered', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, playback_delivered: null })
    render(<GatewayCredentialModal gateway={{ ...GATEWAY, is_shadow: true }}
      onClose={vi.fn()} showToast={vi.fn()} />)
    await confirmAndMint()
    expect(await screen.findByText(/For secrets\.mqttPlaybackCredentials/)).toBeInTheDocument()
    expect(screen.queryByText(/Use it in Node-RED/i)).toBeNull()
    expect(screen.queryByText(/Automatic delivery to the playback worker failed/)).toBeNull()
  })

  it('adds the worker setting to the fallback when delivery failed and the worker is not deployed', async () => {
    globalThis.__ABER_CONFIG__ = { VITE_PLAYBACK_ENABLED: 'false' }
    try {
      api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, playback_delivered: false })
      render(<GatewayCredentialModal gateway={{ ...GATEWAY, is_shadow: true }}
        onClose={vi.fn()} showToast={vi.fn()} />)
      await confirmAndMint()
      expect(await screen.findByText(/Automatic delivery to the playback worker failed/)).toBeInTheDocument()
      expect(screen.getByText('playback.enabled: true')).toBeInTheDocument()
    } finally {
      delete globalThis.__ABER_CONFIG__
    }
  })

  /**
   * A failed mint must not advance the step: nothing was issued, so the gateway's existing
   * credential is still valid.
   */
  it('stays on the confirmation step when the mint is refused', async () => {
    api.mintGatewayCredential.mockRejectedValue(
      new Error('gateway Host Connector 2 is archived; restore it before minting a credential')
    )
    const { showToast } = renderModal()
    await confirmAndMint()

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('archived'), 'error'))
    expect(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`)).toBeTruthy()
    expect(screen.queryByText(/Copy block/i)).toBeNull()
  })

  /**
   * An unrecorded mint is the one successful outcome that still needs saying: the account exists
   * and the record of it does not.
   */
  it('surfaces a mint whose audit row could not be written', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, audit_recorded: false })
    const { showToast } = renderModal()
    await confirmAndMint()

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Audit Trail'), 'error')
    })
    // And the password is still shown -- the account exists, and withholding it would strand one
    // nobody can ever authenticate as.
    expect(screen.getByDisplayValue(CREDENTIAL.password)).toBeTruthy()
  })
})

/**
 * Whether the password can be shown again is the server's answer (credential_kept, 0164), so the
 * dialog's warning follows it rather than the gateway type.
 */
describe('what the dialog says about seeing the password again', () => {
  it('says an Administrator can show it again before it is issued', () => {
    renderModal()
    expect(screen.getByText(/An Administrator can show the password again later/i)).toBeInTheDocument()
    expect(screen.queryByText(/cannot be recovered/i)).toBeNull()
  })

  it('points at Show Broker Credential when the server kept a copy', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, credential_kept: true })
    renderModal()
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/Copy this into Node-RED now/i)).toBeInTheDocument())
    expect(screen.getByText('Show Broker Credential')).toBeInTheDocument()
    expect(screen.queryByText(/it is not shown again/i)).toBeNull()
  })

  it('warns that it is not shown again when no copy was kept', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, credential_kept: false })
    renderModal()
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/it is not shown again/i)).toBeInTheDocument())
    expect(screen.queryByText('Show Broker Credential')).toBeNull()
  })
})
