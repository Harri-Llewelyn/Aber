import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceExportModal } from '../components/modals/DeviceExportModal'
import { api } from '../api'
import { downloadJSON } from '../utils/downloadJSON'
import { downloadBlob } from '../utils/downloadBlob'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})
vi.mock('../utils/downloadJSON', () => ({ downloadJSON: vi.fn() }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))

/**
 * The export dialog on its own, as both of its callers use it: the Devices panel (a live device,
 * JSON chosen) and Archived Entities (an archived device by its entity id, Bundle chosen). It runs
 * the export itself and closes on success; a failure stays in it.
 */

const DEVICE = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'CNC_01' }
const BUNDLE_OK = { blob: new Blob(['PK']), filename: 'CNC_01-bundle-2026-10-03.aasx', stats: { bundle: { stored: true, raw_rows: 5, hourly_rows: 2, trail_rows: 9, cold_objects: 1 } } }

const open = (props = {}) => {
  const onClose = vi.fn()
  const showToast = vi.fn()
  render(<DeviceExportModal device={DEVICE} onClose={onClose} showToast={showToast} {...props} />)
  return { onClose, showToast, dialog: within(screen.getByRole('dialog')) }
}
const radio = (dialog, name) => dialog.getByRole('radio', { name })
const exportButton = (dialog) => dialog.getByRole('button', { name: 'Export' })

beforeEach(() => vi.clearAllMocks())

describe('DeviceExportModal', () => {
  it('names the device and offers the three formats as one choice', () => {
    const { dialog } = open()
    expect(screen.getByRole('dialog', { name: 'Export CNC_01' })).toBeInTheDocument()
    expect(dialog.getByRole('radiogroup', { name: 'Format' })).toBeInTheDocument()
    expect(dialog.getAllByRole('radio').map(r => r.value)).toEqual(['json', 'aasx', 'bundle'])
    expect(radio(dialog, /AAS JSON/)).toBeChecked()
    expect(radio(dialog, /Bundle/)).toHaveAccessibleDescription(/A copy is kept beside the cold tier/)
  })

  it('opens on the format its caller chose', () => {
    const { dialog } = open({ initialFormat: 'bundle' })
    expect(radio(dialog, /Bundle/)).toBeChecked()
  })

  it('disables a withheld bundle with its reason, and opens on JSON instead', () => {
    const { dialog } = open({ initialFormat: 'bundle', bundleDisabledReason: 'Requires Auditor.' })
    expect(radio(dialog, /Bundle/)).toBeDisabled()
    expect(radio(dialog, /Bundle/)).toHaveAccessibleDescription(/Not available: Requires Auditor\./)
    expect(radio(dialog, /AAS JSON/)).toBeChecked()
  })

  it('takes the bundle of an archived device by the id it is handed, then closes', async () => {
    api.post.mockResolvedValue(BUNDLE_OK)
    const { dialog, onClose, showToast } = open({ initialFormat: 'bundle' })

    fireEvent.click(exportButton(dialog))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.post).toHaveBeenCalledWith('/api/v1/devices/asset-export', { device_id: DEVICE.id })
    expect(downloadBlob).toHaveBeenCalledWith(BUNDLE_OK.blob, BUNDLE_OK.filename)
    expect(showToast).toHaveBeenCalledWith(
      "Bundle exported for 'CNC_01' (5 raw and 2 hourly readings, 9 audit trail rows, 1 cold object named)", 'success'
    )
  })

  it('names the bundle after the device when the function gives no filename', async () => {
    api.post.mockResolvedValue({ blob: BUNDLE_OK.blob, stats: { bundle: { stored: true } } })
    const { dialog } = open({ initialFormat: 'bundle' })
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(BUNDLE_OK.blob, 'CNC_01-bundle.aasx'))
  })

  it('warns when the bundle was downloaded but not stored on the platform', async () => {
    api.post.mockResolvedValue({ ...BUNDLE_OK, stats: { bundle: { stored: false, reason: 'cold tier unreachable' } } })
    const { dialog, showToast } = open({ initialFormat: 'bundle' })
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/NOT stored on the platform: cold tier unreachable\. Keep the file\./), 'warning'
    ))
  })

  it('gives the reference the function logged the storage failure under', async () => {
    const stats = { bundle: { stored: false, reason: 'the server could not store it', request_id: 'req-0001-abcd' } }
    api.post.mockResolvedValue({ ...BUNDLE_OK, stats })
    const { dialog, showToast } = open({ initialFormat: 'bundle' })
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/could not store it\. Keep the file\. Reference: req-0001-abcd$/), 'warning'
    ))
  })

  it('warns when a cap was reached', async () => {
    api.post.mockResolvedValue({ ...BUNDLE_OK, stats: { bundle: { stored: true, truncated: true } } })
    const { dialog, showToast } = open({ initialFormat: 'bundle' })
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/a cap was reached/), 'warning'))
  })

  it('warns about metrics that carried no semantic id', async () => {
    api.post.mockResolvedValue({ aas: {}, stats: { submodels: 2, telemetry_metrics: 4, unmapped_semantic_ids: 2 } })
    const { dialog, showToast } = open()
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('2 metrics carried no semantic id'), 'warning'
    ))
  })

  it('reports the model URL warning ahead of unmapped metrics', async () => {
    api.post.mockResolvedValue({ aas: {}, stats: { unmapped_semantic_ids: 2 }, warning: 'the 3D model URL is loopback' })
    const { dialog, showToast } = open()
    fireEvent.click(exportButton(dialog))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "AAS JSON exported for 'CNC_01' — the 3D model URL is loopback", 'warning'
    ))
  })

  it('holds the dialog open, its choices fixed, while the export runs', async () => {
    let finish
    api.post.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { dialog, onClose } = open()

    fireEvent.click(exportButton(dialog))

    const busy = await dialog.findByRole('button', { name: /Exporting…/ })
    expect(busy).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(radio(dialog, /AASX package/)).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()

    finish({ aas: {}, stats: {} })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(downloadJSON).toHaveBeenCalledWith({}, 'CNC_01_aas_v3.json')
  })

  it('keeps a failure in the dialog, downloads nothing and stays open for a retry', async () => {
    api.post.mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    const { dialog, onClose, showToast } = open({ initialFormat: 'aasx' })

    fireEvent.click(exportButton(dialog))

    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Forbidden: Insufficient privileges'))
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(exportButton(dialog)).toBeEnabled()

    // Choosing again clears the old failure.
    fireEvent.click(radio(dialog, /AAS JSON/))
    expect(dialog.queryByRole('alert')).toBeNull()
  })

  it('closes on Cancel without exporting', () => {
    const { dialog, onClose } = open()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalled()
  })
})
