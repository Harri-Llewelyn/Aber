import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { downloadJSON } from '../utils/downloadJSON'
import { downloadBlob } from '../utils/downloadBlob'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

// Spied rather than stubbed: the assertion is that the button hands the *shell* to the download
// helper under the right filename, not that some download happened.
vi.mock('../utils/downloadJSON', () => ({ downloadJSON: vi.fn() }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))

const DEVICE = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000', status: 'ONLINE', is_quarantined: false,
  is_archived: false, active_gateway_id: 'gw-1', cell_id: 'cell-1', schema_id: 'schema-cnc',
  first_dbirth_at: '2026-07-27T12:00:00Z', created_at: '2026-07-20T12:00:00Z'
}

const AAS_RESULT = {
  success: true,
  device: { id: DEVICE.asset_id, name: 'CNC_01', sparkplug_id: DEVICE.sparkplug_id },
  stats: { submodels: 3, telemetry_metrics: 11, kpi_metrics: 3, unmapped_semantic_ids: 0 },
  aas: {
    assetAdministrationShells: [{ modelType: 'AssetAdministrationShell', idShort: 'CNC_01' }],
    submodels: [{ idShort: 'DigitalNameplate' }],
    conceptDescriptions: []
  }
}

const routeGet = (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([DEVICE])
  return Promise.resolve([])
}

/**
 * The device panel offers one Export… action, which opens DeviceExportModal. What is asserted is the
 * request each format issues, the file it writes and what the dialog withholds.
 */
const openPanel = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(DEVICE.asset_name))
  return within(document.querySelector('.context-panel'))
}
const openExport = () => {
  fireEvent.click(openPanel().getByRole('button', { name: /Export…/ }))
  return within(screen.getByRole('dialog'))
}
const FORMAT_NAME = { json: /AAS JSON/, aasx: /AASX package/, bundle: /Bundle/ }
const chooseFormat = (format) => {
  const dialog = openExport()
  fireEvent.click(dialog.getByRole('radio', { name: FORMAT_NAME[format] }))
  fireEvent.click(dialog.getByRole('button', { name: 'Export' }))
  return dialog
}

const renderDevices = (showToast = vi.fn(), hasPermission = () => true, devices = [DEVICE]) => {
  api.get.mockImplementation((path) => (path.startsWith('/api/v1/devices') ? Promise.resolve(devices) : routeGet(path)))
  render(<DevicesTab showToast={showToast} onSelectDevice={() => {}} hasPermission={hasPermission} />)
  return showToast
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(routeGet)
  api.post.mockResolvedValue(AAS_RESULT)
})

describe('the Export… action', () => {
  it('is one action in the device drawer, in place of one per format', async () => {
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    const items = openPanel().getAllByRole('button').map(i => i.textContent)
    expect(items.filter(t => /Export/.test(t))).toEqual([expect.stringMatching(/^\s*Export…$/)])
  })

  it('opens a dialog offering the three formats, JSON chosen', async () => {
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    const dialog = openExport()
    expect(dialog.getAllByRole('radio')).toHaveLength(3)
    expect(dialog.getByRole('radio', { name: /AAS JSON/ })).toBeChecked()
    expect(dialog.getByText(/A copy is kept beside the cold tier/)).toBeInTheDocument()
  })

  it('is available without the manage permission — an export is a read', async () => {
    renderDevices(vi.fn(), () => false)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    // Enabled even for a role that cannot manage the device, unlike Edit and Archive beside it.
    const action = openPanel().getByRole('button', { name: /Export…/ })
    expect(action).toBeEnabled()
    fireEvent.click(action)
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('radio', { name: /AAS JSON/ })).toBeEnabled()
    expect(dialog.getByRole('radio', { name: /AASX package/ })).toBeEnabled()
  })

  it('composes the document server-side rather than in the browser', async () => {
    // The shell needs the service role to read asset_config and the whole metric_catalog;
    // building it client-side would push that read surface into every signed-in browser.
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/devices/aas-export', { device_id: DEVICE.asset_id, format: 'json' }
    ))
  })

  it('downloads the AAS environment under the device name, not the wrapper the function returns', async () => {
    // `aas` is the AAS Part 5 Environment; the surrounding stats/device keys are transport, and a
    // consumer handed the whole envelope would reject it.
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(downloadJSON).toHaveBeenCalledWith(AAS_RESULT.aas, 'CNC_01_aas_v3.json'))
    const [payload] = downloadJSON.mock.calls[0]
    expect(payload).toHaveProperty('assetAdministrationShells')
    expect(payload).not.toHaveProperty('stats')
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('reports what was exported and closes the dialog', async () => {
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('3 submodels, 11 metrics'), 'success'
    ))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a failure in the dialog, downloads nothing, and can be retried', async () => {
    api.post.mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    const dialog = chooseFormat('json')

    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Forbidden: Insufficient privileges'))
    expect(downloadJSON).not.toHaveBeenCalled()
    expect(dialog.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  it('requests the aasx format and downloads the package under a .aasx name', async () => {
    const AASX_RESULT = {
      blob: new Blob(['PK'], { type: 'application/asset-administration-shell-package+xml' }),
      stats: { submodels: 3, telemetry_metrics: 11, kpi_metrics: 3, unmapped_semantic_ids: 0 },
      format: 'aasx'
    }
    api.post.mockResolvedValue(AASX_RESULT)
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('aasx')

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/devices/aas-export', { device_id: DEVICE.asset_id, format: 'aasx' }
    ))
    // downloadJSON re-serialises whatever it is given; handing it a ZIP produces a corrupt file.
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(AASX_RESULT.blob, 'CNC_01.aasx'))
    expect(downloadJSON).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('AASX package exported'), 'success')
  })
})

