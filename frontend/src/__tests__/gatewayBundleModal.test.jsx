import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { StatusBadge } from '../components/common/StatusBadge'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { downloadGatewayBundle: vi.fn() }
}))

const GATEWAY = {
  gateway_id: '2a000000-0000-4000-8000-000000000001',
  gateway_name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000'
}

/** A blob URL and an anchor click are the download mechanism; both are stubbed so nothing navigates. */
let clicked
beforeEach(() => {
  vi.clearAllMocks()
  clicked = []
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn()
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    clicked.push(this.download)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const renderModal = (props = {}) => {
  const showToast = vi.fn()
  const onClose = vi.fn()
  render(<GatewayBundleModal gateway={GATEWAY} onClose={onClose} showToast={showToast} {...props} />)
  return { showToast, onClose }
}

const bundleResponse = (overrides = {}) => ({
  blob: new Blob(['PK'], { type: 'application/zip' }),
  filename: 'acs-gateway-Cell-4-Press-Line-gwy2a0000000000400080000.zip',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  bundleVersion: '1.0.0',
  sparkplugId: GATEWAY.sparkplug_id,
  ...overrides
})

describe('GatewayBundleModal', () => {
  /**
   * THE PROPERTY THAT MATTERS MOST HERE. Re-issuing invalidates the previous bundle, so a modal that
   * generated on mount would silently kill a bundle a colleague was carrying to a machine every time
   * somebody clicked in to look at it.
   */
  it('mints nothing until the operator asks', () => {
    renderModal()
    expect(api.downloadGatewayBundle).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Download bundle/i })).toBeTruthy()
  })

  it('downloads on request and names the file from the server', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { showToast } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledWith(GATEWAY.gateway_id))
    // The FILENAME COMES FROM THE HEADER, not composed here -- the server already slugged the
    // gateway's name and knows the folder inside the archive matches.
    await waitFor(() => expect(clicked).toContain(
      'acs-gateway-Cell-4-Press-Line-gwy2a0000000000400080000.zip'
    ))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Bundle downloaded'), 'success')
  })

  it('shows the two commands the operator has to run, with the unpacked folder name', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))

    await waitFor(() => expect(screen.getByText(/docker compose up -d --build/)).toBeTruthy())
    expect(screen.getByText(/docker compose logs bootstrap/)).toBeTruthy()
    // Derived from the download name, so it is the directory that actually appears after unzipping.
    expect(screen.getByText(/cd acs-gateway-Cell-4-Press-Line-gwy2a0000000000400080000/)).toBeTruthy()
  })

  it('counts the token down while it is live', async () => {
    api.downloadGatewayBundle.mockResolvedValue(
      bundleResponse({ expiresAt: new Date(Date.now() + 90_000).toISOString() })
    )
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))

    // A TOLERANT PATTERN. The countdown is computed from Date.now() at render, so a 90-second token
    // reads 1:30 or 1:29 depending on how long the mocked download took -- pinning the exact second
    // makes this test fail on a slow machine and prove nothing on a fast one.
    await waitFor(() => expect(screen.getByText(/Valid for \d+:\d\d/)).toBeTruthy())
    expect(screen.queryByText(/has expired/i)).toBeNull()
  })

  /**
   * An expired bundle fails at the appliance with a 401 whose message deliberately cannot say WHY
   * (unknown, expired and already-redeemed are indistinguishable, so an enumerator learns nothing).
   * That makes the expiry something this modal has to state while the operator still knows which
   * bundle is which.
   */
  it('says so plainly once the token has expired, and offers a re-issue', async () => {
    api.downloadGatewayBundle.mockResolvedValue(
      bundleResponse({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
    )
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))

    await waitFor(() => expect(screen.getByText(/This bundle has expired/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Re-issue bundle/i })).toBeTruthy()
    expect(screen.queryByText(/Valid for/)).toBeNull()
  })

  it('re-issues on demand, calling the endpoint a second time', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Re-issue/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Re-issue/i }))
    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(2))
  })

  it('surfaces the server-s reason for a refusal rather than a generic failure', async () => {
    // What an Operator or Auditor gets. The message has to reach the screen: a silent modal is
    // indistinguishable from a broken button.
    api.downloadGatewayBundle.mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    const { showToast } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: /Download bundle/i }))

    await waitFor(() => expect(screen.getByText(/Forbidden: Insufficient privileges/)).toBeTruthy())
    expect(showToast).toHaveBeenCalledWith('Forbidden: Insufficient privileges', 'error')
    // And nothing was handed to the browser to save.
    expect(clicked).toHaveLength(0)
  })

  it('tells the operator this is a claim rather than a credential', () => {
    renderModal()
    expect(screen.getByText(/single-use claim, not a password/i)).toBeTruthy()
  })
})

describe('StatusBadge — the enrolment states', () => {
  const classOf = (status) => {
    const { container } = render(<StatusBadge status={status} />)
    return container.querySelector('.badge').className
  }

  /**
   * DISTINCT VARIANTS, not both amber. `badge-warning` means "look at this", and a gateway waiting
   * for somebody to carry a bundle to a machine is an unfinished task rather than a fault.
   */
  it('gives the two pending states their own, different variants', () => {
    expect(classOf('PENDING_ENROLLMENT')).toContain('badge-pending')
    expect(classOf('AWAITING_BIRTH')).toContain('badge-provisioned')
    expect(classOf('PENDING_ENROLLMENT')).not.toContain('badge-warning')
    expect(classOf('AWAITING_BIRTH')).not.toContain('badge-warning')
    expect(classOf('PENDING_ENROLLMENT')).not.toBe(classOf('AWAITING_BIRTH'))
  })

  it('keeps the existing variants intact', () => {
    expect(classOf('ONLINE')).toContain('badge-online')
    expect(classOf('OFFLINE')).toContain('badge-neutral')
    expect(classOf('STALE')).toContain('badge-warning')
  })

  it('labels the pending states in words rather than wire values', () => {
    render(<StatusBadge status="PENDING_ENROLLMENT" />)
    expect(screen.getByText('AWAITING SETUP')).toBeTruthy()
    render(<StatusBadge status="AWAITING_BIRTH" />)
    expect(screen.getByText('ENROLLED — NO DATA YET')).toBeTruthy()
  })

  it('explains each wait in its tooltip, since the two are acted on differently', () => {
    const { container: pending } = render(<StatusBadge status="PENDING_ENROLLMENT" />)
    expect(pending.querySelector('.badge').getAttribute('title')).toMatch(/waiting for the appliance/i)

    const { container: awaiting } = render(<StatusBadge status="AWAITING_BIRTH" />)
    expect(awaiting.querySelector('.badge').getAttribute('title')).toMatch(/has not published/i)
  })

  it('still renders an unrecognised status legibly', () => {
    // gateways.status is free text by design -- an NBIRTH payload can override it -- so the set is
    // genuinely open and must not be treated as an enum here.
    expect(classOf('SOMETHING_NEW')).toContain('badge-warning')
  })
})
