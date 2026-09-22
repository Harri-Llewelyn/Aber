import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { captureManifest, capturePath } from '../api'
import { tabIsVisible, TABS, groupedNav } from '../App'

/**
 * The Capture page. Two decisions here are destructive or unrecoverable: the replace confirmation
 * has to name what it destroys (timestamp and note), and `birth_captured = false` has to be visible
 * on the list without overstating itself, since a birthless capture drops metrics only when it uses
 * aliases. The rest is the shape the daemon and the schema require: a device capture is a subject
 * in its own right, one capture runs at a time, and the page never records anything itself.
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

const GATEWAY = {
  id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000',
  is_archived: false, is_simulated: false
}
const SIM_GATEWAY = {
  id: 'gw-2', name: 'Playback Target', sparkplug_id: 'gwy130000000000400080000',
  is_archived: false, is_simulated: true
}
const DEVICE = {
  id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000',
  gateway_id: 'gw-1', is_archived: false
}
const UNBOUND_DEVICE = {
  id: 'dev-2', name: 'Orphan', sparkplug_id: 'dev990000000000400080000',
  gateway_id: null, is_archived: false
}

const CAPTURE = {
  id: 'cap-1',
  subject_kind: 'gateway',
  gateway_id: 'gw-1',
  device_id: null,
  subject_sparkplug_id: 'gwy120000000000400080000',
  storage_path: 'gwy120000000000400080000/capture.json',
  size_bytes: 2386,
  message_count: 6,
  note: 'pre-trip bearing vibration baseline',
  manifest: { birth_captured: true, metric_names: ['Spindle_Speed'], topic_count: 2 },
  source: 'recorded',
  recorded_at: '2026-08-27T14:30:00.000Z'
}

function renderTab(overrides = {}) {
  const props = { showToast: vi.fn(), userRole: 'Administrator', ...overrides }
  const result = render(<CaptureTab {...props} />)
  return { ...result, props }
}

/**
 * Select a row, which opens the details panel. The actions live in the ContextPanel, which also has
 * room to say why one is unavailable.
 */
function selectRow(row) {
  fireEvent.click(row)
  return screen.getByRole('complementary', { hidden: true })
}

/** The panel's action list, by accessible name. Returns the button or null. */
function panelAction(name) {
  return screen.queryByRole('button', { name })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(path =>
    Promise.resolve(path.includes('gateways') ? [GATEWAY, SIM_GATEWAY] : [DEVICE, UNBOUND_DEVICE]))
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([TARGET])
  // A live worker holding the target's password: the ordinary case, so the existing tests are
  // about what they were about rather than about a worker that has never reported.
  api.playbackWorkerStatus.mockResolvedValue({
    held_edge_nodes: ['gwy130000000000400080000'], reported_at: new Date().toISOString()
  })
  // Nothing stale by default: a re-issue the worker has not picked up is its own case (#217),
  // asserted below, and every other test here is about something else.
  api.playbackStaleCredentials.mockResolvedValue([])
})

const TARGET = {
  id: 'gw-sim', name: 'Playback Target', sparkplug_id: 'gwy130000000000400080000',
  sparkplug_group: 'Aber', is_archived: false, gateway_has_broker_credential: true,
  devices: [
    { id: 'tdev-1', name: 'Sim Spindle', sparkplug_id: 'dev310000000000400080000', is_archived: false }
  ]
}

const PLAYABLE = {
  ...CAPTURE,
  manifest: { ...CAPTURE.manifest, device_ids: ['dev270000000000400080000'] }
}

// =============================================================================================
describe('the subject tables', () => {
  it('lists gateways first, and switches to devices', async () => {
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    expect(screen.queryByText('CNC Spindle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    expect(await screen.findByText('CNC Spindle')).toBeInTheDocument()
  })

  /**
   * A device with no gateway has no edge node to record from, and `start_capture_job()` refuses it.
   */
  it('leaves out a device that is bound to no gateway', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    expect(await screen.findByText('CNC Spindle')).toBeInTheDocument()
    expect(screen.queryByText('Orphan')).not.toBeInTheDocument()
  })

  it('shows a device the gateway it publishes through', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    const row = (await screen.findByText('CNC Spindle')).closest('tr')
    expect(within(row).getByText('Line 1 Gateway')).toBeInTheDocument()
  })

  it('says nothing is stored when nothing is', async () => {
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText('—')).toBeInTheDocument()
  })
})

// =============================================================================================
/**
 * The playback lane is not a capture subject: recording from a shadow gateway captures a capture,
 * and `shadow_of` says its devices exist to receive a replay. `playbackTargets()` selects on
 * `is_shadow` because that is the lane a playback publishes into.
 */
describe('the playback lane', () => {
  const SHADOW_GATEWAY = {
    id: 'gw-shadow', name: 'Playback', sparkplug_id: 'gwy160000000000400080000',
    is_simulated: true, is_shadow: true, deployment: 'host', is_archived: false,
  }
  const SHADOW_DEVICE = {
    id: 'dev-shadow', name: 'Shadow Spindle', sparkplug_id: 'dev990000000000400080000',
    gateway_id: 'gw-shadow', shadow_of: 'dev-1', is_archived: false,
  }

  it('leaves the playback gateway out of the gateway table', async () => {
    api.get.mockImplementation(path => Promise.resolve(
      path.includes('gateways') ? [GATEWAY, SHADOW_GATEWAY] : [DEVICE]
    ))
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    // Scoped to the table: the word also appears in the playback controls on this page.
    const table = within(document.querySelector('table'))
    expect(table.queryByText('Playback')).toBeNull()
  })

  it('leaves shadow devices out of the device table', async () => {
    api.get.mockImplementation(path => Promise.resolve(
      path.includes('gateways') ? [GATEWAY] : [DEVICE, SHADOW_DEVICE]
    ))
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /devices/i }))
    expect(await screen.findByText('CNC Spindle')).toBeInTheDocument()
    expect(within(document.querySelector('table')).queryByText('Shadow Spindle')).toBeNull()
  })

  /**
   * THE TABLE IS NOT THE ONLY READER. Four things answer "what can be captured" from the same two
   * lists, and each one that disagrees with the table is a lie an operator acts on: a badge that
   * counts a row it will not find, a filter naming a gateway whose devices are never listed, and an
   * upload dialog offering to file a real recording against a replay lane.
   */
  const bothLanes = () => api.get.mockImplementation(path => Promise.resolve(
    path.includes('gateways') ? [GATEWAY, SHADOW_GATEWAY] : [DEVICE, SHADOW_DEVICE]
  ))

  it('counts capture subjects on the tabs, not everything the stack registered', async () => {
    bothLanes()
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    expect(within(screen.getByRole('tab', { name: /gateways/i })).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByRole('tab', { name: /devices/i })).getByText('1')).toBeInTheDocument()
  })

  it('offers no playback gateway in the device tab gateway filter', async () => {
    bothLanes()
    renderTab()
    expect(await screen.findByText('Line 1 Gateway')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /devices/i }))
    const filter = await screen.findByLabelText('Gateway filter')
    // Its own count is the same question one level down: the shadow device does not belong to a
    // gateway that can be captured, so it is not in anybody's total.
    expect([...filter.options].map(o => o.textContent.trim()))
      .toEqual(['All gateways', 'Line 1 Gateway (1)'])
  })

  it('will not file an uploaded capture against the playback lane', async () => {
    bothLanes()
    renderTab()
    await screen.findByText('Line 1 Gateway')
    const doc = {
      acs_capture_version: 1,
      messages: [{ topic: 'spBv1.0/G/NDATA/gwy120000000000400080000', payload: {} }],
      identities: { edge_nodes: ['gwy120000000000400080000'], devices: [] }
    }
    fireEvent.drop(screen.getByLabelText('Publish a capture file'), {
      dataTransfer: { files: [new File([JSON.stringify(doc)], 'edited.json', { type: 'application/json' })] }
    })
    const values = [...(await screen.findByLabelText('File it against')).options].map(o => o.value)
    expect(values).toContain('gateway:gw-1')
    expect(values).not.toContain('gateway:gw-shadow')
    expect(values).not.toContain('device:dev-shadow')
  })
})

