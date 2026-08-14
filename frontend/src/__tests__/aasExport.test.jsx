import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
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
 * Both export formats are actions on the device's context panel.
 *
 * They have moved twice: from a <select> that faked a menu (value="" plus a self-resetting
 * onChange), to a real overflow menu on the row, to the drawer -- which is where every other
 * per-device action ended up when the ACTIONS column was removed. What is asserted below is the
 * request each one issues and the file it writes, none of which changed.
 */
const openPanel = () => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(DEVICE.asset_name))
  return within(document.querySelector('.context-panel'))
}
const chooseFormat = (format) => {
  fireEvent.click(openPanel().getByText(
    format === 'aasx' ? /Export AASX package/i : /Export AAS JSON/i
  ))
}

const renderDevices = (showToast = vi.fn()) => {
  render(<DevicesTab showToast={showToast} onSelectDevice={() => {}} hasPermission={() => true} />)
  return showToast
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(routeGet)
  api.post.mockResolvedValue(AAS_RESULT)
})

describe('Export AAS action', () => {
  it('offers both formats on every device row', async () => {
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    const items = openPanel().getAllByRole('button').map(i => i.textContent)
    expect(items.some(t => /Export AAS JSON/i.test(t))).toBe(true)
    expect(items.some(t => /Export AASX package/i.test(t))).toBe(true)
  })

  it('is available without the manage permission — an export is a read', async () => {
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={() => {}} hasPermission={() => false} />)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    const panel = openPanel()
    // Enabled even for a role that cannot manage the device, unlike Edit and Archive beside it.
    for (const name of [/Export AAS JSON/i, /Export AASX package/i]) {
      expect(panel.getByText(name).closest('button').disabled).toBe(false)
    }
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

  it('downloads the shell under the device name', async () => {
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(downloadJSON).toHaveBeenCalledWith(
      AAS_RESULT.aas, 'CNC_01_aas_v3.json'
    ))
  })

  it('downloads the AAS environment, not the wrapper the function returns', async () => {
    // `aas` is the AAS Part 5 Environment; the surrounding stats/device keys are transport, and a
    // consumer handed the whole envelope would reject it.
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(downloadJSON).toHaveBeenCalled())
    const [payload] = downloadJSON.mock.calls[0]
    expect(payload).toHaveProperty('assetAdministrationShells')
    expect(payload).not.toHaveProperty('stats')
  })

  it('reports what was exported', async () => {
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('3 submodels, 11 metrics'), 'success'
    ))
  })

  it('warns when metrics carried no semantic id, rather than failing silently', async () => {
    // Unmapped is a legitimate state, so this is a warning — but an invisible gap in an export's
    // usefulness is worse than a noisy one.
    api.post.mockResolvedValue({
      ...AAS_RESULT,
      stats: { ...AAS_RESULT.stats, unmapped_semantic_ids: 2 }
    })
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('2 metrics carried no semantic id'), 'warning'
    ))
  })

  it('surfaces a failure and downloads nothing', async () => {
    api.post.mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Forbidden: Insufficient privileges', 'error'
    ))
    expect(downloadJSON).not.toHaveBeenCalled()
  })

  it('re-enables the menu after a failure, so the export can be retried', async () => {
    api.post.mockRejectedValue(new Error('boom'))
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    // Both export actions are disabled while exporting (and labelled "Exporting AAS…"); a failure
    // must clear that rather than leaving the device permanently unable to retry.
    await waitFor(() =>
      expect(openPanel().getByText(/Export AAS JSON/i).closest('button').disabled).toBe(false))
  })
})

describe('Export AAS — AASX package', () => {
  const AASX_RESULT = {
    blob: new Blob(['PK'], { type: 'application/asset-administration-shell-package+xml' }),
    stats: { submodels: 3, telemetry_metrics: 11, kpi_metrics: 3, unmapped_semantic_ids: 0 },
    format: 'aasx'
  }

  it('requests the aasx format and downloads the package under a .aasx name', async () => {
    api.post.mockResolvedValue(AASX_RESULT)
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('aasx')

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/devices/aas-export', { device_id: DEVICE.asset_id, format: 'aasx' }
    ))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(AASX_RESULT.blob, 'CNC_01.aasx'))
  })

  it('never routes the package through downloadJSON', async () => {
    // downloadJSON re-serialises whatever it is given; handing it a ZIP produces a corrupt file.
    api.post.mockResolvedValue(AASX_RESULT)
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('aasx')

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    expect(downloadJSON).not.toHaveBeenCalled()
  })

  it('names the format it exported, so the two are distinguishable in the toast', async () => {
    api.post.mockResolvedValue(AASX_RESULT)
    const showToast = renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('aasx')

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('AASX package exported'), 'success'
    ))
  })

  it('keeps the JSON path on downloadJSON', async () => {
    api.post.mockResolvedValue(AAS_RESULT)
    renderDevices()
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())

    chooseFormat('json')

    await waitFor(() => expect(downloadJSON).toHaveBeenCalled())
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
