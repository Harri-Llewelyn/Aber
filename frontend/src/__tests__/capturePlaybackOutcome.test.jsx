import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StartPlaybackModal } from '../components/modals/StartPlaybackModal'
import { CaptureTab } from '../components/tabs/CaptureTab'

/**
 * What the Capture page says about a playback: which password the worker holds, whether the Playback
 * gateway is really publishing, and how a job the operator stopped ended.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      listCaptures: vi.fn(),
      activeCaptureJob: vi.fn(),
      recentCaptureJobs: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
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

vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  api.playbackStaleCredentials.mockResolvedValue([])
  api.get.mockResolvedValue([])
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
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

describe('whether the Playback gateway is publishing', () => {
  beforeEach(() => { api.playbackWorkerStatus.mockResolvedValue(worker()) })

  it('does not warn in the 90 seconds after a playback, when the NDEATH set it OFFLINE', async () => {
    await openOn({ ...TARGET, status: 'OFFLINE', last_heartbeat: new Date().toISOString() })
    await screen.findByText(/Only the Playback gateway is listed/)
    expect(screen.queryByText(/is publishing right now/)).toBeNull()
  })

  it('warns while it is ONLINE with a fresh heartbeat', async () => {
    await openOn({ ...TARGET, status: 'ONLINE', last_heartbeat: new Date().toISOString() })
    expect(await screen.findByText(/is publishing right now/)).toBeInTheDocument()
  })
})

describe('the worker during a long playback', () => {
  it('reads as running while its timer keeps reporting, however long the job', async () => {
    // The heartbeat is a timer on the worker, so a report is never older than about 30 seconds.
    api.playbackWorkerStatus.mockResolvedValue(worker({ reported_at: new Date(Date.now() - 40 * 1000).toISOString() }))
    await openOn()
    await screen.findByText(/Only the Playback gateway is listed/)
    expect(screen.queryByText(/has not reported recently/)).toBeNull()
  })
})

describe('a playback the operator stopped', () => {
  const STOPPED = {
    id: 'play-stopped', status: 'CANCELLED', target_edge_node_id: GW, gateways: { name: 'Playback' },
    messages_sent: 4, messages_total: 5, messages_out_of_window: 0, error: null,
    finished_at: new Date().toISOString()
  }

  function renderTab() {
    return render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
  }

  it('is a neutral outcome saying how far it got, not a red failure', async () => {
    api.recentPlaybackJobs.mockResolvedValue([STOPPED])
    renderTab()
    const notice = (await screen.findByText(/playback\s+stopped: 4 of 5 messages published before it was stopped\./)).closest('.callout')
    expect(notice).toHaveClass('callout-info')
    expect(notice).not.toHaveClass('callout-danger')
    expect(screen.queryByText(/playback\s+(failed|cancelled)/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss the playback outcome notice' })).toBeInTheDocument()
  })

  it('carries the reason when Stop ended a stalled job', async () => {
    api.recentPlaybackJobs.mockResolvedValue([{
      ...STOPPED, error: 'stopped here because the playback worker had not reported for 147 seconds; it had reported 4 message(s) published of 5'
    }])
    renderTab()
    const notice = (await screen.findByText(/had not reported for 147 seconds/)).closest('.callout')
    expect(notice).toHaveClass('callout-info')
  })

  it('leaves a failure red', async () => {
    api.recentPlaybackJobs.mockResolvedValue([{ ...STOPPED, id: 'play-failed', status: 'FAILED', error: 'publishing stopped after 7 message(s): the broker connection was lost.' }])
    renderTab()
    const notice = (await screen.findByText(/playback\s+failed: publishing stopped after 7/)).closest('.callout')
    expect(notice).toHaveClass('callout-danger')
  })
})