describe('a stored capture', () => {
  it('shows its size, message count and note', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText(/6 messages/)).toBeInTheDocument()
    expect(within(row).getByText(/pre-trip bearing vibration baseline/)).toBeInTheDocument()
  })

  /**
   * The one badge that changes a decision. A birthless capture drops metrics only when the
   * recording depends on the alias table; both branches are pinned.
   */
  it('marks a birthless capture, and says only that devices go unannounced', async () => {
    api.listCaptures.mockResolvedValue([
      { ...CAPTURE, manifest: { ...CAPTURE.manifest, birth_captured: false, uses_aliases: false } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText('NO BIRTH')).toBeInTheDocument()
    expect(within(row).getByTitle(/carries its full name/)).toBeInTheDocument()
    expect(within(row).queryByTitle(/dropped on ingest/)).toBeNull()
  })

  it('says a birthless capture WILL drop metrics when it uses aliases', async () => {
    api.listCaptures.mockResolvedValue([
      { ...CAPTURE, manifest: { ...CAPTURE.manifest, birth_captured: false, uses_aliases: true } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByTitle(/dropped on ingest/)).toBeInTheDocument()
  })

  it('does not mark one that did', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).queryByText('NO BIRTH')).not.toBeInTheDocument()
  })

  it('marks an uploaded capture as such', async () => {
    api.listCaptures.mockResolvedValue([{ ...CAPTURE, source: 'uploaded' }])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText('UPLOADED')).toBeInTheDocument()
  })

  it('files a device capture against the device, not its gateway', async () => {
    api.listCaptures.mockResolvedValue([{
      ...CAPTURE, id: 'cap-2', subject_kind: 'device', gateway_id: 'gw-1', device_id: 'dev-1',
      storage_path: 'dev270000000000400080000/capture.json', note: 'spindle only'
    }])
    renderTab()
    // The gateway row must NOT claim it.
    const gatewayRow = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(gatewayRow).getByText('—')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    const deviceRow = (await screen.findByText('CNC Spindle')).closest('tr')
    expect(within(deviceRow).getByText(/spindle only/)).toBeInTheDocument()
  })
})

// =============================================================================================
describe('starting a capture', () => {
  it('passes the subject, the note and the duration to the gate', async () => {
    api.startCapture.mockResolvedValue('job-1')
    const { props } = renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Record/))

    fireEvent.change(await screen.findByLabelText(/Note/), { target: { value: 'night shift' } })
    fireEvent.change(screen.getByLabelText(/Record for/), { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: /Start recording/ }))

    await waitFor(() => expect(api.startCapture).toHaveBeenCalledWith({
      subjectKind: 'gateway', subjectId: 'gw-1', note: 'night shift', seconds: 600, replace: false
    }))
    expect(props.showToast).toHaveBeenCalled()
  })

  /** The destroy-a-rare-fault guard, and the reason `captures.note` exists. */
  it('names the capture it is about to destroy, note included', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Record/))

    const dialog = await screen.findByText(/This replaces the capture recorded/)
    expect(dialog).toHaveTextContent('pre-trip bearing vibration baseline')
    expect(dialog).toHaveTextContent(/27 Aug 2026/)
    expect(screen.getByRole('button', { name: /Replace and record/ })).toBeInTheDocument()
  })

  it('sends replace only when a capture is actually being replaced', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.startCapture.mockResolvedValue('job-1')
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Record/))
    fireEvent.click(await screen.findByRole('button', { name: /Replace and record/ }))

    await waitFor(() => expect(api.startCapture).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true })
    ))
  })

  /**
   * The refusal from `start_capture_job()` names the capture or the running job, so it is shown
   * verbatim in the dialog that asked.
   */
  it('shows the gate refusal in the dialog rather than swallowing it', async () => {
    api.startCapture.mockRejectedValue(new Error('a capture of gwy999 is already recording'))
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Record/))
    fireEvent.click(await screen.findByRole('button', { name: /Start recording/ }))

    expect(await screen.findByText(/already recording/)).toBeInTheDocument()
  })

  it('tells a device capture that it also takes the gateway birth certificate', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    const row = (await screen.findByText('CNC Spindle')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Record/))
    expect(await screen.findByText(/where the alias table lives/)).toBeInTheDocument()
  })
})

// =============================================================================================
describe('the running card', () => {
  const JOB = {
    id: 'job-1', status: 'RECORDING', subject_sparkplug_id: 'gwy120000000000400080000',
    gateways: { name: 'Line 1 Gateway' }, devices: null, note: 'night shift',
    messages: 120, bytes: 45000, elapsed_seconds: 3, max_seconds: 600, birth_captured: true,
    // The three caps a recording stops at. NOT NULL on the row, so a fixture without them was
    // testing a shape the database cannot produce.
    max_messages: 100000, max_bytes: 52428800
  }

  it('shows progress for the one running capture', async () => {
    api.activeCaptureJob.mockResolvedValue(JOB)
    renderTab()
    expect(await screen.findByText(/Recording — Line 1 Gateway/)).toBeInTheDocument()
    expect(screen.getByText(/120 messages/)).toBeInTheDocument()
    expect(screen.getByText(/3s of 600s/)).toBeInTheDocument()
  })

  /** One capture at a time is a database constraint; disabling the buttons is the courtesy. */
  it('refuses to record any other subject while one is running', async () => {
    api.activeCaptureJob.mockResolvedValue(JOB)
    renderTab()
    const row = (await screen.findByText('Playback Target')).closest('tr')
    selectRow(row)
    const button = panelAction(/Record/)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('One at a time'))
  })

  it('warns when no birth has arrived and the window has passed', async () => {
    api.activeCaptureJob.mockResolvedValue({ ...JOB, birth_captured: false, elapsed_seconds: 30 })
    renderTab()
    // Matched on a contiguous fragment: the sentence is broken up by <code>NBIRTH</code>, so a
    // pattern spanning those tags finds nothing even though the warning is on screen.
    expect(await screen.findByText(/A capture without one replays as/)).toBeInTheDocument()
  })

  it('says a queued job is waiting for the daemon, not that it is recording', async () => {
    api.activeCaptureJob.mockResolvedValue({ ...JOB, status: 'PENDING' })
    renderTab()
    expect(await screen.findByText(/Queued — Line 1 Gateway/)).toBeInTheDocument()
    expect(screen.getByText(/Waiting for the ingestion daemon/)).toBeInTheDocument()
  })

  it('asks the gate to stop rather than stopping anything itself', async () => {
    api.activeCaptureJob.mockResolvedValue(JOB)
    api.stopCapture.mockResolvedValue(true)
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(api.stopCapture).toHaveBeenCalledWith('job-1'))
  })

  /** A capture can finish between the click and the call. That is not a failure. */
  it('does not report a failure when the job had already finished', async () => {
    api.activeCaptureJob.mockResolvedValue(JOB)
    api.stopCapture.mockResolvedValue(false)
    const { props } = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(
      expect.stringContaining('already finished'), 'success'
    ))
  })
})

