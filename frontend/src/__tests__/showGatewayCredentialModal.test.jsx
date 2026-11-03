import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShowGatewayCredentialModal } from '../components/modals/ShowGatewayCredentialModal'
import { api } from '../api'
import { gatewayUrl } from '../routes'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { showGatewayCredential: vi.fn() } }
})

const GATEWAY = { gateway_id: 'gw-1', gateway_name: 'Host_Gateway_NodeRED' }
const KEPT = { mqtt_username: 'gwy100000000000400080000', password: 'kept-password', issued_at: '2026-10-06T12:00:00Z' }

const renderModal = (showToast = vi.fn()) =>
  render(<ShowGatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={showToast} />)

beforeEach(() => vi.clearAllMocks())

describe('ShowGatewayCredentialModal', () => {
  /** Each showing is an Audit Trail row, so opening the dialog must not be one. */
  it('fetches nothing until it is asked, and says the showing is recorded', () => {
    renderModal()
    expect(api.showGatewayCredential).not.toHaveBeenCalled()
    expect(screen.getByText(/recorded in the Audit Trail under your name/i)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(KEPT.password)).toBeNull()
  })

  it('shows the kept username and password, and where they go in Node-RED', async () => {
    api.showGatewayCredential.mockResolvedValue(KEPT)
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/i }))

    await waitFor(() => expect(screen.getByDisplayValue(KEPT.password)).toBeInTheDocument())
    expect(screen.getByDisplayValue(KEPT.mqtt_username)).toBeInTheDocument()
    expect(api.showGatewayCredential).toHaveBeenCalledWith('gw-1')
    expect(screen.getByText(/Use it in Node-RED/i)).toBeInTheDocument()
    expect(screen.getByText('Security')).toBeInTheDocument()
  })

  /** The showing is a CREDENTIAL_SHOWN row, so it ends with a toast, as issuing one does. */
  it('says the credential was shown, naming the gateway and linking to it', async () => {
    api.showGatewayCredential.mockResolvedValue(KEPT)
    const showToast = vi.fn()
    renderModal(showToast)
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/i }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Broker credential shown for 'Host_Gateway_NodeRED'", 'success', { to: gatewayUrl('gw-1') }))
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('says what to do when no copy is kept', async () => {
    api.showGatewayCredential.mockRejectedValue(new Error(
      "no copy of gateway Host_Gateway_NodeRED's credential is kept; issue a new one to be able to show it again"))
    const showToast = vi.fn()
    renderModal(showToast)
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/i }))

    await waitFor(() => expect(screen.getByText(/issue a new one/i)).toBeInTheDocument())
    expect(screen.queryByText(/Use it in Node-RED/i)).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  })
})
