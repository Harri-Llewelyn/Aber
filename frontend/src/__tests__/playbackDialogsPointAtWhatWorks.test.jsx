import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StartPlaybackModal } from '../components/modals/StartPlaybackModal'
import { GatewayCredentialModal } from '../components/modals/GatewayCredentialModal'

/**
 * The playback and credential dialogs tell an operator to do only what the database allows. A
 * device is never bound to the Playback gateway by hand (0083), the last Playback gateway cannot be
 * archived (0067), an unmapped device is refused rather than quarantined, and re-issuing the
 * Playback gateway's credential cuts a running playback rather than a Node-RED connection.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      playbackTargets: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      ensureShadowLanes: vi.fn(),
      captureUrl: vi.fn(),
      mintGatewayCredential: vi.fn()
    }
  }
})

import { api } from '../api'

const GW = 'gwy160000000000400080000'
const RECORDED = 'dev880000000000400080000'
const LANE = 'dev770000000000400080000'
const TARGET = {
  id: 'gw-playback', name: 'Playback', sparkplug_id: GW, sparkplug_group: 'Aber',
  is_archived: false, status: 'OFFLINE', last_heartbeat: null, gateway_has_broker_credential: true,
  devices: [{ id: 'lane-1', name: 'Lane', sparkplug_id: LANE, is_archived: false, shadow_of: 'd-1' }]
}
const CAPTURE = {
  id: 'cap-1', note: 'baseline', message_count: 5, subject_sparkplug_id: RECORDED,
  storage_path: `${RECORDED}/capture.json`,
  manifest: { birth_captured: true, device_ids: [RECORDED] }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [GW], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
})

describe('the playback dialog', () => {
  it('says what to do when the Playback gateway cannot be found, and not to restore it', async () => {
    api.playbackTargets.mockResolvedValue([])
    render(<StartPlaybackModal capture={CAPTURE} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const callout = await screen.findByText(/could not be found/)
    expect(callout.textContent).toMatch(/open it again/)
    expect(callout.textContent).toMatch(/upgrade the release/)
    expect(document.body.textContent).not.toMatch(/Archived Entities|Restore/)
  })

  it('says an unmapped device is refused, not that it quarantines anything', async () => {
    api.playbackTargets.mockResolvedValue([TARGET])
    render(<StartPlaybackModal capture={CAPTURE} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Playback gateway'), { target: { value: TARGET.id } })
    const hint = await screen.findByText(/plays back as its replay lane/)
    expect(hint.textContent).toMatch(/left unmapped is refused/)
    expect(document.body.textContent).not.toMatch(/quarantin/)
  })

  it('never tells an operator to bind a device to the Playback gateway', async () => {
    // Lanes were prepared, and the re-read of the gateway returned none of them.
    api.playbackTargets.mockResolvedValueOnce([TARGET]).mockResolvedValue([{ ...TARGET, devices: [] }])
    api.ensureShadowLanes.mockResolvedValue({ [RECORDED]: LANE })
    render(<StartPlaybackModal capture={CAPTURE} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Playback gateway'),
      { target: { value: TARGET.id } })
    // The map starts empty, so the one captured device offers its lane.
    fireEvent.click(await screen.findByText(/Prepare replay lanes/))
    expect(await screen.findByText(/replay lanes could not be read/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Devices page|bind it/)
  })
})

describe('issuing a credential', () => {
  const confirm = (name) => {
    fireEvent.change(screen.getByLabelText(`Type ${name} to confirm`), { target: { value: name } })
  }

  it('warns that re-issuing the Playback gateway cuts a running playback', () => {
    render(<GatewayCredentialModal
      gateway={{ gateway_id: 'gw-playback', gateway_name: 'Playback', sparkplug_id: GW, is_shadow: true }}
      onClose={vi.fn()} showToast={vi.fn()} />)
    const text = document.body.textContent
    expect(text).toMatch(/replaces the one the playback worker uses/)
    expect(text).toMatch(/playback running now is cut off at once and fails/)
    expect(text).not.toMatch(/90 seconds|Node-RED/)
    confirm('Playback')
    expect(screen.getByText(/Issue Credential/i).closest('button')).not.toBeDisabled()
  })

  it('still warns a host-run gateway that its Node-RED connection is dropped', async () => {
    api.mintGatewayCredential.mockResolvedValue({})
    render(<GatewayCredentialModal
      gateway={{ gateway_id: 'gw-host', gateway_name: 'Host Connector', sparkplug_id: 'gwy4a0000000000400080000' }}
      onClose={vi.fn()} showToast={vi.fn()} />)
    expect(document.body.textContent).toMatch(/running Node-RED is using/)
    expect(document.body.textContent).toMatch(/stale on the dashboard within 90 seconds/)
    expect(document.body.textContent).not.toMatch(/playback/i)
    confirm('Host Connector')
    fireEvent.click(screen.getByText(/Issue Credential/i))
    await waitFor(() => expect(api.mintGatewayCredential).toHaveBeenCalledWith('gw-host'))
  })
})
