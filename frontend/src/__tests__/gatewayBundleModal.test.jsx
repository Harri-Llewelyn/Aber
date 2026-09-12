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

/** The confirm screen's gate, typed exactly as an operator would. */
const typeName = (value = GATEWAY.gateway_name) =>
  fireEvent.change(screen.getByLabelText(/Type .* to confirm/i), { target: { value } })

describe('GatewayBundleModal — straight after creating the gateway', () => {
  /**
   * No confirmation on this route: the gateway is seconds old, so there is no earlier bundle to
   * invalidate, and saving a gateway with "Virtual" unchecked is already an explicit request for a
   * bundle.
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
   * Minting consumes any live token, so a double-invoked effect would issue two bundles and show a
   * token that had already invalidated the file the browser saved.
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
   * The price of auto-downloading, said out loud: opening this modal invalidates any bundle in
   * transit, and an appliance started with the stale one fails at enroll-gateway with a 401 that
   * cannot say why.
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
   * plain HTTP, so it is absent for anyone reaching the app by IP.
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

  /**
   * Re-issuing asks first, even from inside the dialog that just handed over a working bundle: this
   * is the click that destroys it.
   */
  it('Re-issue Bundle asks before minting anything', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Re-issue Bundle/i }))

    expect(screen.getByText(/Issue a new bundle for this gateway/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Issue & Download/i }).disabled).toBe(true)
    expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(1)
  })

  it('mints again and downloads a fresh archive once the name is typed', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Re-issue Bundle/i }))
    typeName()
    fireEvent.click(screen.getByRole('button', { name: /Issue & Download/i }))

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(clicked).toHaveLength(2))
    // And it lands back on the setup screen, not on the question it just answered.
    await ready()
  })

  /**
   * Cancelling a re-issue must not close the dialog: the commands and the countdown cannot be got
   * back without minting again.
   */
  it('Cancel returns to the bundle rather than closing over it', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { onClose } = renderModal()
    await ready()

    fireEvent.click(screen.getByRole('button', { name: /Re-issue Bundle/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))

    await ready()
    expect(screen.getByText(/Valid for \d+:\d\d/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(1)
  })
})

/**
 * The drawer's route in. This gateway may already hold a live token somebody downloaded, or at
 * AWAITING_BIRTH a broker credential an appliance is holding, and issuing destroys whichever it
 * has. Hence a typed name.
 */
