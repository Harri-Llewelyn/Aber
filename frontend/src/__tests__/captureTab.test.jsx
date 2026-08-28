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
      deleteCapture: vi.fn()
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

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(path =>
    Promise.resolve(path.includes('gateways') ? [GATEWAY, SIM_GATEWAY] : [DEVICE, UNBOUND_DEVICE]))
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
})

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
    expect(within(row).getByText('None')).toBeInTheDocument()
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
    expect(within(gatewayRow).getByText('None')).toBeInTheDocument()

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
    fireEvent.click(within(row).getByRole('button', { name: /Capture/ }))

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
    fireEvent.click(within(row).getByRole('button', { name: /Capture/ }))

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
    fireEvent.click(within(row).getByRole('button', { name: /Capture/ }))
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
    fireEvent.click(within(row).getByRole('button', { name: /Capture/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Start recording/ }))

    expect(await screen.findByText(/already recording/)).toBeInTheDocument()
  })

  it('tells a device capture that it also takes the gateway birth certificate', async () => {
    renderTab()
    await screen.findByText('Line 1 Gateway')
    fireEvent.click(screen.getByRole('tab', { name: /Devices/ }))
    const row = (await screen.findByText('CNC Spindle')).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: /Capture/ }))
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
  it('disables every Capture button while one is running', async () => {
    api.activeCaptureJob.mockResolvedValue(JOB)
    renderTab()
    const row = (await screen.findByText('Playback Target')).closest('tr')
    const button = within(row).getByRole('button', { name: /Capture/ })
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
    fireEvent.click(within(row).getByTitle('Delete this capture'))
    const message = await screen.findByText(/Delete the capture recorded/)
    expect(message).toHaveTextContent('pre-trip bearing vibration baseline')
  })

  it('passes the whole capture to the delete, not just a path', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.deleteCapture.mockResolvedValue()
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    fireEvent.click(within(row).getByTitle('Delete this capture'))
    fireEvent.click(await screen.findByRole('button', { name: /Delete capture/ }))
    await waitFor(() => expect(api.deleteCapture).toHaveBeenCalledWith(CAPTURE))
  })

  it('opens a signed URL to download', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    api.captureUrl.mockResolvedValue('https://example.test/signed')
    const open = vi.spyOn(window, 'open').mockImplementation(() => {})
    renderTab()
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    fireEvent.click(within(row).getByTitle('Download the capture file'))
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
    expect(within(row).getByTitle('Download the capture file')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /Capture/ })).not.toBeInTheDocument()
    expect(within(row).queryByTitle('Delete this capture')).not.toBeInTheDocument()
    expect(screen.getByText(/require Administrator or Shopfloor Manager/)).toBeInTheDocument()
  })

  it('offers a Shopfloor Manager the write actions', async () => {
    api.listCaptures.mockResolvedValue([CAPTURE])
    renderTab({ userRole: 'Shopfloor_Manager' })
    const row = (await screen.findByText('Line 1 Gateway')).closest('tr')
    expect(within(row).getByRole('button', { name: /Capture/ })).toBeInTheDocument()
    expect(within(row).getByTitle('Delete this capture')).toBeInTheDocument()
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
