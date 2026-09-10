import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { FlowProposalPanel } from '../components/common/FlowProposalPanel'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    proposeGatewayFlow: vi.fn()
  }
}))

const GATEWAY = {
  gateway_id: '2a000000-0000-4000-8000-000000000001',
  gateway_name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  deployment: 'remote'
}

const PULL = {
  number: 7,
  html_url: 'https://git.example/acs_platform/gateway-gwy2a0000000000400080000/pulls/7',
  branch: 'proposal/2026-09-10T09-00-00-000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
})

const renderWith = (props, gateway = GATEWAY) => {
  const showToast = vi.fn()
  const view = render(<FlowProposalPanel gateway={gateway} showToast={showToast} {...props} />)
  return { showToast, ...view }
}

const zone = () => screen.queryByTitle(/Propose a flows.json/i)
const drop = (file) => fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } })
const FLOW = () => new File(['[]'], 'flows.json', { type: 'application/json' })

/**
 * THE GATE IS A ROLE, NOT A PERMISSION, and GatewaysTab computes it as
 * `canManage || userRole === 'Operator'` -- the same three names `propose-gateway-flow` admits.
 * These tests take the resulting boolean, which is the whole of this component's contract.
 */
describe('FlowProposalPanel — who sees it', () => {
  it('shows the dropzone to a role that may propose', () => {
    renderWith({ canPropose: true })
    expect(zone()).toBeTruthy()
  })

  /**
   * NOTHING AT ALL for a role that may not -- not an empty panel and not a disabled one, which
   * would invite a request for access that was never intended. An Auditor lands here: read-only is
   * the whole of that role, and proposing is a write wherever it lands.
   */
  it('shows an Auditor nothing at all', () => {
    const { container } = renderWith({ canPropose: false })
    expect(container.textContent).toBe('')
  })
})

/**
 * A HOST-RUN GATEWAY IS REFUSED, AND THE REASON IS NOT A PERMISSION.
 *
 * A host-run connector lives in the platform's own Node-RED, and one instance can carry several
 * host gateways -- so `flows.json` there is the whole instance rather than this gateway's, and
 * approving a proposal "for" one would replace the others' flows. The panel says so rather than
 * disappearing, because a control that is absent without explanation reads as a missing feature.
 */
describe('FlowProposalPanel — host-run gateways', () => {
  const HOST = { ...GATEWAY, deployment: 'host' }

  it('explains why there is no dropzone, and offers none', () => {
    renderWith({ canPropose: true }, HOST)
    expect(zone()).toBeNull()
    expect(screen.getByText(/several host gateways can share/i)).toBeTruthy()
    expect(screen.getByText(/Edit it in the Node-RED editor instead/i)).toBeTruthy()
  })

  /**
   * "HOST-RUN", NEVER "VIRTUAL". The old word meant three things at once -- no appliance, not
   * physical hardware, not real data -- and this drawer needs only the first. GatewayBundleModal
   * records the reasoning; this asserts the copy has not drifted back.
   */
  it('does not call it a virtual gateway', () => {
    const { container } = renderWith({ canPropose: true }, HOST)
    expect(container.textContent).not.toMatch(/virtual/i)
    expect(container.textContent).toMatch(/host-run/i)
  })

  it('shows a role that may not propose nothing, host-run or not', () => {
    const { container } = renderWith({ canPropose: false }, HOST)
    expect(container.textContent).toBe('')
  })
})

describe('FlowProposalPanel — proposing', () => {
  it('sends the file and renders the pull request as a receipt', async () => {
    api.proposeGatewayFlow.mockResolvedValue(PULL)
    const { showToast } = renderWith({ canPropose: true })

    const file = FLOW()
    drop(file)

    await waitFor(() => expect(api.proposeGatewayFlow).toHaveBeenCalledWith(GATEWAY.gateway_id, file))
    const link = await screen.findByRole('link', { name: /pull request #7/i })
    expect(link.getAttribute('href')).toBe(PULL.html_url)
    // THE RECEIPT'S POINT IS THAT IT IS NOT DEPLOYED. A toast saying "proposed" and nothing else
    // would leave the operator believing the appliance had changed.
    expect(screen.getByText(/awaiting review/i)).toBeTruthy()
    expect(screen.getByText(PULL.branch)).toBeTruthy()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/awaiting review/i), 'success')
  })

  it('accepts a drop as well as a click', async () => {
    api.proposeGatewayFlow.mockResolvedValue(PULL)
    renderWith({ canPropose: true })

    const file = FLOW()
    fireEvent.drop(zone(), { dataTransfer: { files: [file] } })

    await waitFor(() => expect(api.proposeGatewayFlow).toHaveBeenCalledWith(GATEWAY.gateway_id, file))
  })

  /**
   * A refusal has to be VISIBLE and not merely toasted. "This deployment has no forge" and "this
   * gateway has no repository" are both ordinary states -- a gateway enrolled before the forge
   * existed has no repository, and that is a sentence somebody can act on. A toast is gone before
   * they have read it.
   */
  it('shows the reason a proposal was refused', async () => {
    api.proposeGatewayFlow.mockRejectedValue(new Error('This gateway has no repository'))
    const { showToast } = renderWith({ canPropose: true })

    drop(FLOW())

    expect(await screen.findByText(/no repository/i)).toBeTruthy()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('no repository'), 'error')
  })

  /**
   * api.proposeGatewayFlow refuses flows_cred.json by SHAPE, and the edge function refuses it again
   * -- a bucket object could be deleted, and a commit is forever. This asserts the panel surfaces
   * that refusal rather than failing silently.
   */
  it('surfaces a credential-file refusal on screen', async () => {
    api.proposeGatewayFlow.mockRejectedValue(
      new Error('That looks like flows_cred.json, not flows.json. Credential files are never committed.')
    )
    renderWith({ canPropose: true })

    drop(new File(['{}'], 'flows_cred.json', { type: 'application/json' }))

    expect(await screen.findByText(/Credential files are never committed/)).toBeTruthy()
  })

  /** The bucket is gone from this panel entirely: no listing, no sizes, no delete. */
  it('offers nothing of the retired backup lane', async () => {
    renderWith({ canPropose: true })
    expect(screen.queryByText(/Flow backups/i)).toBeNull()
    expect(screen.queryByText(/stored/i)).toBeNull()
    expect(screen.queryAllByTitle(/Delete this backup/i)).toHaveLength(0)
    expect(screen.queryAllByTitle(/Download this backup/i)).toHaveLength(0)
  })
})
