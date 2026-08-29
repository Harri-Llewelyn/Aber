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
   * THE CONFIRMATION IS UNCONDITIONAL, which is the one place this deliberately differs from
   * GatewayBundleModal. That modal skips its confirm step straight after creating a gateway,
   * where there is provably nothing to destroy. Minting always REPLACES -- the broker holds one
   * password per username -- so there is no equivalent safe moment, and a regression that added
   * one would be invisible until it took a running connector offline.
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

  /**
   * The .env block has to agree with the fields shown above it. Two literals drift, and the
   * failure is an operator pasting lines that disagree with what is on screen.
   */
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
   * A PLAYBACK GATEWAY'S PASSWORD GOES SOMEWHERE ELSE ENTIRELY (0060). It has no Node-RED broker
   * node, so the `acsCredentialsEnv` pairing is advice that cannot be followed -- and the operator
   * only finds that out after the one dialog that will ever show the password has closed.
   *
   * The playback worker reads ONE variable keyed by sparkplug_id, and that key IS derivable, so
   * this block is pasteable whole rather than carrying a placeholder.
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
   * A FAILED MINT MUST NOT ADVANCE THE STEP. Nothing was issued, so whatever credential the
   * gateway had is still valid -- and dropping the operator onto an empty reveal screen would
   * imply a password existed that they failed to catch.
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
   * and the record of it does not, which is the operator's to escalate rather than ours to hide.
   */
  it('surfaces a mint whose audit row could not be written', async () => {
    api.mintGatewayCredential.mockResolvedValue({ ...CREDENTIAL, audit_recorded: false })
    const { showToast } = renderModal()
    await confirmAndMint()

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Digital Thread'), 'error')
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