// =============================================================================================
describe('a failed job', () => {
  /** The card clears on failure, so without this the page looks as though nothing happened. */
  it('surfaces the reason after the card has gone', async () => {
    api.recentCaptureJobs.mockResolvedValue([{
      id: 'job-9', status: 'FAILED', subject_sparkplug_id: 'gwy120000000000400080000',
      gateways: { name: 'Line 1 Gateway' },
      error: 'recorded no messages from Aber/gwy120000000000400080000'
    }])
    renderTab()
    expect(await screen.findByText(/recorded no messages/)).toBeInTheDocument()
  })

  /** Dismissal has to survive a reload. */
  it('stays dismissed across a remount', async () => {
    const job = {
      id: 'job-dismissible', status: 'FAILED', subject_sparkplug_id: 'gwy150000000000400080000',
      gateways: { name: 'Sim_Gateway_Site_BMS' },
      error: 'recorded no messages', finished_at: new Date().toISOString()
    }
    api.recentCaptureJobs.mockResolvedValue([job])

    const first = renderTab()
    expect(await screen.findByText(/recorded no messages/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Dismiss the capture failure notice/ }))
    expect(screen.queryByText(/recorded no messages/)).toBeNull()

    // A reload is a fresh mount reading the same job back from the same query.
    first.unmount()
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.queryByText(/recorded no messages/)).toBeNull()
  })

  /** The other way out, for the operator who never comes back to the page. */
  it('hides a failure older than the visible window without being dismissed', async () => {
    api.recentCaptureJobs.mockResolvedValue([{
      id: 'job-old', status: 'FAILED', subject_sparkplug_id: 'gwy150000000000400080000',
      gateways: { name: 'Sim_Gateway_Site_BMS' },
      error: 'an hour ago', finished_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    }])
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.queryByText(/an hour ago/)).toBeNull()
  })

  it('says nothing when the recent jobs all succeeded', async () => {
    api.recentCaptureJobs.mockResolvedValue([{ id: 'job-8', status: 'COMPLETED' }])
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument()
  })
})

// =============================================================================================
describe('deleting and downloading', () => {
  it('names the capture in the delete confirmation', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Delete capture/))
    const message = await screen.findByText(/Delete the capture recorded/)
    expect(message).toHaveTextContent('pre-trip bearing vibration baseline')
  })

  it('passes the whole capture to the delete, not just a path', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.deleteCapture.mockResolvedValue()
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Delete capture/))
    // Scoped to the dialog: the panel's action and the confirmation's button carry the same name.
    const dialog = document.querySelector('.modal')
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete capture/ }))
    await waitFor(() => expect(api.deleteCapture).toHaveBeenCalledWith(CAPTURE))
  })

  it('opens a signed URL to download', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.captureUrl.mockResolvedValue('https://example.test/signed')
    const open = vi.spyOn(window, 'open').mockImplementation(() => {})
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Download/))
    await waitFor(() => expect(api.captureUrl).toHaveBeenCalledWith(CAPTURE.storage_path))
    expect(open).toHaveBeenCalledWith('https://example.test/signed', '_blank', 'noopener')
    open.mockRestore()
  })
})

// =============================================================================================
describe('the read-only role', () => {
  /**
   * Auditor can read the bucket and both tables and nothing else, and the page says so rather than
   * offering buttons that answer 42501.
   */
  it('offers an Auditor download and nothing that writes', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab({ userRole: 'Auditor' })
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); expect(panelAction(/Download/)).toBeInTheDocument()
    expect(panelAction(/Record/)).toBeNull()
    expect(panelAction(/Delete capture/)).toBeNull()
    expect(screen.getByText(/require Administrator or Shopfloor Manager/)).toBeInTheDocument()
  })

  it('offers a Shopfloor Manager the write actions', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab({ userRole: 'Shopfloor_Manager' })
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); expect(panelAction(/Record/)).toBeInTheDocument()
    expect(panelAction(/Delete capture/)).toBeInTheDocument()
  })
})

// =============================================================================================
describe('the nav entry', () => {
  const capture = TABS.find(t => t.id === 'capture')

  it('is offered to the three roles 0055 grants read to, and to no others', () => {
    const has = () => true
    expect(tabIsVisible(capture, has, 'Administrator')).toBe(true)
    expect(tabIsVisible(capture, has, 'Shopfloor_Manager')).toBe(true)
    expect(tabIsVisible(capture, has, 'Auditor')).toBe(true)
    // RLS returns no rows to an Operator, so the page would be empty with no explanation.
    expect(tabIsVisible(capture, has, 'Operator')).toBe(false)
  })

  /** A single-role `role:` string must keep working -- every other gated tab still uses one. */
  it('still honours a single role given as a string', () => {
    const settings = TABS.find(t => t.id === 'settings')
    expect(tabIsVisible(settings, () => true, 'Administrator')).toBe(true)
    expect(tabIsVisible(settings, () => true, 'Auditor')).toBe(false)
  })

  /**
   * Where it sits in the rail: under History rather than Assets, because a capture is a recording
   * of what a device already said, in the same tense as Digital Thread. Cold Storage used to be
   * the third page here and is now filed by retention instead -- it is telemetry kept against a
   * timer, not an account of what happened.
   */
  it('is filed under History in the rail, beside the other page about the past', () => {
    const visible = TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))
    const history = groupedNav(visible).find(g => g.id === 'history')

    expect(history.tabs.map(t => t.id)).toEqual(['digital-thread', 'capture'])
  })
})

