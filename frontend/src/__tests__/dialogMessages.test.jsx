import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntityLinksModal } from '../components/modals/EntityLinksModal'
import { NewPasswordModal } from '../components/modals/NewPasswordModal'
import { GatewayCredentialModal } from '../components/modals/GatewayCredentialModal'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

/**
 * The toasts sit outside every dialog, so while one is open they are drawn beneath it, cannot be
 * pressed, and may not be announced. A message a person must see while a dialog stays open is
 * shown in the dialog.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), mintGatewayCredential: vi.fn() }
  }
})

const CLIPBOARD = 'Could not reach the clipboard — select the value and copy it.'

// No clipboard API (plain HTTP) and a fallback the browser refuses.
let execCommand
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', {})
  execCommand = document.execCommand
  document.execCommand = vi.fn(() => false)
})
afterEach(() => {
  document.execCommand = execCommand
  vi.unstubAllGlobals()
})

const inDialog = (dialogName) => within(screen.getByRole('dialog', { name: dialogName }))

describe('a copy the browser refuses', () => {
  it('is said beside a password shown once', async () => {
    render(<NewPasswordModal email="operator@aber.local" password="pw-shown-once" onClose={vi.fn()} showToast={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy password' })) })
    expect(inDialog(/New password/).getByRole('alert')).toHaveTextContent(CLIPBOARD)
  })

  it("is said in a broker credential's dialog, and cleared by a copy that works", async () => {
    const GATEWAY = { gateway_id: 'g-1', gateway_name: 'Host Connector 2', sparkplug_id: 'gwy1', is_shadow: true }
    api.mintGatewayCredential.mockResolvedValue({
      gateway_name: GATEWAY.gateway_name, sparkplug_id: 'gwy1', mqtt_username: 'gwy1',
      password: 'pw-shown-once', applied_to_running_broker: true, audit_recorded: true
    })
    render(<GatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(`Type ${GATEWAY.gateway_name} to confirm`), { target: { value: GATEWAY.gateway_name } })
    await act(async () => { fireEvent.click(screen.getByText(/Issue Credential/i)) })
    await screen.findByRole('button', { name: 'Copy password' })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy password' })) })
    expect(inDialog(/Broker credential/).getByRole('alert')).toHaveTextContent(CLIPBOARD)

    document.execCommand = vi.fn(() => true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy password' })) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('attached links', () => {
  const show = async () => {
    api.get.mockResolvedValue([{ id: 'link-1', display_name: 'Operating Manual', url: 'https://example.com/manual.pdf', link_tag: 'other' }])
    render(
      <EntityLinksModal
        entityType="device" entityId="dev-1" entityName="Sim_CNC_Mill_01"
        onClose={vi.fn()} showToast={vi.fn()}
        hasPermission={(p) => p === PERMISSION_UUIDS.LINK_MANAGE}
      />
    )
    await waitFor(() => expect(screen.queryByText(/Loading links/)).toBeNull())
  }

  it('says in the dialog that a link needs a name', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /Add Link/i }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^(Attach|Save)/ })) })
    expect(inDialog(/Attached Links/).getByRole('alert')).toHaveTextContent('Link name is required')
  })

  it('says in the dialog that a removal failed, once the confirmation has closed', async () => {
    await show()
    api.delete.mockRejectedValue(new Error('The link could not be removed.'))
    fireEvent.click(screen.getByRole('button', { name: /Remove/i }))
    const confirm = screen.getByRole('dialog', { name: 'Remove link' })
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' })) })

    expect(screen.queryByRole('dialog', { name: 'Remove link' })).toBeNull()
    expect(inDialog(/Attached Links/).getByRole('alert')).toHaveTextContent('The link could not be removed.')
  })
})
