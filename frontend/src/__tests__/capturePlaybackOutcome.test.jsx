import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StartPlaybackModal } from '../components/modals/StartPlaybackModal'

/**
 * What the playback dialog says about the worker: which password it holds for the Playback gateway.
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
      captureUrl: vi.fn()
    }
  }
})

import { api } from '../api'

const GW = 'gwy160000000000400080000'
const TARGET = {
  id: 'gw-playback', name: 'Playback', sparkplug_id: GW, sparkplug_group: 'Aber',
  is_archived: false, status: 'OFFLINE', last_heartbeat: null, gateway_has_broker_credential: true,
  devices: [{ id: 'lane-1', name: 'Lane', sparkplug_id: 'dev770000000000400080000', is_archived: false }]
}
const CAPTURE = {
  id: 'cap-1', note: 'baseline', message_count: 5, subject_sparkplug_id: 'dev880000000000400080000',
  storage_path: 'dev880000000000400080000/capture.json',
  manifest: { birth_captured: true, device_ids: [] }
}

function worker(overrides = {}) {
  return { held_edge_nodes: [GW], reported_at: new Date().toISOString(), ...overrides }
}

async function openOn(target = TARGET) {
  api.playbackTargets.mockResolvedValue([target])
  render(<StartPlaybackModal capture={CAPTURE} onConfirm={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.change(await screen.findByLabelText('Playback gateway'), { target: { value: target.id } })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.playbackStaleCredentials.mockResolvedValue([])
})

describe('which password the worker holds', () => {
  it('names the delivered password and the Helm value it falls back to', async () => {
    api.playbackWorkerStatus.mockResolvedValue(worker({ credential_sources: { [GW]: ['delivered', 'helm'] } }))
    await openOn()
    expect(await screen.findByText(
      /uses the password delivered when this gateway’s credential was issued\. If the broker refuses it, the worker tries the password in the Helm value secrets\.mqttPlaybackCredentials\./
    )).toBeInTheDocument()
  })

  it('names the Helm value when that is the one in use', async () => {
    api.playbackWorkerStatus.mockResolvedValue(worker({ credential_sources: { [GW]: ['helm', 'delivered'] } }))
    await openOn()
    expect(await screen.findByText(
      /uses the password in the Helm value secrets\.mqttPlaybackCredentials\. If the broker refuses it, the worker tries the password delivered/
    )).toBeInTheDocument()
  })

  it('says nothing for a worker that reports no sources', async () => {
    api.playbackWorkerStatus.mockResolvedValue(worker())
    await openOn()
    await screen.findByText(/Only the Playback gateway is listed/)
    expect(screen.queryByText(/The playback worker uses/)).toBeNull()
  })

  it('says nothing when the worker does not hold the gateway', async () => {
    api.playbackWorkerStatus.mockResolvedValue(worker({ held_edge_nodes: [], credential_sources: { [GW]: ['helm'] } }))
    await openOn()
    await screen.findByText(/was not given its password/)
    expect(screen.queryByText(/The playback worker uses/)).toBeNull()
  })
})