// =============================================================================================
describe('the manifest the browser builds for an uploaded capture', () => {
  /**
   * The other half of a contract `capture_worker._manifest()` writes. If the two disagree, an
   * uploaded capture shows blank beside a recorded one.
   */
  const file = {
    duration_ms: 4000,
    messages: [
      { topic: 'spBv1.0/G/NBIRTH/gwy1', payload: { metrics: [{ name: 'A' }, { name: 'B' }] } },
      { topic: 'spBv1.0/G/DDATA/gwy1/dev1', payload: { metrics: [{ name: 'A' }] } }
    ]
  }

  it('reports the metric names once each, in first-seen order', () => {
    expect(captureManifest(file).metric_names).toEqual(['A', 'B'])
  })

  it('counts distinct topics', () => {
    expect(captureManifest(file).topic_count).toBe(2)
  })

  /** COMPUTED, NOT TRUSTED: an uploaded file could claim anything, and the messages answer it. */
  it('derives birth_captured from the messages themselves', () => {
    expect(captureManifest(file).birth_captured).toBe(true)
    expect(captureManifest({
      ...file, messages: [file.messages[1]]
    }).birth_captured).toBe(false)
  })

  it('survives a capture with no messages at all', () => {
    const manifest = captureManifest({ messages: [] })
    expect(manifest.metric_names).toEqual([])
    expect(manifest.observed_rate_hz).toBe(0)
    expect(manifest.birth_captured).toBe(false)
  })

  /**
   * The ids the playback dialog builds its device map from; without them it would have to download
   * the file to populate a select.
   */
  it('records the edge nodes and devices the capture publishes under', () => {
    const manifest = captureManifest(file)
    expect(manifest.edge_node_ids).toEqual(['gwy1'])
    expect(manifest.device_ids).toEqual(['dev1'])
  })

  it('lists a device once however many messages it sent', () => {
    const manifest = captureManifest({
      duration_ms: 1000,
      messages: [
        { topic: 'spBv1.0/G/DDATA/gwy1/dev1', payload: {} },
        { topic: 'spBv1.0/G/DDATA/gwy1/dev1', payload: {} },
        { topic: 'spBv1.0/G/DDATA/gwy1/dev2', payload: {} }
      ]
    })
    expect(manifest.device_ids).toEqual(['dev1', 'dev2'])
  })
})

