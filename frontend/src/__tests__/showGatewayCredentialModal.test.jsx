import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShowGatewayCredentialModal } from '../components/modals/ShowGatewayCredentialModal'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { showGatewayCredential: vi.fn() } }
})

const GATEWAY = { gateway_id: 'gw-1', gateway_name: 'Host_Gateway_NodeRED' }
const KEPT = { mqtt_username: 'gwy100000000000400080000', password: 'kept-password', issued_at: '2026-10-06T12:00:00Z' }

const renderModal = () =>
  render(<ShowGatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={vi.fn()} />)

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

  it('says what to do when no copy is kept', async () => {
    api.showGatewayCredential.mockRejectedValue(new Error(
      "no copy of gateway Host_Gateway_NodeRED's credential is kept; issue a new one to be able to show it again"))
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Show Credential/i }))

    await waitFor(() => expect(screen.getByText(/issue a new one/i)).toBeInTheDocument())
    expect(screen.queryByText(/Use it in Node-RED/i)).toBeNull()
  })
})
