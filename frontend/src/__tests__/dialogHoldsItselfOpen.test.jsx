import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../components/common/Modal'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { BrokerSubscriberModal } from '../components/modals/BrokerSubscriberModal'
import { EntityLinksModal } from '../components/modals/EntityLinksModal'
import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { GatewayCredentialModal } from '../components/modals/GatewayCredentialModal'
import { ServicePrincipalCreateModal } from '../components/modals/ServicePrincipalCreateModal'
import { ServicePrincipalRevocationModal } from '../components/modals/ServicePrincipalRevocationModal'
import { ServiceTokenModal } from '../components/modals/ServiceTokenModal'
import { ShowGatewayCredentialModal } from '../components/modals/ShowGatewayCredentialModal'
import { TelemetryExportModal } from '../components/modals/TelemetryExportModal'
import { AreasTab } from '../components/tabs/AreasTab'
import { api } from '../api'

/**
 * A dialog whose work is running stays open: Escape, the close button, the dismiss button, a close
 * request from the browser and the backdrop do nothing until it ends. `Modal` holds it, by `busy`.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(), createBrokerSubscriber: vi.fn(), downloadGatewayBundle: vi.fn(),
      mintGatewayCredential: vi.fn(), createServicePrincipal: vi.fn(), revokeServicePrincipal: vi.fn(),
      mintServiceToken: vi.fn(), showGatewayCredential: vi.fn(), exportTelemetry: vi.fn()
    }
  }
})

const never = () => new Promise(() => {})

beforeEach(() => {
  vi.clearAllMocks()
  for (const fn of Object.values(api)) fn.mockImplementation(never)
})

/** Each way out of a dialog but its acts. */
const tryToClose = (dialog) => {
  fireEvent.keyDown(document, { key: 'Escape' })
  for (const way of within(dialog).getAllByRole('button', { name: /^(Close|Cancel)$/ })) fireEvent.click(way)
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  fireEvent.click(dialog)
}

