import React from 'react'
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { PERMISSION_UUIDS } from '../constants'
import { pick } from '../test/listFilters'
import { tooltipOf } from '../test/tooltips'
import { __resetModelViewerLoader } from '../components/common/Model3DViewer'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
    model3dPublicUrl: (path) => (path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}` : null),
    model3dDownloadUrl: (path) => (path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}?download=x` : null)
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  // The roster opens on Active, so a fixture holding an archived row asks for All first, from the
  // Filters popover.
  if (rows.some(r => r.is_archived)) {
    fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
    await waitFor(() => pick('Lifecycle', 'active', 'archived'))
  }
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const inRow = () => within(document.querySelector('.page-main'))

/** Every action the row used to hold, now in the panel it opens. Scoped to `.context-panel-actions`. */
const panelLabels = () => {
  openPanel()
  return [...document.querySelectorAll('.context-panel-actions .context-action')]
    .map(b => b.textContent.trim()).join('|')
}

/** Select a device row and return its context panel. */
const openPanel = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => vi.clearAllMocks())

describe('device row actions', () => {
  it('leaves no action controls in the row at all', async () => {
    // The row is identity and state; every action lives in the drawer the row opens.
    await show([device()])

    expect(inRow().queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
    // Readings are not a row control: the panel's View History opens the device's charts.
    expect(inRow().queryByText('Telemetry')).not.toBeInTheDocument()
    expect(openPanel().getByText('View History')).toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Config/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /Audit Trail/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(document.querySelector('[data-testid^="device-actions-"]')).toBeNull()
  })

  it('collects every action in the panel', async () => {
    await show([device()])

    const labels = panelLabels()
    for (const expected of [/Audit Trail/i, /Configuration Parameters/i,
      /Export…/, /Archive Device/i,
      /Digital Nameplate/i, /View History/i, /Edit Details/i]) {
      expect(labels).toMatch(expected)
    }
    // History shows each metric's latest reading and exports them, so the panel has no View Telemetry.
    expect(labels).not.toMatch(/View Telemetry/i)
    // Attached Links opens the editor that lists and attaches links.
    expect(labels).toMatch(/Attached Links/i)
  })

  it('lists Edit Details first as the one primary action, under a title carrying the device icon', async () => {
    await show([device()])
    openPanel()

    const actions = [...document.querySelectorAll('.context-panel-actions .context-action')]
    expect(actions[0].textContent.trim()).toBe('Edit Details')
    expect(actions.filter(a => a.classList.contains('btn-primary'))).toEqual([actions[0]])
    expect(document.querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
  })

  it('replaces Edit with Restore on an archived device', async () => {
    // Restore is the ONLY write that means anything on an archived device, and Edit is refused
    // there anyway -- so the panel offers one or the other, never a disabled pair.
    await show([device({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Device/i)).toBeInTheDocument()
    expect(panel.getByText(/Restore Device/i).closest('button')).toHaveClass('btn-primary')
    expect(panel.queryByText('Edit Details')).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([device({ is_archived: true })])

    expect(panelLabels()).not.toMatch(/Archive Device/i)
  })

  /** Restore asks first, in the dialog Archived Entities' Restore uses, replay lanes and all. */
  describe('Restore Device asks first', () => {
    const openRestore = async () => {
      await show([device({ is_archived: true })])
      fireEvent.click(openPanel().getByText('Restore Device').closest('button'))
      return screen.getByRole('dialog', { name: 'Restore device' })
    }

    it('names the device and says its replay lanes come back with it', async () => {
      const dialog = await openRestore()

      expect(dialog).toHaveAccessibleDescription(expect.stringMatching(/^Restore the device 'CNC_01' to active service\?/))
      expect(dialog).toHaveAccessibleDescription(expect.stringMatching(/Any replay lane recorded from it comes back with it\.$/))
      expect(within(dialog).getByRole('button', { name: 'Restore Device' })).toHaveClass('btn-primary')
      expect(api.post).not.toHaveBeenCalled()
    })

    it('restores nothing when cancelled', async () => {
      const dialog = await openRestore()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog', { name: 'Restore device' })).toBeNull()
      expect(api.post).not.toHaveBeenCalled()
    })

    it('restores the device once, when confirmed', async () => {
      api.post.mockResolvedValue({})
      const dialog = await openRestore()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Device' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restore device' })).toBeNull())
      expect(api.post).toHaveBeenCalledTimes(1)
      expect(api.post).toHaveBeenCalledWith('/api/v1/devices/aaaaaaaa-0000-4000-8000-000000000001/restore', {})
    })
  })

  it('disables the write actions for a role that cannot manage devices', async () => {
    await show([device()], () => false)
    const panel = openPanel()

    const btn = (name) => panel.getByText(name).closest('button')
    expect(btn(/Archive Device/i).disabled).toBe(true)
    expect(btn('Edit Details').disabled).toBe(true)
    // These reads are not gated: an export is a read, and Configuration Parameters shows what the
    // device declared at birth.
    expect(btn(/Export…/).disabled).toBe(false)
    expect(btn(/Configuration Parameters/i).disabled).toBe(false)

    // The audit trace is withdrawn, not disabled: without `audit_trail:read` the page returns no
    // rows rather than an error, and the nav hides it from this reader entirely.
    expect(panel.queryByText(/Audit Trail/i)).toBeNull()
  })

  it('reaches links through the panel action', async () => {
    // Attached Links opens the full editor; the row and the drawer list no links themselves.
    await show([device()])

    expect(inRow().queryByText('Attached Document Links')).toBeNull()

    const panel = openPanel()
    expect(panel.queryByText('Attached Document Links')).toBeNull()
    expect(panel.getByText('Attached Links')).toBeInTheDocument()
  })
})