// =============================================================================================
describe('publishing a capture back', () => {
  const open = async () => {
    api.listCaptures.mockResolvedValue([PLAYABLE])
    const rendered = renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    await screen.findByLabelText('Publish as')
    return rendered
  }

  /**
   * Only simulated gateways are offered, because `start_playback_job()` refuses anything else, and
   * the refusal is the last line of defence against synthetic telemetry on a real machine's
   * identity.
   */
  it('offers only the targets the gate will accept', async () => {
    await open()
    const select = screen.getByLabelText('Publish as')
    expect(within(select).getByText(/Playback Target/)).toBeInTheDocument()
    expect(within(select).queryByText(/Line 1 Gateway/)).not.toBeInTheDocument()
    await waitFor(() => expect(api.playbackTargets).toHaveBeenCalled())
  })

  // NOT VIA open(), which waits for the select: with no targets there is deliberately no select to
  // wait for, only the explanation of why.
  it('says so when nothing is marked simulated', async () => {
    api.playbackTargets.mockResolvedValue([])
    api.listCaptures.mockResolvedValue([PLAYABLE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    expect(await screen.findByText(/No gateway is marked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish capture/ })).toBeDisabled()
  })

  /** The credential check, shown before the click rather than arriving as a refusal after it. */
  it('names a target that holds no broker credential, and refuses to start', async () => {
    api.playbackTargets.mockResolvedValue([{ ...TARGET, gateway_has_broker_credential: false }])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    expect(await screen.findByText(/holds no broker credential/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish capture/ })).toBeDisabled()
  })

  /**
   * The device map from dropdowns, which the CLI cannot do: `capture.py play` needs `--map` typed
   * by hand for every captured device.
   */
  it('builds the device map from the devices bound to the target', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    const mapSelect = await screen.findByLabelText('Target device for dev270000000000400080000')
    expect(within(mapSelect).getByText(/Sim Spindle/)).toBeInTheDocument()
  })

  /**
   * The map builds itself: `ensure_shadow_devices()` mints a lane per captured device and returns
   * the map.
   */
  it('fills the map from the replay lanes it prepares', async () => {
    const LANE = { id: 'lane-1', name: 'Sim Spindle (replay)',
      sparkplug_id: 'dev990000000000400080000', is_archived: false, shadow_of: 'dev-27' }
    api.ensureShadowLanes.mockResolvedValue({ dev270000000000400080000: 'dev990000000000400080000' })

    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    await screen.findByLabelText('Target device for dev270000000000400080000')

    // The second resolve matters: the dropdown renders `target.devices`, read before the lane
    // existed, so without the reload the map holds an id the select cannot display.
    api.playbackTargets.mockResolvedValue([{ ...TARGET, devices: [...TARGET.devices, LANE] }])
    fireEvent.click(screen.getByRole('button', { name: /Prepare replay lanes/ }))

    await waitFor(() => expect(api.ensureShadowLanes).toHaveBeenCalledWith('cap-1'))
    await waitFor(() => expect(
      screen.getByLabelText('Target device for dev270000000000400080000')
    ).toHaveValue('dev990000000000400080000'))
    expect(screen.getByRole('button', { name: /Publish capture/ })).toBeEnabled()
  })

  it('does not prepare lanes until asked', async () => {
    // It WRITES -- a device row appearing in the directory because someone opened a modal is the
    // kind of surprise that makes people stop trusting the table.
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    await screen.findByLabelText('Target device for dev270000000000400080000')
    expect(api.ensureShadowLanes).not.toHaveBeenCalled()
  })

  it('will not start while a captured device is unmapped', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    await screen.findByLabelText('Target device for dev270000000000400080000')
    const publish = screen.getByRole('button', { name: /Publish capture/ })
    expect(publish).toBeDisabled()
    expect(publish).toHaveAttribute('title', expect.stringContaining('to map'))
  })

  it('passes the target, the map and the speed to the gate', async () => {
    api.startPlayback.mockResolvedValue('play-1')
    const { props } = await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    fireEvent.change(await screen.findByLabelText('Target device for dev270000000000400080000'),
      { target: { value: 'dev310000000000400080000' } })
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: /Publish capture/ }))

    await waitFor(() => expect(api.startPlayback).toHaveBeenCalledWith({
      captureId: 'cap-1',
      targetGatewayId: 'gw-sim',
      deviceMap: { dev270000000000400080000: 'dev310000000000400080000' },
      speed: 4
    }))
    expect(props.showToast).toHaveBeenCalled()
  })

  /**
   * Changing the target must clear the map: a device id from the previous gateway is what the gate
   * refuses.
   */
  it('clears the mapping when the target changes', async () => {
    api.playbackTargets.mockResolvedValue([
      TARGET,
      { ...TARGET, id: 'gw-sim2', name: 'Other Target', sparkplug_id: 'gwy140000000000400080000' }
    ])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    const mapSelect = await screen.findByLabelText('Target device for dev270000000000400080000')
    fireEvent.change(mapSelect, { target: { value: 'dev310000000000400080000' } })
    expect(mapSelect.value).toBe('dev310000000000400080000')

    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim2' } })
    const after = await screen.findByLabelText('Target device for dev270000000000400080000')
    expect(after.value).toBe('')
  })

  it('warns hard about a birthless capture that uses aliases', async () => {
    api.listCaptures.mockResolvedValue([
      { ...PLAYABLE, manifest: { ...PLAYABLE.manifest, birth_captured: false, uses_aliases: true } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    expect(await screen.findByText(/dropped on ingest/)).toBeInTheDocument()
  })

  /** The case that was being warned about wrongly: no birth, but every metric named in full. */
  it('does not claim a birthless capture writes nothing when its metrics are named', async () => {
    api.listCaptures.mockResolvedValue([
      { ...PLAYABLE, manifest: { ...PLAYABLE.manifest, birth_captured: false, uses_aliases: false } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    await screen.findByLabelText('Publish as')
    expect(screen.queryByText(/dropped on ingest/)).toBeNull()
    expect(screen.getByText(/will replay normally/)).toBeInTheDocument()
  })

  it('shows the gate refusal in the dialog', async () => {
    api.startPlayback.mockRejectedValue(new Error('gateway X is not marked simulated'))
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    fireEvent.change(await screen.findByLabelText('Target device for dev270000000000400080000'),
      { target: { value: 'dev310000000000400080000' } })
    fireEvent.click(screen.getByRole('button', { name: /Publish capture/ }))
    expect(await screen.findByText(/not marked simulated/)).toBeInTheDocument()
  })

  /** A capture with no device-level traffic has nothing to map, and must still be publishable. */
  it('needs no mapping for a capture that publishes only node-level traffic', async () => {
    api.listCaptures.mockResolvedValue([
      { ...PLAYABLE, manifest: { ...PLAYABLE.manifest, device_ids: [] } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    fireEvent.change(await screen.findByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    expect(await screen.findByText(/publishes no device-level traffic/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish capture/ })).not.toBeDisabled()
  })

  /**
   * Tier two, made visible: `gateway_has_broker_credential` says the platform issued a credential;
   * only the worker knows whether it was given the password.
   */
  it('refuses a target whose password the worker was not given', async () => {
    api.playbackWorkerStatus.mockResolvedValue({
      held_edge_nodes: [], reported_at: new Date().toISOString()
    })
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })

    expect(await screen.findByText(/was not given/)).toBeInTheDocument()
    expect(screen.getByText(/MQTT_PLAYBACK_CREDENTIALS/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish capture/ })).toBeDisabled()
  })

  /**
   * #217, and the ORDINARY case rather than an edge one: the broker keeps one password per gateway,
   * so every mint after the first replaces one. The worker goes on reporting the id -- that does not
   * change on a rotation -- so "held" cannot be the question the dialog asks.
   */
  it('refuses a target whose credential was re-issued after the worker last picked one up', async () => {
    api.playbackStaleCredentials.mockResolvedValue([
      { sparkplug_id: 'gwy130000000000400080000',
        observed_at: new Date(Date.now() - 300000).toISOString(),
        issued_at: new Date().toISOString() }
    ])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })

    expect(await screen.findByText(/was re-issued after the playback/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Publish capture/ })).toBeDisabled()
  })

  /** Nothing for the operator to do, so the message must not read like the missing-password one. */
  it('says the re-issue resolves itself, rather than asking for a password to be pasted', async () => {
    api.playbackStaleCredentials.mockResolvedValue([
      { sparkplug_id: 'gwy130000000000400080000',
        observed_at: new Date(Date.now() - 300000).toISOString(),
        issued_at: new Date().toISOString() }
    ])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })

    expect(await screen.findByText(/nothing needs\s+doing here/)).toBeInTheDocument()
    expect(screen.queryByText(/MQTT_PLAYBACK_CREDENTIALS/)).toBeNull()
  })

  /** The dropdown says which state a target is in before it is chosen. */
  it('marks a stale target in the target list', async () => {
    api.playbackStaleCredentials.mockResolvedValue([
      { sparkplug_id: 'gwy130000000000400080000', observed_at: null, issued_at: new Date().toISOString() }
    ])
    await open()
    expect(await screen.findByText(/still has the old password/)).toBeInTheDocument()
  })

  /**
   * NARROWING ONLY. This read failing must not refuse a target the dialog would otherwise offer:
   * start_playback_job() carries the same gate, so the server still refuses what matters.
   */
  it('offers what it always did when the staleness read fails', async () => {
    api.playbackStaleCredentials.mockRejectedValue(new Error('nope'))
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    fireEvent.change(await screen.findByLabelText('Target device for dev270000000000400080000'),
      { target: { value: 'dev310000000000400080000' } })

    expect(screen.queryByText(/was re-issued after the playback/)).toBeNull()
    expect(screen.getByRole('button', { name: /Publish capture/ })).not.toBeDisabled()
  })

  /**
   * The one thing that makes a target wrong rather than unready: a gateway that is beating already
   * has a publisher. Warned, not refused, since quiescing a machine and replaying onto it is
   * legitimate.
   */
  it('warns when something is already publishing as the target', async () => {
    api.playbackTargets.mockResolvedValue([
      { ...TARGET, last_heartbeat: new Date().toISOString(), status: 'ONLINE' }
    ])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    expect(await screen.findByText(/is publishing right now/)).toBeInTheDocument()
    // A warning, so the button is still reachable once the mapping is done.
    fireEvent.change(await screen.findByLabelText('Target device for dev270000000000400080000'),
      { target: { value: 'dev310000000000400080000' } })
    expect(screen.getByRole('button', { name: /Publish capture/ })).not.toBeDisabled()
  })

  it('says nothing about live traffic for a quiet target', async () => {
    api.playbackTargets.mockResolvedValue([
      { ...TARGET, last_heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), status: 'OFFLINE' }
    ])
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    expect(screen.queryByText(/is publishing right now/)).toBeNull()
  })

  /** The message named a variable and not where it lives, and the first reader asked if it went in the capture file. */
  it('says where MQTT_PLAYBACK_CREDENTIALS actually goes', async () => {
    api.playbackWorkerStatus.mockResolvedValue({
      held_edge_nodes: [], reported_at: new Date().toISOString()
    })
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    expect(await screen.findByText(/server-side setting, not part of the capture file/)).toBeInTheDocument()
    expect(screen.getByText(/kubectl rollout restart deploy\/playback/)).toBeInTheDocument()
  })

  /** "Holds nothing" and "is not running" are different problems, and only the heartbeat tells them apart. */
  it('says the worker is not running when its report is stale', async () => {
    api.playbackWorkerStatus.mockResolvedValue({
      held_edge_nodes: ['gwy130000000000400080000'],
      reported_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    })
    await open()
    expect(await screen.findByText(/has not reported recently/)).toBeInTheDocument()
  })

  /**
   * A stale worker must not block a playback: its credential list is unknown, not empty, and the
   * gate still refuses what it always refused.
   */
  it('still allows a playback when the worker status is unknown', async () => {
    api.playbackWorkerStatus.mockResolvedValue(null)
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    fireEvent.change(await screen.findByLabelText('Target device for dev270000000000400080000'),
      { target: { value: 'dev310000000000400080000' } })
    expect(screen.getByRole('button', { name: /Publish capture/ })).not.toBeDisabled()
  })

  it('does not offer Play to an Auditor', async () => {
    api.listCaptures.mockResolvedValue([PLAYABLE])
    renderTab({ userRole: 'Auditor' })
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); expect(panelAction(/Play back/)).toBeNull()
  })
})