/**
 * The bundle carries the device's Audit Trail, and aas-export refuses it to a caller without
 * `audit_trail:read`. The dialog shows it disabled, with the reason, as it does on a replay lane.
 */
describe('the Bundle format', () => {
  const bundleRadio = (dialog) => dialog.getByRole('radio', { name: /Bundle/ })

  it('is offered to a role that holds audit_trail:read, even without the manage permissions', async () => {
    // The Auditor's grant: the trail and nothing else.
    renderDevices(vi.fn(), (p) => p === PERMISSION_UUIDS.AUDIT_TRAIL_READ)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    expect(bundleRadio(openExport())).toBeEnabled()
  })

  it('is disabled, with the reason, for a role without it, which keeps both plain exports', async () => {
    // The Operator's grants: telemetry, the quarantine view and proposals.
    const operator = [PERMISSION_UUIDS.TELEMETRY_READ, PERMISSION_UUIDS.QUARANTINE_VIEW, PERMISSION_UUIDS.PROPOSAL_CREATE]
    renderDevices(vi.fn(), (p) => operator.includes(p))
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    const dialog = openExport()
    expect(bundleRadio(dialog)).toBeDisabled()
    expect(bundleRadio(dialog)).toHaveAccessibleDescription(/carries the Audit Trail\. Requires /)
    expect(dialog.getByRole('radio', { name: /AAS JSON/ })).toBeEnabled()
    expect(dialog.getByRole('radio', { name: /AASX package/ })).toBeEnabled()
  })

  it('is disabled, with the reason, on a replay lane, which keeps both plain exports', async () => {
    renderDevices(vi.fn(), () => true, [{ ...DEVICE, shadow_of: 'bbbbbbbb-0000-4000-8000-000000000002' }])
    await waitFor(() => expect(document.querySelector('.loading-wrap')).toBeNull())
    // Replay lanes are hidden by default; the popover's toggle shows them.
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    fireEvent.click(screen.getByRole('button', { name: /Show replay lanes/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    const dialog = openExport()
    expect(bundleRadio(dialog)).toBeDisabled()
    expect(bundleRadio(dialog)).toHaveAccessibleDescription(/replay lane is a recording of a device/)
    expect(dialog.getByRole('radio', { name: /AASX package/ })).toBeEnabled()
  })

  it('posts the device to the bundle route when offered', async () => {
    api.post.mockResolvedValue({ blob: new Blob(['PK']), filename: 'CNC_01-bundle.aasx', stats: { bundle: { stored: true } } })
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    chooseFormat('bundle')
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/devices/asset-export', { device_id: DEVICE.asset_id }
    ))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'CNC_01-bundle.aasx'))
  })
})
