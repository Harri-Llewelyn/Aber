import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { captureManifest, capturePath } from '../api'
import { tabIsVisible, navDensity, TABS } from '../App'

/**
 * The Capture page.
 *
 * WHAT THIS PROTECTS. Everything here is a decision an operator makes from what the page tells
 * them, and two of those decisions are destructive or unrecoverable:
 *
 *   1. THE REPLACE CONFIRMATION HAS TO NAME WHAT IT DESTROYS. "A new recording replaces the old" is
 *      what bounds the bucket, and the cost is that a capture of a rare fault can be destroyed by a
 *      routine re-record. The dialog is the only thing standing there, and a dialog that says "are
 *      you sure" does not do the job -- so the tests assert the timestamp AND the note are in it.
 *
 *   2. `birth_captured = false` HAS TO BE VISIBLE ON THE LIST. A capture with no NBIRTH replays as
 *      `unresolved_alias` against an alias-optimised gateway and drops every metric, from a file
 *      whose size and message count look entirely normal. If the badge is missing, nothing else on
 *      the page distinguishes the two.
 *
 * The rest is the shape the daemon and the schema require: a device capture is a subject in its own
 * right, one capture runs at a time, and the page never records anything itself.
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
 * Select a row, which is what opens the details panel.
 *
 * THE ACTIONS ARE NOT IN THE ROW ANY MORE. They were five controls in a last column, and
 * `.table-wrap` is `overflow-x: auto`, so they were the first thing to go off the right-hand edge
 * on a narrow viewport. They live in the ContextPanel now, which also has room to say WHY one is
 * unavailable.
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
})

const TARGET = {
  id: 'gw-sim', name: 'Playback Target', sparkplug_id: 'gwy130000000000400080000',
  sparkplug_group: 'ACS-Cymru', is_archived: false, gateway_has_broker_credential: true,
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
   * A device with no gateway has no edge node to record from and no node to ask for a rebirth, and
   * `start_capture_job()` refuses it. A row that exists only to be refused invites the click.
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
describe('a stored capture', () => {
  it('shows its size, message count and note', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText(/6 messages/)).toBeInTheDocument()
    expect(within(row).getByText(/pre-trip bearing vibration baseline/)).toBeInTheDocument()
  })

  /**
   * THE ONE BADGE THAT CHANGES A DECISION. Without it a capture that will drop every metric on
   * playback is indistinguishable from one that will not.
   */
  it('marks a capture that recorded no birth certificate', async () => {
    api.listCaptures.mockResolvedValue([
      { ...CAPTURE, manifest: { ...CAPTURE.manifest, birth_captured: false } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByText('NO BIRTH')).toBeInTheDocument()
    expect(within(row).getByTitle(/unresolved_alias/)).toBeInTheDocument()
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

  /**
   * THE DESTROY-A-RARE-FAULT GUARD, and the whole reason `captures.note` exists. A dialog that
   * asked "are you sure" would pass a test that only checked a dialog appeared.
   */
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
   * verbatim in the dialog that asked rather than replaced with something friendlier elsewhere.
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
    messages: 120, bytes: 45000, elapsed_seconds: 3, max_seconds: 600, birth_captured: true
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

  /**
   * A capture can finish between the click and the call. That is not a failure, and reporting one
   * for something that did exactly what was asked would be wrong.
   */
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
      error: 'recorded no messages from ACS-Cymru/gwy120000000000400080000'
    }])
    renderTab()
    expect(await screen.findByText(/recorded no messages/)).toBeInTheDocument()
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
    // SCOPED TO THE DIALOG. The panel's action and the confirmation's button now carry the same
    // name -- deliberately, since "Delete capture" is the clearest label for both -- so an
    // unscoped query matches two elements and clicks whichever came first.
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
   * Auditor can read the bucket and both tables and can do nothing else, and the page says so
   * rather than offering buttons that answer 42501.
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
   * THE TWELFTH TAB. `navDensity`'s `tight` band was written for a page that did not exist; this is
   * the page, and an Administrator now sees twelve.
   */
  it('takes an Administrator into the tight nav band', () => {
    const visible = TABS.filter(t => tabIsVisible(t, () => true, 'Administrator'))
    expect(visible.length).toBeGreaterThanOrEqual(12)
    expect(navDensity(visible.length)).toBe('tight')
  })
})

// =============================================================================================
describe('the manifest the browser builds for an uploaded capture', () => {
  /**
   * The other half of a contract `capture_worker._manifest()` writes. If the two disagree, an
   * uploaded capture shows blank beside a recorded one and the column reads as broken.
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
   * THE IDS THE PLAYBACK DIALOG BUILDS ITS DEVICE MAP FROM. Without them that dialog would have to
   * download a file of up to 100 MiB to populate a select.
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
   * ONLY SIMULATED GATEWAYS ARE OFFERED, because `start_playback_job()` refuses anything else.
   * Listing a real gateway would be offering a click that is always refused — and the refusal is
   * the last line of defence against synthetic telemetry on a real machine's identity, not a
   * validation message.
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
   * THE DEVICE MAP FROM DROPDOWNS, which is the thing the CLI cannot do: `capture.py play` needs
   * `--map dev…=dev…` typed by hand for every captured device.
   */
  it('builds the device map from the devices bound to the target', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Publish as'), { target: { value: 'gw-sim' } })
    const mapSelect = await screen.findByLabelText('Target device for dev270000000000400080000')
    expect(within(mapSelect).getByText(/Sim Spindle/)).toBeInTheDocument()
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
   * Changing the target must clear the map: a device id from the previous gateway is exactly what
   * the gate refuses, and carrying one over silently turns a dropdown change into a refusal the
   * operator did not cause.
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

  it('warns that a birthless capture will replay as unresolved aliases', async () => {
    api.listCaptures.mockResolvedValue([
      { ...PLAYABLE, manifest: { ...PLAYABLE.manifest, birth_captured: false } }
    ])
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    selectRow(row); fireEvent.click(panelAction(/Play back/))
    expect(await screen.findByText(/unresolved_alias/)).toBeInTheDocument()
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

  /**
   * THE DROP ZONE KNOWS ITS SUBJECT, which is why it lives here rather than on the page. The
   * page-level one it replaces had to ask which subject a dropped file belonged to.
   */
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
   * DROP, STORE, PUBLISH -- the loop item 17 §6 invites by keeping the format hand-editable.
   * The subject is GUESSED from the identities in the file and offered, never filed silently.
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
   * DETERMINISTIC SINCE 0055. A timestamped path would leave the previous file behind on every
   * re-record, because nothing sweeps the bucket -- and the gate derives this same string, so a
   * path composed differently here is refused by RLS for a reason the filename does not suggest.
   */
  it('is one file per subject, derived from the subject alone', () => {
    expect(capturePath('gwy120000000000400080000')).toBe('gwy120000000000400080000/capture.json')
    expect(capturePath('dev270000000000400080000')).toBe('dev270000000000400080000/capture.json')
  })
})