// =============================================================================================
describe('the playback card', () => {
  const JOB = {
    id: 'play-1', status: 'RUNNING', target_edge_node_id: 'gwy130000000000400080000',
    gateways: { name: 'Playback Target' }, speed: 4,
    messages_sent: 30, messages_total: 120, elapsed_seconds: 7
  }

  it('names the gateway it is publishing as', async () => {
    api.activePlaybackJob.mockResolvedValue(JOB)
    renderTab()
    expect(await screen.findByText(/Publishing as Playback Target/)).toBeInTheDocument()
    expect(screen.getByText(/30 of 120 messages/)).toBeInTheDocument()
  })

  it('blocks Play on every row while one is running', async () => {
    api.listCaptures.mockResolvedValue([PLAYABLE])
    api.activePlaybackJob.mockResolvedValue(JOB)
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); expect(panelAction(/Play back/)).toBeDisabled()
  })

  it('asks the gate to stop rather than stopping anything itself', async () => {
    api.activePlaybackJob.mockResolvedValue(JOB)
    api.stopPlayback.mockResolvedValue(true)
    renderTab()
    // Two Stop buttons would be ambiguous; only the playback card is present here.
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(api.stopPlayback).toHaveBeenCalledWith('play-1'))
  })

  it('surfaces a failed playback after its card has gone', async () => {
    api.recentPlaybackJobs.mockResolvedValue([{
      id: 'play-9', status: 'FAILED', target_edge_node_id: 'gwy130000000000400080000',
      gateways: { name: 'Playback Target' },
      error: 'this worker holds no broker credential for gwy130000000000400080000'
    }])
    renderTab()
    expect(await screen.findByText(/holds no broker credential/)).toBeInTheDocument()
  })

  // ==========================================================================================
  // A COMPLETED playback that lost readings on ingest (#216). The ingestion daemon discards an
  // out-of-window metric by counting it, so nothing travels back to the publisher and the job is
  // recorded COMPLETED with its full messages_sent. Before 0109 the page could not tell that
  // apart from a playback that worked.
  // ==========================================================================================
  const lossy = (overrides = {}) => ({
    id: 'play-ooo', status: 'COMPLETED', target_edge_node_id: 'gwy130000000000400080000',
    gateways: { name: 'Playback Target' }, messages_sent: 412, messages_total: 412,
    messages_out_of_window: 3, finished_at: new Date().toISOString(), ...overrides,
  })

  it('says how many readings a completed playback lost to the sanity window', async () => {
    api.recentPlaybackJobs.mockResolvedValue([lossy()])
    renderTab()
    expect(await screen.findByText(/3 of 412 published messages carried timestamps too old/i))
      .toBeInTheDocument()
  })

  it('says nothing about a completed playback that lost none', async () => {
    // The overwhelmingly common case. A notice here would be noise on every successful run, and
    // noise is what makes the real one unreadable.
    api.recentPlaybackJobs.mockResolvedValue([lossy({ messages_out_of_window: 0 })])
    renderTab()
    await screen.findByText(/Nothing is publishing/i)
    expect(screen.queryByText(/timestamps too old/i)).toBeNull()
  })

  it('says nothing for a job written before the column existed', async () => {
    // Every row predating 0109 reads 0, which means "nobody counted" and not "none were
    // discarded". Undefined arrives the same way through a worker too old to send the argument.
    api.recentPlaybackJobs.mockResolvedValue([lossy({ messages_out_of_window: undefined })])
    renderTab()
    await screen.findByText(/Nothing is publishing/i)
    expect(screen.queryByText(/timestamps too old/i)).toBeNull()
  })

  it('does not call a lossy playback a failure', async () => {
    // It is a success that lost something, and the distinction is the whole design: the job ran,
    // some readings landed, and reporting it red would be as wrong as reporting it silent. A
    // playback that would have written NOTHING never reaches here -- the worker refuses it.
    api.recentPlaybackJobs.mockResolvedValue([lossy()])
    renderTab()
    await screen.findByText(/timestamps too old/i)
    expect(screen.queryByText(/playback failed/i)).toBeNull()
    expect(screen.queryByText(/playback cancelled/i)).toBeNull()
  })

  it('dismisses the notice, and does not bring it back', async () => {
    api.recentPlaybackJobs.mockResolvedValue([lossy()])
    const { unmount } = renderTab()
    await screen.findByText(/timestamps too old/i)
    fireEvent.click(screen.getByRole('button', { name: /Dismiss the discarded-readings notice/i }))
    expect(screen.queryByText(/timestamps too old/i)).toBeNull()

    unmount()
    renderTab()
    await screen.findByText(/Nothing is publishing/i)
    expect(screen.queryByText(/timestamps too old/i)).toBeNull()
  })
})

// =============================================================================================
describe('the filter bar', () => {
  it('narrows to subjects that have a capture', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.getByText('Playback Target')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Stored capture filter'), { target: { value: 'with' } })
    expect(screen.getByText('Line 1 Gateway')).toBeInTheDocument()
    expect(screen.queryByText('Playback Target')).not.toBeInTheDocument()
  })

  it('narrows to subjects that have none', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.change(screen.getByLabelText('Stored capture filter'), { target: { value: 'without' } })
    expect(screen.queryByText('Line 1 Gateway')).not.toBeInTheDocument()
    expect(screen.getByText('Playback Target')).toBeInTheDocument()
  })

  /** The wire identity is the thing an operator pastes in from a broker client or a log line. */
  it('searches the name and the Sparkplug ID', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')

    fireEvent.change(screen.getByLabelText('Search subjects'), { target: { value: 'playback' } })
    expect(screen.queryByText('Line 1 Gateway')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search subjects'), { target: { value: 'gwy12' } })
    expect(screen.getByText('Line 1 Gateway')).toBeInTheDocument()
    expect(screen.queryByText('Playback Target')).not.toBeInTheDocument()
  })

  it('says when the filters match nothing, rather than looking like an empty fleet', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.change(screen.getByLabelText('Search subjects'), { target: { value: 'zzz' } })
    expect(screen.getByText(/No subject matches these filters/)).toBeInTheDocument()
  })

  it('clears every filter at once, and only offers to when there is something to clear', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.queryByRole('button', { name: /Clear filters/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search subjects'), { target: { value: 'zzz' } })
    fireEvent.change(screen.getByLabelText('Stored capture filter'), { target: { value: 'with' } })
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(2\)/ }))

    expect(screen.getByText('Line 1 Gateway')).toBeInTheDocument()
    expect(screen.getByText('Playback Target')).toBeInTheDocument()
  })
})

