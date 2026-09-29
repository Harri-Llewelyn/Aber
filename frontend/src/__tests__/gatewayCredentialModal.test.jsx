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

  /** The .env block has to agree with the fields shown above it. */
  it('builds the .env block from the same values it displays', async () => {
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    renderModal()
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/For \.env/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Copy block/i))

    await waitFor(() => expect(written.length).toBe(1))
    expect(written[0]).toContain(`MQTT_GW_<NAME>_USER=${CREDENTIAL.mqtt_username}`)
    expect(written[0]).toContain(`MQTT_GW_<NAME>_PASSWORD=${CREDENTIAL.password}`)
    // Twice: the comment inside the block, and the hint under it that says where to find the value.
    expect(screen.getAllByText(/acsCredentialsEnv/).length).toBeGreaterThan(0)
  })

  /**
   * A playback gateway's password goes to the playback worker, not Node-RED: it has no broker node,
   * and the worker reads one variable keyed by sparkplug_id, so the block is pasteable whole.
   */
  it('points a playback gateway at the playback worker, not at Node-RED', async () => {
    api.mintGatewayCredential.mockResolvedValue(CREDENTIAL)
    render(<GatewayCredentialModal gateway={{ ...GATEWAY, is_shadow: true }}
      onClose={vi.fn()} showToast={vi.fn()} />)
    await confirmAndMint()

    await waitFor(() => expect(screen.getByText(/For \.env/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Copy block/i))

    await waitFor(() => expect(written.length).toBe(1))
    expect(written[0]).toContain(
      `MQTT_PLAYBACK_CREDENTIALS={"${CREDENTIAL.mqtt_username}":"${CREDENTIAL.password}"}`)
    // No placeholder to substitute, and no mention of a flow it does not appear in.
    expect(written[0]).not.toContain('<NAME>')
    expect(screen.queryAllByText(/acsCredentialsEnv/)).toHaveLength(0)
    expect(screen.queryAllByText(/Node-RED/)).toHaveLength(0)
    expect(screen.getByText(/restart the playback worker/i)).toBeInTheDocument()
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

  it('warns when the durable write landed but the running broker has not reloaded', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, applied_to_running_broker: false })
    renderModal()
    await confirmAndMint()

    await waitFor(() => {
      expect(screen.getByText(/has not reloaded it yet/i)).toBeTruthy()
    })
  })
})