describe('GatewayBundleModal — confirm before issuing', () => {
  const renderConfirm = (props = {}) => renderModal({ confirmFirst: true, ...props })

  it('mints nothing on mount, and says what issuing would cost', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    expect(api.downloadGatewayBundle).not.toHaveBeenCalled()
    expect(clicked).toHaveLength(0)
    expect(screen.getByText(/invalidates any bundle/i)).toBeTruthy()
    expect(screen.queryByText(/On the appliance/i)).toBeNull()
  })

  it('holds the action shut until the gateway name is typed', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    const issue = screen.getByRole('button', { name: /Issue & Download/i })
    expect(issue.disabled).toBe(true)

    typeName('Cell 4')                  // a prefix is not the name
    expect(screen.getByRole('button', { name: /Issue & Download/i }).disabled).toBe(true)

    typeName('Cell 5 Press Line')       // nor is a near miss
    expect(screen.getByRole('button', { name: /Issue & Download/i }).disabled).toBe(true)

    typeName()
    expect(screen.getByRole('button', { name: /Issue & Download/i }).disabled).toBe(false)
  })

  /**
   * And it looks shut: the `disabled` attribute changes nothing in this stylesheet, `.btn-disabled`
   * is what greys it.
   */
  it('looks refused while it is refusing', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    expect(screen.getByRole('button', { name: /Issue & Download/i }).className)
      .toContain('btn-disabled')

    typeName()
    expect(screen.getByRole('button', { name: /Issue & Download/i }).className)
      .not.toContain('btn-disabled')
  })

  /** Matched loosely: the gate stops an accidental click, not a determined typist. */
  it('accepts the name with stray case and whitespace', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    typeName('  cell 4   press line  ')
    expect(screen.getByRole('button', { name: /Issue & Download/i }).disabled).toBe(false)
  })

  it('issues and downloads once confirmed, then shows the setup screen', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { showToast } = renderConfirm()

    typeName()
    fireEvent.click(screen.getByRole('button', { name: /Issue & Download/i }))

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledWith(GATEWAY.gateway_id))
    await ready()
    expect(clicked).toContain(FILENAME)
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Bundle downloaded'), 'success')
  })

  it('submits on Enter, so the typed name does not need a second reach for the mouse', async () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    typeName()
    fireEvent.keyDown(screen.getByLabelText(/Type .* to confirm/i), { key: 'Enter' })

    await waitFor(() => expect(api.downloadGatewayBundle).toHaveBeenCalledTimes(1))
  })

  it('ignores Enter while the name is still wrong', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderConfirm()

    typeName('cell')
    fireEvent.keyDown(screen.getByLabelText(/Type .* to confirm/i), { key: 'Enter' })

    expect(api.downloadGatewayBundle).not.toHaveBeenCalled()
  })

  it('Cancel closes when there is no bundle behind the question', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    const { onClose } = renderConfirm()

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))
    expect(onClose).toHaveBeenCalled()
    expect(api.downloadGatewayBundle).not.toHaveBeenCalled()
  })

  /**
   * A failed issue leaves the previous bundle alive, since nothing was minted. Staying on the
   * confirm screen says that.
   */
  it('keeps the operator on the question when the issue fails', async () => {
    api.downloadGatewayBundle.mockRejectedValue(new Error('Enrolment is temporarily unavailable'))
    renderConfirm()

    typeName()
    fireEvent.click(screen.getByRole('button', { name: /Issue & Download/i }))

    await waitFor(() => expect(screen.getByText(/temporarily unavailable/)).toBeTruthy())
    expect(screen.getByText(/invalidates any bundle/i)).toBeTruthy()
    expect(screen.queryByText(/On the appliance/i)).toBeNull()
    expect(clicked).toHaveLength(0)
  })

  /**
   * AWAITING_BIRTH is the worse case and is named as such: the appliance already redeemed its token
   * and is holding a broker credential, which re-issuing revokes.
   */
  it('names the broker credential when the gateway has already enrolled', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal({ confirmFirst: true, gateway: { ...GATEWAY, status: 'AWAITING_BIRTH' } })

    expect(screen.getByText(/revokes the broker credential/i)).toBeTruthy()
  })

  it('says nothing about a credential for a gateway that has never enrolled', () => {
    api.downloadGatewayBundle.mockResolvedValue(bundleResponse())
    renderModal({ confirmFirst: true, gateway: { ...GATEWAY, status: 'PENDING_ENROLLMENT' } })

    expect(screen.queryByText(/revokes the broker credential/i)).toBeNull()
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

  it('offers no retry when the deployment cannot issue a bundle, and says what to set', async () => {
    // A 503 is the deployment, not the request: retrying cannot succeed, and the function already
    // names the variable. The gateway row exists, which the dialog says rather than leaves implied.
    const refusal = new Error('Bundle generation is not configured on this deployment')
    refusal.status = 503
    refusal.details = 'SUPABASE_PUBLIC_URL is unset -- set it to the URL physical gateways reach the platform on, in .env on Compose. No enrolment token was minted.'
    api.downloadGatewayBundle.mockRejectedValue(refusal)
    renderModal()

    await waitFor(() => expect(screen.getByText(/not configured on this deployment/)).toBeTruthy())
    expect(screen.getByText(/SUPABASE_PUBLIC_URL is unset/)).toBeTruthy()
    expect(screen.getByText(/keeps its place in the list/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull()
    // Close is the only footer action; the header's X is a separate control.
    expect(document.querySelector('.modal-actions').textContent.trim()).toBe('Close')
    expect(clicked).toHaveLength(0)
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
   * Distinct variants, not both amber: `badge-warning` means look at this, and a gateway waiting
   * for its bundle is an unfinished task rather than a fault.
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
