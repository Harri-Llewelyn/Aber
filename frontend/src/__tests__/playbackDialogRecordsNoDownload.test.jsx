import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StartPlaybackModal } from '../components/modals/StartPlaybackModal'

/**
 * Opening the playback dialog downloads nothing. `api.captureUrl()` calls
 * `issue_capture_download()`, which writes CAPTURE_DOWNLOAD_ISSUED, so it is called only when a
 * person asks for the file. The dialog reads the captured devices from the capture's manifest, as
 * `ensure_shadow_devices()` does, and a capture stored without that list says so instead.
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
const RECORDED = 'dev880000000000400080000'
const TARGET = {
  id: 'gw-playback', name: 'Playback', sparkplug_id: GW, sparkplug_group: 'Aber',
  is_archived: false, status: 'OFFLINE', last_heartbeat: null, gateway_has_broker_credential: true,
  devices: [{ id: 'lane-1', name: 'Lane', sparkplug_id: 'dev770000000000400080000', is_archived: false, shadow_of: 'd-1' }]
}
/** A capture whose manifest carries no device list: stored before it carried one, or by an API caller. */
const LISTLESS = {
  id: 'cap-old', note: 'before the list', message_count: 5, subject_sparkplug_id: RECORDED,
  storage_path: `${RECORDED}/capture.json`,
  manifest: { birth_captured: true, metric_names: ['Spindle_Speed'] }
}

let fetchSpy
beforeEach(() => {
  vi.clearAllMocks()
  api.playbackTargets.mockResolvedValue([TARGET])
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [GW], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
  api.captureUrl.mockResolvedValue('https://example.test/signed')
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
})
afterEach(() => { fetchSpy.mockRestore() })

/** The dialog once its reads have settled. */
async function openDialog(capture, onCancel = vi.fn()) {
  render(<StartPlaybackModal capture={capture} onConfirm={vi.fn()} onCancel={onCancel} />)
  await screen.findByLabelText('Playback gateway')
  await waitFor(() => expect(api.playbackWorkerStatus).toHaveBeenCalled())
  return onCancel
}

describe('opening the playback dialog', () => {
  it.each([
    ['no device list', LISTLESS],
    ['a device list that is not a list', { ...LISTLESS, manifest: { device_ids: RECORDED } }],
    ['no manifest', { ...LISTLESS, manifest: null }],
  ])('on a capture with %s issues no download, and cancelling issues none either', async (_, capture) => {
    const onCancel = await openDialog(capture)
    fireEvent.change(screen.getByLabelText('Playback gateway'), { target: { value: TARGET.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(api.captureUrl).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says a capture stored without its device list cannot be mapped, and how to play it', async () => {
    await openDialog(LISTLESS)
    const callout = screen.getByText(/stored without the list of devices it holds/)
    expect(callout.textContent).toMatch(/Download it, then play the file with Play a file…/)
    fireEvent.change(screen.getByLabelText('Playback gateway'), { target: { value: TARGET.id } })
    // No mapping and no lanes to prepare: ensure_shadow_devices() reads the same manifest.
    expect(screen.queryByText(/Device mapping/)).toBeNull()
    expect(screen.queryByText(/Prepare replay lanes/)).toBeNull()
    expect(screen.queryByText(/publishes no device-level traffic/)).toBeNull()
    const start = screen.getByRole('button', { name: 'Play back' })
    expect(start).toBeDisabled()
    expect(start).toHaveAccessibleDescription(/holds no list of its devices/)
  })

  it('maps from the manifest when it holds the list, reading nothing else', async () => {
    await openDialog({ ...LISTLESS, manifest: { birth_captured: true, device_ids: [RECORDED] } })
    fireEvent.change(screen.getByLabelText('Playback gateway'), { target: { value: TARGET.id } })
    expect(await screen.findByLabelText(`Target device for ${RECORDED}`)).toBeInTheDocument()
    expect(screen.queryByText(/stored without the list/)).toBeNull()
    expect(api.captureUrl).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('takes an empty list as a capture of node-level messages only, not as a missing one', async () => {
    await openDialog({ ...LISTLESS, manifest: { birth_captured: true, device_ids: [] } })
    fireEvent.change(screen.getByLabelText('Playback gateway'), { target: { value: TARGET.id } })
    expect(screen.getByText(/publishes no device-level traffic/)).toBeInTheDocument()
    expect(screen.queryByText(/stored without the list/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Play back' })).toBeEnabled()
    expect(api.captureUrl).not.toHaveBeenCalled()
  })
})

/**
 * The one caller. A new call site would record a download wherever it runs, so it has to be an
 * act the person chose; read from the source, as toolbarSearchFirst.test.js reads its toolbars.
 */
describe('the download call', () => {
  const SRC = path.resolve(__dirname, '..')
  const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
    return /\.jsx?$/.test(e.name) ? [p] : []
  })

  it('is made only by the Capture page\'s Download action', () => {
    const callers = sources(SRC)
      .filter(p => /\bcaptureUrl\(/.test(fs.readFileSync(p, 'utf8')))
      .map(p => path.relative(SRC, p).split(path.sep).join('/'))
      .sort()
    expect(callers).toEqual(['components/tabs/CaptureTab.jsx'])
    const page = fs.readFileSync(path.join(SRC, 'components/tabs/CaptureTab.jsx'), 'utf8')
    expect(page.match(/\bcaptureUrl\(/g)).toHaveLength(1)
    expect(page).toMatch(/const onDownload = async \(capture\) => \{[^}]*api\.captureUrl\(capture\.storage_path\)/)
  })
})