describe('Modal', () => {
  const show = (props) => {
    const onClose = vi.fn()
    const { rerender } = render(<Modal title="T" onClose={onClose} {...props}>Body</Modal>)
    return { onClose, again: (next) => rerender(<Modal title="T" onClose={onClose} {...props} {...next}>Body</Modal>), dialog: screen.getByRole('dialog') }
  }

  it('does nothing on any way out while it is busy, and greys the two buttons', () => {
    const { onClose, again, dialog } = show({ busy: true, dismiss: 'Cancel', closeOnOverlay: true })
    tryToClose(dialog)
    expect(onClose).not.toHaveBeenCalled()
    for (const name of ['Close', 'Cancel']) {
      expect(within(dialog).getByRole('button', { name })).toBeDisabled()
      expect(within(dialog).getByRole('button', { name })).toHaveClass('btn-disabled')
    }

    again({ busy: false })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(5)
  })

  it('keeps Escape from the dialog beneath while it is busy', () => {
    const beneath = vi.fn()
    render(<>
      <Modal title="Beneath" onClose={beneath} />
      <Modal title="Above" busy onClose={vi.fn()} />
    </>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(beneath).not.toHaveBeenCalled()
  })

  it.each(['Cancel', 'Close'])('draws %s as a ghost button before its acts', (dismiss) => {
    show({ dismiss, footer: <button className="btn btn-primary">Save Area</button> })
    const buttons = [...document.querySelectorAll('.modal-actions button')]
    expect(buttons.map(b => b.textContent)).toEqual([dismiss, 'Save Area'])
    expect(buttons[0]).toHaveClass('btn', 'btn-ghost')
    expect(buttons[0]).toHaveAttribute('type', 'button')
  })

  it('draws Done as the primary, after its acts', () => {
    show({ dismiss: 'Done', footer: <button className="btn btn-ghost">Re-issue Command</button> })
    const buttons = [...document.querySelectorAll('.modal-actions button')]
    expect(buttons.map(b => b.textContent)).toEqual(['Re-issue Command', 'Done'])
    expect(buttons[1]).toHaveClass('btn', 'btn-primary')
  })

  it('draws no row of buttons for a viewer', () => {
    show({})
    expect(document.querySelector('.modal-actions')).toBeNull()
  })
})

const GATEWAY = { gateway_id: 'g-1', gateway_name: 'Host Connector 2', sparkplug_id: 'gwy1', deployment: 'host' }
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const typed = () => change(`Type ${GATEWAY.gateway_name} to confirm`, GATEWAY.gateway_name)

/** Each dialog with its act started and never ending: what to fill in, what to press, and what it sends. */
const DIALOGS = [
  ['ConfirmModal', (close) => <ConfirmModal title="Delete capture" message="?" confirmLabel="Delete Capture" onConfirm={never} onCancel={close} />, null, 'Delete Capture'],
  ['BrokerSubscriberModal', (close) => <BrokerSubscriberModal onClose={close} />, () => { change('Name', 'Board'); change('What It Is For', 'OEE') }, 'Create Read-Only Account'],
  ['GatewayCredentialModal', (close) => <GatewayCredentialModal gateway={GATEWAY} onClose={close} />, typed, /Issue Credential/],
  ['GatewayCredentialModal, issuing as it opens', (close) => <GatewayCredentialModal gateway={GATEWAY} onClose={close} confirmFirst={false} />, null, null],
  ['GatewayBundleModal', (close) => <GatewayBundleModal gateway={GATEWAY} onClose={close} confirmFirst />, typed, /Issue & Download/],
  ['GatewayBundleModal, issuing as it opens', (close) => <GatewayBundleModal gateway={GATEWAY} onClose={close} />, null, null],
  ['ShowGatewayCredentialModal', (close) => <ShowGatewayCredentialModal gateway={GATEWAY} onClose={close} />, null, /Show Credential/],
  ['ServicePrincipalCreateModal', (close) => <ServicePrincipalCreateModal onClose={close} />, () => change('Name', 'Reports'), 'Create Machine Identity'],
  ['ServicePrincipalRevocationModal', (close) => <ServicePrincipalRevocationModal principal={{ principal_id: 'p' }} principalName="Reports" onClose={close} />, null, 'Withdraw Identity'],
  ['ServiceTokenModal', (close) => <ServiceTokenModal principal={{ principal_id: 'p' }} principalName="Reports" onClose={close} />, null, /Issue Token/],
  ['TelemetryExportModal', (close) => (
    <TelemetryExportModal devices={[{ id: 'd', name: 'Press' }]} metricNames={['LOAD']} from="2026-11-24T10:00:00.000Z" to="2026-11-24T11:00:00.000Z"
      windowWords="Last hour" onClose={close} showToast={vi.fn()} />
  ), null, /Export CSV/],
]

describe('a dialog whose work is running', () => {
  it.each(DIALOGS)('%s stays open', async (_, show, fill, press) => {
    const onClose = vi.fn()
    render(show(onClose))
    const dialog = screen.getByRole('dialog')
    fill?.()
    if (press) await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: press })) })
    // The act is under way: its button says so, or the dialog started it as it opened.
    if (press) expect(dialog.querySelector('.btn-loading')).toBeTruthy()
    tryToClose(dialog)
    expect(onClose).not.toHaveBeenCalled()
    for (const way of within(dialog).getAllByRole('button', { name: /^(Close|Cancel)$/ })) expect(way).toBeDisabled()
  })

  it('a link being saved keeps its dialog open, whose Close loses nothing otherwise', async () => {
    api.get.mockResolvedValue([])
    const onClose = vi.fn()
    render(<EntityLinksModal entityType="device" entityId="d" entityName="Press" onClose={onClose} showToast={vi.fn()} hasPermission={() => true} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: /Add Link/ }))
    change('Display Name', 'Manual')
    change(/^Link URL/, 'https://example.com')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save Link' })) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it("an asset's form stays open while it is saved", async () => {
    api.get.mockResolvedValue([])
    render(<AreasTab showToast={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(await screen.findByRole('button', { name: /New Area/ }))
    const dialog = screen.getByRole('dialog', { name: 'New Area' })
    change('Area Name', 'Machine Shop')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save Area' })) })
    expect(api.post).toHaveBeenCalledTimes(1)
    tryToClose(dialog)
    expect(screen.getByRole('dialog', { name: 'New Area' })).toBeInTheDocument()
  })
})