// =============================================================================================
describe('the details panel', () => {
  it('opens on a row click and describes the subject', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    // Scoped to the panel: the note is shown in the row too, so an unscoped query matches both.
    const panel = selectRow(row)
    expect(within(panel).getByText('6 messages stored')).toBeInTheDocument()
    expect(within(panel).getByText(/pre-trip bearing vibration baseline/)).toBeInTheDocument()
  })

  /** The one field on the panel that changes what an operator does next. */
  it('calls out a capture with no birth certificate', async () => {
    api.listCaptures.mockResolvedValue([
      { ...CAPTURE, manifest: { ...CAPTURE.manifest, birth_captured: false } }
    ])
    renderTab()
    selectRow((await screen.findByText('Line 1 Gateway')).closest('tr'))
    expect(screen.getByText('Not captured')).toBeInTheDocument()
  })

  it('offers no capture-specific action when nothing is stored', async () => {
    renderTab()
    selectRow((await screen.findByText('Line 1 Gateway')).closest('tr'))
    expect(panelAction(/Record capture/)).toBeInTheDocument()
    expect(panelAction(/Play back/)).toBeNull()
    expect(panelAction(/Download/)).toBeNull()
    expect(panelAction(/Delete capture/)).toBeNull()
  })

  /** The drop zone knows its subject, which is why it lives here rather than on the page. */
  it('carries a drop zone scoped to the selected subject', async () => {
    renderTab()
    selectRow((await screen.findByText('Line 1 Gateway')).closest('tr'))
    expect(screen.getByLabelText('Upload a capture for Line 1 Gateway')).toBeInTheDocument()
  })

  it('offers an Auditor no drop zone', async () => {
    renderTab({ userRole: 'Auditor' })
    selectRow((await screen.findByText('Line 1 Gateway')).closest('tr'))
    expect(screen.queryByLabelText(/Upload a capture for/)).not.toBeInTheDocument()
  })

  it('closes when the same row is clicked again', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row)
    expect(panelAction(/Download/)).toBeInTheDocument()
    fireEvent.click(row)
    expect(panelAction(/Download/)).toBeNull()
  })
})

// =============================================================================================
describe('the playback card', () => {
  /** A card whose body vanishes reads as broken rather than idle, and this one owns a card. */
  it('explains how to start one when nothing is publishing', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.getByText(/Nothing is publishing/)).toBeInTheDocument()
  })

  it('offers a drop zone for an edited capture', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    expect(screen.getByLabelText('Publish a capture file')).toBeInTheDocument()
  })

  it('offers an Auditor no such zone', async () => {
    renderTab({ userRole: 'Auditor' })
    await screen.findByText('Line 1 Gateway')
    expect(screen.queryByLabelText('Publish a capture file')).not.toBeInTheDocument()
  })

  /**
   * Drop, store, publish. The subject is guessed from the identities in the file and offered, never
   * filed silently.
   */
  it('guesses the subject from the file and goes on to the playback dialog', async () => {
    api.uploadCapture.mockResolvedValue({
      id: 'cap-new', messages: 3, manifest: { device_ids: [], birth_captured: true }
    })
    renderTab()
    await screen.findByText('Line 1 Gateway')

    const doc = {
      acs_capture_version: 1,
      messages: [{ topic: 'spBv1.0/G/NDATA/gwy120000000000400080000', payload: {} }],
      identities: { edge_nodes: ['gwy120000000000400080000'], devices: [] }
    }
    const file = new File([JSON.stringify(doc)], 'edited.json', { type: 'application/json' })
    fireEvent.drop(screen.getByLabelText('Publish a capture file'), {
      dataTransfer: { files: [file] }
    })

    // The upload dialog opens with the subject the file names already chosen.
    const subject = await screen.findByLabelText('File it against')
    await waitFor(() => expect(subject.value).toBe('gateway:gw-1'))

    fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }))
    await waitFor(() => expect(api.uploadCapture).toHaveBeenCalledWith(
      expect.objectContaining({ subjectKind: 'gateway', subjectId: 'gw-1' })
    ))
    // …and then straight into publishing it, rather than back to the table to find it.
    expect(await screen.findByLabelText('Publish as')).toBeInTheDocument()
  })

  it('leaves the subject unchosen when the file names nothing this stack knows', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    const doc = {
      acs_capture_version: 1,
      messages: [{ topic: 'spBv1.0/G/NDATA/gwy999999999999999999999', payload: {} }],
      identities: { edge_nodes: ['gwy999999999999999999999'], devices: [] }
    }
    const file = new File([JSON.stringify(doc)], 'foreign.json', { type: 'application/json' })
    fireEvent.drop(screen.getByLabelText('Publish a capture file'), {
      dataTransfer: { files: [file] }
    })
    const subject = await screen.findByLabelText('File it against')
    expect(subject.value).toBe('')
  })
})

// =============================================================================================
describe('the device schema on the panel', () => {
  const SCHEMA = { schema_uuid: 'sch-1', schema_name: 'CNC Mill', version: 2 }

  beforeEach(() => {
    api.get.mockImplementation(path => {
      if (path.includes('schemas')) return Promise.resolve([SCHEMA])
      if (path.includes('gateways')) return Promise.resolve([GATEWAY, SIM_GATEWAY])
      return Promise.resolve([{ ...DEVICE, schema_id: 'sch-1' }, UNBOUND_DEVICE])
    })
  })

  const openDevice = async () => {
    renderTab({ onSelectSchema: vi.fn() })
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    selectRow((await screen.findByText('CNC Spindle')).closest('tr'))
  }

  it('names the schema as a button that navigates', async () => {
    const onSelectSchema = vi.fn()
    renderTab({ onSelectSchema })
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    selectRow((await screen.findByText('CNC Spindle')).closest('tr'))

    const button = screen.getByRole('button', { name: /CNC Mill/ })
    fireEvent.click(button)
    expect(onSelectSchema).toHaveBeenCalledWith('sch-1')
  })

  /** "Unmodelled" is a state the Devices page names and an operator acts on, not a blank field. */
  it('says Unmodelled when nothing is attached', async () => {
    api.get.mockImplementation(path => {
      if (path.includes('schemas')) return Promise.resolve([SCHEMA])
      if (path.includes('gateways')) return Promise.resolve([GATEWAY, SIM_GATEWAY])
      return Promise.resolve([DEVICE, UNBOUND_DEVICE])
    })
    await openDevice()
    expect(screen.getByText('Unmodelled')).toBeInTheDocument()
  })

  /** A gateway has no schema, so the field must not appear at all rather than read "Unmodelled". */
  it('does not offer the field for a gateway', async () => {
    renderTab({ onSelectSchema: vi.fn() })
    selectRow((await screen.findByText('Line 1 Gateway')).closest('tr'))
    expect(screen.queryByText('Schema')).not.toBeInTheDocument()
  })
})