/* The 3D model is one action, whose label follows the model, and a dialog it opens. The drawer holds
   no viewer and no drop zone, and loads nothing of the model until the action is pressed. */
describe('device 3D model action', () => {
  const PATH = 'aaaaaaaa-0000-4000-8000-000000000001/cnc.glb'
  const operator = (perm) => perm !== PERMISSION_UUIDS.DEVICE_MANAGE
  const actionButtons = () => [...document.querySelectorAll('.context-panel-actions .context-action')]
  const modelAction = () => actionButtons().find(b => /3D Model/.test(b.textContent))
  const dialog = () => document.querySelector('dialog[open]')

  beforeEach(() => {
    __resetModelViewerLoader()
    delete self.ModelViewerElement
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
  })

  it('reads Add 3D Model… when none is attached, and opens the drop zone', async () => {
    await show([device()])
    openPanel()

    const add = modelAction()
    expect(add.textContent.trim()).toBe('Add 3D Model…')
    expect(add).not.toBeDisabled()
    fireEvent.click(add)

    expect(dialog().querySelector('.modal')).toHaveClass('modal-full')
    expect(within(dialog()).getByRole('heading', { name: 'CNC_01' })).toBeInTheDocument()
    expect(within(dialog()).getByText(/Drop a 3D model here/i)).toBeInTheDocument()
    expect(within(dialog()).getByTestId('model-3d-input')).toBeInTheDocument()
  })

  it('reads View 3D Model when one is attached, and opens the viewer', async () => {
    await show([device({ model_3d_path: PATH })])
    openPanel()

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    fireEvent.click(modelAction())

    expect(await within(dialog()).findByTestId('model-3d-viewer')).toBeInTheDocument()
    expect(within(dialog()).getByRole('link', { name: /Download/ })).toBeInTheDocument()
    expect(within(dialog()).queryByText(/Drop a 3D model here/i)).toBeNull()
  })

  it('sits right after View History', async () => {
    await show([device()])
    openPanel()

    const labels = actionButtons().map(b => b.textContent.trim())
    expect(labels.indexOf('Add 3D Model…')).toBe(labels.indexOf('View History') + 1)
  })

  it('is one action and nothing else: the drawer has no 3D section, viewer or drop zone', async () => {
    await show([device({ model_3d_path: PATH })])
    const panel = openPanel()

    expect(panel.queryByText('3D Model')).toBeNull()
    expect(panel.queryByText('Public')).toBeNull()
    expect(panel.queryByTestId('model-3d-input')).toBeNull()
    expect(panel.queryByRole('button', { name: /Expand model/ })).toBeNull()
    expect(document.querySelector('.context-panel .model-viewer-frame')).toBeNull()
    expect(document.querySelectorAll('.context-panel-actions .context-action').length).toBeGreaterThan(0)
    expect(actionButtons().filter(b => /3D Model/.test(b.textContent))).toHaveLength(1)
  })

  it('loads nothing of the model until the action is pressed, and stops when the dialog closes', async () => {
    await show([device({ model_3d_path: PATH })])
    openPanel()
    await act(async () => { await Promise.resolve() })

    // No viewer module, no element, no request for the file or its size.
    expect(self.ModelViewerElement).toBeUndefined()
    expect(document.querySelector('model-viewer')).toBeNull()
    expect(screen.queryByTestId('model-3d-viewer-loading')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()

    // A click focuses the button in a browser; fireEvent does not.
    modelAction().focus()
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')
    expect(self.ModelViewerElement).toBeDefined()
    expect(global.fetch).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(document.querySelector('model-viewer')).toBeNull()
    // The drawer is still open, on the same device, and focus is back on the action.
    expect(document.querySelector('.context-panel')).toHaveClass('context-panel-open')
    expect(document.activeElement).toBe(modelAction())
  })

  it('offers Add 3D Model… off, with its reason, to a role that cannot manage devices', async () => {
    await show([device()], operator)
    openPanel()

    const add = modelAction()
    expect(add.textContent.trim()).toBe('Add 3D Model…')
    expect(add).toBeDisabled()
    expect(add).toHaveClass('btn-disabled')
    expect(tooltipOf(add)).toMatch(/^Requires /)
    fireEvent.click(add)
    expect(dialog()).toBeNull()
  })

  it('lets a role that cannot manage devices view, and download, but not replace or remove', async () => {
    await show([device({ model_3d_path: PATH })], operator)
    openPanel()

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    expect(modelAction()).not.toBeDisabled()
    fireEvent.click(modelAction())

    await within(dialog()).findByTestId('model-3d-viewer')
    expect(within(dialog()).getByRole('link', { name: /Download/ })).toBeInTheDocument()
    expect(within(dialog()).queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: /Remove/ })).toBeNull()
    // Anyone may read the note on who can open the file.
    expect(within(dialog()).getByRole('button', { name: 'Public' })).toBeInTheDocument()
  })

  it('gives a role that can manage devices Replace and Remove, and Remove asks first', async () => {
    await show([device({ model_3d_path: PATH })])
    openPanel()
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')

    expect(within(dialog()).getByRole('button', { name: /Replace/ })).toBeInTheDocument()
    fireEvent.click(within(dialog()).getByRole('button', { name: /Remove/ }))

    const confirm = screen.getByRole('dialog', { name: 'Remove 3D model' })
    expect(within(confirm).getByRole('button', { name: 'Remove Model' })).toHaveClass('btn-danger')
  })

  it('keeps an archived device\'s model viewable but not attachable, and says why', async () => {
    await show([device({ is_archived: true })])
    openPanel()

    const add = modelAction()
    expect(add).toBeDisabled()
    expect(tooltipOf(add)).toBe('Restore this device to attach a 3D model')
  })

  it('lets an archived device\'s model be viewed, without Replace or Remove', async () => {
    await show([device({ is_archived: true, model_3d_path: PATH })])
    openPanel()

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')
    expect(within(dialog()).getByRole('link', { name: /Download/ })).toBeInTheDocument()
    expect(within(dialog()).queryByRole('button', { name: /Replace/ })).toBeNull()
  })

  it('no longer advertises the 3D model from the Configuration action', async () => {
    await show([device()])

    const labels = panelLabels()
    expect(labels).toMatch(/Configuration Parameters/i)
    expect(labels.split('|').filter(l => /3D model/i.test(l))).toEqual(['Add 3D Model…'])
  })
})
