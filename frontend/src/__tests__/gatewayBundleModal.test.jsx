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

const FILENAME = 'acs-gateway-Cell-4-Press-Line-gwy2a0000000000400080000.zip'
const FOLDER = FILENAME.replace(/\.zip$/, '')

/** A blob URL and an anchor click are the download mechanism; both are stubbed so nothing navigates. */
let clicked
let written
beforeEach(() => {
  vi.clearAllMocks()
  clicked = []
  written = []
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn()
  })
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) }
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
  filename: FILENAME,
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  bundleVersion: '1.0.0',
  sparkplugId: GATEWAY.sparkplug_id,
  ...overrides
})

/** Every ready-state assertion waits on this, so no test races the auto-download. */
const ready = () => waitFor(() => expect(screen.getByText(/On the appliance/i)).toBeTruthy())

describe('GatewayBundleModal — single-dialog lifecycle', () => {
  /**
   * ONE SCREEN, NOT TWO. Both entry points into this modal are already an explicit request for a
   * bundle -- saving a gateway with "Virtual" unchecked, or the drawer's "Download Setup Bundle"
   * action -- so a first screen asking whether you want the thing you just asked for is a step to
   * click through rather than a safeguard.
   */
  it('downloads on open, with no intermediate confirm step', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { showToast } = renderModal()

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledWith(GATEWAY.gateway_id))
    await ready()

    // The old two-step affordance must be gone, not merely bypassed.
    expect(screen.queryByRole('button', { name: /^Download bundle$/i })).toBeNull()
    // The FILENAME COMES FROM THE HEADER, not composed here -- the server already slugged the
    // gateway's name and knows the folder inside the archive matches.
    expect(clicked).toContain(FILENAME)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Bundle downloaded'), 'success')
  })

  /**
   * Minting consumes any live token, so a double-invoked effect would issue two bundles and leave
   * the modal showing a token that had already invalidated the file the browser just saved.
   */
  it('mints exactly once per mount', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()
    await new Promise(r => setTimeout(r, 50))
    expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(1)
  })

  it('reports the download in place while it is running', async () => {
    let resolve
    api.downloadGatewayBundle.mockReturnValue(new Promise(r => { resolve = r }))
    renderModal()

    expect(screen.getByText(/Generating a bundle and starting the download/i)).toBeTruthy()
    resolve(bundleResponse())
    await ready()
    expect(screen.queryByText(/Generating a bundle/i)).toBeNull()
  })

  it('shows the three appliance commands, with the unpacked folder name', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    const block = screen.getByText(new RegExp(`cd ${FOLDER}`))
    expect(block.textContent).toContain('docker compose up -d --build')
    expect(block.textContent).toContain('docker compose logs bootstrap')
  })

  it('counts the token down while it is live', async () => {
    api.downloadGatewayBundle.mockResolvedValue(
      bundleResponse({ expiresAt: new Date(Date.now() + 90_000).toISOString() })
    )
    renderModal()
    // A TOLERANT PATTERN: the countdown is computed from Date.now() at render, so pinning the exact
    // second fails on a slow machine and proves nothing on a fast one.
    await waitFor(() => expect(screen.getByText(/Valid for \d+:\d\d/)).toBeTruthy())
    expect(screen.queryByText(/has expired/i)).toBeNull()
  })

  /**
   * THE PRICE OF AUTO-DOWNLOADING, said out loud. Opening this modal invalidates any bundle already
   * in transit, and an appliance started with the stale one fails at enroll-gateway with a 401 that
   * deliberately cannot say why. This banner is the only place that fact reaches the operator while
   * they still know which bundle is which.
   */
  it('warns that any earlier download has stopped working', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()
    expect(screen.getByText(/any earlier download has stopped working/i)).toBeTruthy()
  })

  it('says so plainly once the token has expired, and offers a re-issue', async () => {
    api.downloadGatewayBundle.mockResolvedValue(
      bundleResponse({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
    )
    renderModal()

    await waitFor(() => expect(screen.getByText(/This bundle has expired/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Re-issue Bundle/i })).toBeTruthy()
    expect(screen.queryByText(/Valid for/)).toBeNull()
  })
})

describe('GatewayBundleModal — Copy Commands', () => {
  it('copies all three commands as one block', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Copy Commands/i }))

    await waitFor(() => expect(written).toHaveLength(1))
    // EXACTLY what the block shows -- one source for both, or an operator pastes commands that do
    // not match the folder named a line above them.
    expect(written[0]).toBe(
      `cd ${FOLDER}\ndocker compose up -d --build\ndocker compose logs bootstrap`
    )
  })

  it('confirms the copy on the button itself', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Copy Commands/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/i })).toBeTruthy())
  })

  /**
   * navigator.clipboard is undefined outside a secure context, and this dashboard is served over
   * plain HTTP -- so it is present on localhost and absent for anyone reaching the app by IP across
   * the plant, which is how most operators will. A silent no-op there is worse than an error.
   */
  it('reports a failure rather than silently doing nothing', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    vi.stubGlobal('navigator', {})           // no clipboard API at all
    document.execCommand = vi.fn(() => false) // and the fallback refuses too
    const { showToast } = renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Copy Commands/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Copy failed/i })).toBeTruthy())
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('clipboard'), 'error')
  })
})

describe('GatewayBundleModal — footer actions', () => {
  it('Done closes without minting anything further', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { onClose } = renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /^Done$/i }))
    expect(onClose).toHaveBeenCalled()
    expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(1)
  })

  it('Re-issue Bundle mints again and downloads a fresh archive', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Re-issue Bundle/i }))

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(clicked).toHaveLength(2))
  })
})

describe('GatewayBundleModal — failure on open', () => {
  it('surfaces the server-s reason, and offers a retry rather than a dead dialog', async () => {
    // What an Operator or Auditor gets. The message has to reach the screen: a silent modal is
    // indistinguishable from a broken feature.
    api.downloadGatewayBundle.mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    const { showToast } = renderModal()

    await waitFor(() => expect(screen.getByText(/Forbidden: Insufficient privileges/)).toBeTruthy())
    expect(showToast).toHaveBeenCalledWith('Forbidden: Insufficient privileges', 'error')
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy()
    // Nothing was handed to the browser to save, and no instructions are shown for a bundle that
    // does not exist.
    expect(clicked).toHaveLength(0)
    expect(screen.queryByText(/On the appliance/i)).toBeNull()
  })

  it('recovers when the retry succeeds', async () => {
    api.downloadGatewayBundle
      .mockRejectedValueOnce(new Error('Enrolment is temporarily unavailable'))
      .mockResolvedValueOnce(bundleResponse())
    renderModal()

    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }))

    await ready()
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull()
    expect(clicked).toContain(FILENAME)
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
