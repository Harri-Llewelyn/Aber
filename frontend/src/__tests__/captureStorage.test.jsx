import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'

/**
 * What the Capture page says about a stored capture and the files it takes in: how a recording
 * ended and for how long, the machine's metrics without Sparkplug plumbing, a recording the daemon
 * stopped reporting on, and a file naming devices this site does not have, which cannot be played
 * back and is refused before it can replace a stored capture.
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
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      uploadCapture: vi.fn(),
      captureUrl: vi.fn(),
      deleteCapture: vi.fn(),
      playbackTargets: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      ensureShadowLanes: vi.fn(),
      startPlayback: vi.fn(),
      stopPlayback: vi.fn()
    }
  }
})

vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

import { api } from '../api'
import { useRealtimeTable } from '../hooks/useRealtimeTable'

const GATEWAY = {
  id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000',
  is_archived: false, is_simulated: false
}
const DEVICE = {
  id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000',
  gateway_id: 'gw-1', is_archived: false
}
const TARGET = {
  id: 'gw-sim', name: 'Playback', sparkplug_id: 'gwy160000000000400080000',
  sparkplug_group: 'Aber', is_archived: false, gateway_has_broker_credential: true, devices: []
}

const CAPTURE = {
  id: 'cap-1', subject_kind: 'gateway', gateway_id: 'gw-1', device_id: null,
  subject_sparkplug_id: 'gwy120000000000400080000',
  storage_path: 'gwy120000000000400080000/6f0e.json', size_bytes: 2386, message_count: 6,
  note: 'pre-trip baseline', source: 'recorded', recorded_at: '2026-08-27T14:30:00.000Z',
  manifest: { birth_captured: true, metric_names: ['Spindle_Speed'], topic_count: 2 }
}

function renderTab() {
  return render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
}

async function openPanel(capture) {
  api.listCaptures.mockResolvedValue([capture])
  renderTab()
  fireEvent.click((await screen.findByText('Line 1 Gateway')).closest('tr'))
  return screen.getByRole('complementary', { hidden: true })
}

const fileOf = (doc) => new File([JSON.stringify(doc)], 'elsewhere.json', { type: 'application/json' })

function dropOnCard(file) {
  fireEvent.drop(document.querySelector('.capture-card'), { dataTransfer: { files: [file], types: ['Files'] } })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(path => Promise.resolve(path.includes('gateways') ? [GATEWAY] : [DEVICE]))
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([TARGET])
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [TARGET.sparkplug_id], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
})

describe('how a stored recording ended', () => {
  it('says a cap cut it short, and how long it ran of the length asked for', async () => {
    const panel = await openPanel({
      ...CAPTURE,
      manifest: { ...CAPTURE.manifest, stop_reason: 'size_cap', duration_ms: 14 * 60 * 1000 + 2000, requested_seconds: 1800 }
    })
    expect(within(panel).getByText('14m of 30m')).toBeInTheDocument()
    const ended = within(panel).getByText('Cut short by the size cap')
    expect(ended.closest('.context-field-danger')).not.toBeNull()
  })

  it.each([['duration', 'Ran its full length'], ['operator', 'Stopped by an operator']])(
    'says %s without alarm', async (reason, label) => {
      const panel = await openPanel({
        ...CAPTURE, manifest: { ...CAPTURE.manifest, stop_reason: reason, duration_ms: 60000, requested_seconds: 300 }
      })
      expect(within(panel).getByText(label).closest('.context-field-danger')).toBeNull()
      expect(within(panel).getByText('1m of 5m')).toBeInTheDocument()
    })

  it('shows neither for a capture recorded before the manifest carried them', async () => {
    const panel = await openPanel(CAPTURE)
    expect(within(panel).queryByText('Duration')).toBeNull()
    expect(within(panel).queryByText('Ended')).toBeNull()
  })
})

describe('Captured Metrics', () => {
  it("lists the machine's metrics without Sparkplug plumbing or identity, and counts them", async () => {
    const panel = await openPanel({
      ...CAPTURE,
      manifest: {
        ...CAPTURE.manifest,
        metric_names: ['bdSeq', 'Node Control/Rebirth', 'Asset_ID', 'Asset_Name', 'Spindle_Speed', 'Properties/Serial'],
        metric_name_count: 6
      }
    })
    const label = within(panel).getByText('Captured Metrics')
    const section = label.parentElement
    expect(within(section).getByText('Spindle_Speed')).toBeInTheDocument()
    expect(within(section).getByText('Properties/Serial')).toBeInTheDocument()
    for (const name of ['bdSeq', 'Node Control/Rebirth', 'Asset_ID', 'Asset_Name']) {
      expect(within(section).queryByText(name)).toBeNull()
    }
    expect(within(label).getByText('2')).toBeInTheDocument()
  })
})

describe('a recording the daemon stopped reporting on', () => {
  it('says Stop ends it with nothing stored', async () => {
    api.activeCaptureJob.mockResolvedValue({
      id: 'job-1', status: 'RECORDING', subject_sparkplug_id: 'gwy120000000000400080000',
      gateways: { name: 'Line 1 Gateway' }, max_seconds: 300, max_messages: 100000, max_bytes: 52428800,
      messages: 40, bytes: 4000, birth_captured: true, elapsed_seconds: 30,
      started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    })
    renderTab()
    expect(await screen.findByText(/has not reported on this recording for 4m/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' }))
      .toHaveAccessibleDescription(expect.stringMatching(/nothing from it is stored/))
  })

  it('says nothing while the daemon reports', async () => {
    api.activeCaptureJob.mockResolvedValue({
      id: 'job-1', status: 'RECORDING', subject_sparkplug_id: 'gwy120000000000400080000',
      gateways: { name: 'Line 1 Gateway' }, max_seconds: 300, max_messages: 100000, max_bytes: 52428800,
      messages: 40, bytes: 4000, birth_captured: true, elapsed_seconds: 30,
      started_at: new Date(Date.now() - 31 * 1000).toISOString()
    })
    renderTab()
    expect(await screen.findByText(/Recording — Line 1 Gateway/)).toBeInTheDocument()
    expect(screen.queryByText(/has not reported on this recording/)).toBeNull()
  })
})

describe('a file from another site', () => {
  const FOREIGN = {
    aber_capture_version: 1,
    capture_epoch_ms: 1700000000000,
    messages: [
      { offset_ms: 0, topic: 'spBv1.0/Aber/NBIRTH/gwy120000000000400080000', payload: {} },
      { offset_ms: 10, topic: 'spBv1.0/Aber/DDATA/gwy120000000000400080000/dev999999999999999999999', payload: {} }
    ],
    identities: { edge_nodes: ['gwy120000000000400080000'], devices: ['dev999999999999999999999'] }
  }

  it('is refused on the "Play a file…" path before anything is stored', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    dropOnCard(fileOf(FOREIGN))
    expect(await screen.findByText(/this site does not have/, { ignore: '[role=tooltip]' })).toBeInTheDocument()
    expect(screen.getByText('dev999999999999999999999')).toBeInTheDocument()
    expect(screen.queryByLabelText('File it against')).toBeNull()
    expect(screen.getByRole('button', { name: /^Upload$/ })).toBeDisabled()
    expect(api.uploadCapture).not.toHaveBeenCalled()
  })

  it('is told, when stored before, that it cannot be played back, and no lanes are offered', async () => {
    const panel = await openPanel({
      ...CAPTURE, manifest: { ...CAPTURE.manifest, device_ids: ['dev999999999999999999999'] }
    })
    fireEvent.click(within(panel).getByRole('button', { name: /Play back/ }))
    fireEvent.change(await screen.findByLabelText('Playback gateway'), { target: { value: 'gw-sim' } })
    expect(await screen.findByText(/Every recorded device must exist/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Prepare replay lanes/ })).toBeNull()
  })

  it('says on the "Play a file…" button that every recorded device must exist here', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.getByRole('button', { name: /Play a file…/ }))
      .toHaveAccessibleDescription(expect.stringMatching(/Every device the file recorded must exist on this site/))
  })
})

describe('the upload dialog and the stored captures', () => {
  const GOOD = {
    aber_capture_version: 1,
    capture_epoch_ms: 1700000000000,
    messages: [{ offset_ms: 0, topic: 'spBv1.0/Aber/NDATA/gwy120000000000400080000', payload: {} }],
    identities: { edge_nodes: ['gwy120000000000400080000'], devices: [] }
  }

  it('says a file with no NBIRTH stores but cannot be played back', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    dropOnCard(fileOf(GOOD))
    expect(await screen.findByText(/so a playback refuses it/)).toBeInTheDocument()
    expect(screen.getByLabelText('File it against')).toBeInTheDocument()
  })

  it('re-reads the stored captures when it opens, since captures is not published to Realtime', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    const before = api.listCaptures.mock.calls.length
    dropOnCard(fileOf(GOOD))
    await screen.findByLabelText('File it against')
    await waitFor(() => expect(api.listCaptures.mock.calls.length).toBeGreaterThan(before))
    expect(useRealtimeTable.mock.calls[0][0]).toEqual(['capture_jobs', 'playback_jobs'])
  })

  it('names the capture it means to replace, and re-reads the list when the server refuses', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.uploadCapture.mockRejectedValue(new Error(
      'register_uploaded_capture: another capture of this subject was stored after this upload began'))
    renderTab()
    await screen.findByText('Line 1 Gateway')
    dropOnCard(fileOf(GOOD))
    const subject = await screen.findByLabelText('File it against')
    await waitFor(() => expect(subject.value).toBe('gateway:gw-1'))
    const calls = api.listCaptures.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /Replace and upload/ }))
    expect(await screen.findByText(/stored after this upload began/)).toBeInTheDocument()
    expect(api.uploadCapture).toHaveBeenCalledWith(expect.objectContaining({
      subjectKind: 'gateway', subjectId: 'gw-1', replace: true, expectedCaptureId: 'cap-1'
    }))
    await waitFor(() => expect(api.listCaptures.mock.calls.length).toBeGreaterThan(calls))
  })
})