// =============================================================================================
describe('the gateway filter', () => {
  it('is offered only on the Devices tab', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    // On Gateways it would filter a list of gateways by gateway.
    expect(screen.queryByLabelText('Gateway filter')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    expect(await screen.findByLabelText('Gateway filter')).toBeInTheDocument()
  })

  it('narrows the devices to one gateway', async () => {
    api.get.mockImplementation(path =>
      Promise.resolve(path.includes('gateways')
        ? [GATEWAY, SIM_GATEWAY]
        : [DEVICE, { ...DEVICE, id: 'dev-3', name: 'Other Device', gateway_id: 'gw-2' }]))
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    expect(await screen.findByText('Other Device')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Gateway filter'), { target: { value: 'gw-1' } })
    expect(screen.getByText('CNC Spindle')).toBeInTheDocument()
    expect(screen.queryByText('Other Device')).not.toBeInTheDocument()
  })
})

// =============================================================================================
describe('the storage path', () => {
  /**
   * Deterministic: a timestamped path would leave the previous file behind on every re-record, and
   * the gate derives this same string, so a path composed differently is refused by RLS.
   */
  it('is one file per subject, derived from the subject alone', () => {
    expect(capturePath('gwy120000000000400080000')).toBe('gwy120000000000400080000/capture.json')
    expect(capturePath('dev270000000000400080000')).toBe('dev270000000000400080000/capture.json')
  })
})


// =============================================================================================
/**
 * The capture preview in the context panel: deciding whether a capture is the one you want before
 * starting a job. Every field comes from the manifest `capture_worker.py` records.
 */
describe('the capture preview', () => {
  const withManifest = (manifest) => ({ ...CAPTURE, manifest: { ...CAPTURE.manifest, ...manifest } })

  const openCapture = async (capture) => {
    api.listCaptures.mockResolvedValue([capture])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    return selectRow(row)
  }

  it('lists the devices a playback will create lanes for', async () => {
    // ensure_shadow_devices() mints one lane per device this capture recorded, so this list is
    // exactly what a playback brings into being.
    await openCapture(withManifest({ device_ids: ['dev220000000000400080000', 'dev230000000000400080000'] }))
    expect(await screen.findByText('Devices In This Capture')).toBeInTheDocument()
    expect(screen.getByText('dev220000000000400080000')).toBeInTheDocument()
    expect(screen.getByText('dev230000000000400080000')).toBeInTheDocument()
  })

  it('says a replay republishes under the Playback gateway, not the recorded edge node', async () => {
    // The property that stops a recording being mistaken for live plant data. An operator reading
    // the recorded edge node could otherwise reasonably expect the replay to appear under it.
    await openCapture(withManifest({
      device_ids: ['dev220000000000400080000'], edge_node_ids: ['gwy120000000000400080000'],
    }))
    expect(await screen.findByText(/republishes under the Playback gateway/i)).toBeInTheDocument()
  })

  it('reports the recorded rate, which is what says how long a replay takes', async () => {
    // Message count alone does not: 6 messages is seconds at 2/s and minutes at 0.01/s, and a
    // playback follows the recorded pace unless the speed is changed.
    await openCapture(withManifest({ observed_rate_hz: 2.5 }))
    expect(await screen.findByText('2.5 msg/s')).toBeInTheDocument()
  })

  it('omits the rate rather than showing a blank row when it was not recorded', async () => {
    // An uploaded capture may carry no manifest rate at all. A "Recorded rate: —" row would read
    // as a measurement of zero rather than an absent field.
    await openCapture(withManifest({ observed_rate_hz: undefined }))
    await screen.findByText('Birth certificate')
    expect(screen.queryByText(/msg\/s/)).toBeNull()
  })

  it('says when a birth was obtained by interrupting the plant for a rebirth', async () => {
    // Both states are complete captures; only one asked the edge node for something. Worth knowing
    // when the same subject is recorded repeatedly.
    await openCapture(withManifest({ birth_captured: true, rebirth_requested: true }))
    const birth = await screen.findByText('Birth certificate')
    expect(birth.closest('div').textContent).toMatch(/Captured/)
    expect(screen.getByTitle(/requesting a rebirth/i)).toBeInTheDocument()
  })

  it('still renders the panel for a capture whose manifest holds no devices', async () => {
    // Uploaded captures and older recordings predate some of these keys. The panel must degrade to
    // what it has rather than failing, which is the ordinary case for a manifest field.
    await openCapture(withManifest({ device_ids: undefined }))
    expect(await screen.findByText('Captured Metrics')).toBeInTheDocument()
    expect(screen.queryByText('Devices In This Capture')).toBeNull()
  })
})


// =============================================================================================
describe('the playback progress bar', () => {
  const running = (overrides = {}) => ({
    id: 'pb-1', status: 'RUNNING', target_edge_node_id: 'gwy130000000000400080000',
    gateways: { name: 'Playback Target' }, speed: 1,
    messages_sent: 25, messages_total: 100, elapsed_seconds: 12, ...overrides,
  })

  it('draws a bar against the capture total, which a capture card cannot', async () => {
    // A recording stops at whichever of three caps binds first, so the capture card deliberately
    // bars only the clock. A playback has one total, so the fraction means what it looks like.
    api.activePlaybackJob.mockResolvedValue(running())
    renderTab()
    const bar = await screen.findByRole('progressbar', { name: /Messages published/i })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('draws no bar for a queued job, which has no total yet', async () => {
    // `messages_total` is written by the worker's first progress call. A bar at 0% with no
    // denominator would say "nothing has happened" where the truth is "nothing measured yet".
    api.activePlaybackJob.mockResolvedValue(running({ status: 'PENDING', messages_total: 0, messages_sent: 0 }))
    renderTab()
    await screen.findByText(/Waiting for the playback worker/i)
    expect(screen.queryByRole('progressbar', { name: /Messages published/i })).toBeNull()
  })

  it('does not overflow when the worker reports more than the plan held', async () => {
    // messages_sent is the worker's count and messages_total the plan's; a late progress call can
    // arrive after the last publish. The bar must clamp rather than render past its track.
    api.activePlaybackJob.mockResolvedValue(running({ messages_sent: 140, messages_total: 100 }))
    renderTab()
    const bar = await screen.findByRole('progressbar', { name: /Messages published/i })
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    expect(bar.firstChild.style.width).toBe('100%')
  })
})
