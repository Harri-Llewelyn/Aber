import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { PERMISSION_UUIDS } from '../constants'
import { pick } from '../test/listFilters'
import { tooltipOf } from '../test/tooltips'
import { __resetModelViewerLoader } from '../components/common/Model3DViewer'
import { api } from '../api'

/**
 * A replay lane holds no 3D model of its own. Its drawer's View 3D Model opens its machine's model,
 * read-only, with a line naming the machine. A lane whose machine has none is offered neither View
 * nor Add, and a lane is never offered Add, Replace or Remove. The machine's own drawer is as it was.
 */

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

const MACHINE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const LANE_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const MACHINE_PATH = `${MACHINE_ID}/assembly.glb`
const LANE_PATH = `${LANE_ID}/uploaded-for-the-lane.glb`

const device = (overrides = {}) => ({
  asset_id: MACHINE_ID,
  asset_name: 'Assembly Device',
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
const machine = (overrides = {}) => device(overrides)
const lane = (overrides = {}) => device({
  asset_id: LANE_ID,
  asset_name: 'Assembly Device (replay)',
  sparkplug_id: 'devbbbbbbbb000040008000',
  shadow_of: MACHINE_ID,
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

const manager = () => true
const operator = (perm) => perm !== PERMISSION_UUIDS.DEVICE_MANAGE

/** The Devices page with replay lanes shown, and the drawer of `name` open. */
const openDrawer = async (rows, name, hasPermission = manager) => {
  // The page hides replay lanes until asked, and keeps the choice in its address.
  window.history.replaceState(null, '', '/devices?replay=1')
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  // The roster opens on Active, so a fixture holding an archived row asks for All first.
  if (rows.some(r => r.is_archived)) {
    fireEvent.click(await screen.findByRole('button', { name: /^Filters/ }))
    await waitFor(() => pick('Lifecycle', 'active', 'archived'))
  }
  const page = () => within(document.querySelector('.page-main'))
  await waitFor(() => expect(page().getByText(name)).toBeTruthy())
  fireEvent.click(page().getByText(name))
  return within(document.querySelector('.context-panel'))
}

const actionButtons = () => [...document.querySelectorAll('.context-panel-actions .context-action')]
const modelAction = () => actionButtons().find(b => /3D Model/.test(b.textContent))
const dialog = () => document.querySelector('dialog[open]')

beforeEach(() => {
  vi.clearAllMocks()
  __resetModelViewerLoader()
  delete self.ModelViewerElement
  global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
})

afterEach(() => window.history.replaceState(null, '', '/'))

describe("a replay lane's drawer, when its machine has a 3D model", () => {
  it("offers View 3D Model, and opens the machine's model in the lane's own dialog", async () => {
    await openDrawer([machine({ model_3d_path: MACHINE_PATH }), lane()], 'Assembly Device (replay)')

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    expect(modelAction()).not.toBeDisabled()
    expect(tooltipOf(modelAction())).toMatch(/Assembly Device, which this replay lane shows/)
    fireEvent.click(modelAction())

    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    expect(viewer.getAttribute('src')).toBe(`http://localhost:54321/storage/v1/object/public/asset-3d-models/${MACHINE_PATH}`)
    expect(within(dialog()).getByRole('heading', { name: 'Assembly Device (replay)' })).toBeInTheDocument()
    expect(within(dialog()).getByText("Assembly Device's model")).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: /Reset view/ })).toBeInTheDocument()
  })

  it('is read-only for a role that may manage devices: no Replace, no Remove, no Public, no file input', async () => {
    await openDrawer([machine({ model_3d_path: MACHINE_PATH }), lane()], 'Assembly Device (replay)', manager)
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')

    expect(within(dialog()).queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: 'Public' })).toBeNull()
    expect(within(dialog()).queryByTestId('model-3d-input')).toBeNull()
    expect(within(dialog()).queryByText(/Drop a 3D model here/i)).toBeNull()
    // Reading the machine's file is not a write.
    expect(within(dialog()).getByRole('link', { name: /Download/ })).toHaveAttribute('href', expect.stringContaining(MACHINE_PATH))
  })

  it('is open to a role that may not manage devices, as viewing is on a machine', async () => {
    await openDrawer([machine({ model_3d_path: MACHINE_PATH }), lane()], 'Assembly Device (replay)', operator)

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    expect(modelAction()).not.toBeDisabled()
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')
    expect(within(dialog()).queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it("shows the machine's model, never a path on the lane's own row", async () => {
    // A row the database no longer allows, as one from before it did would arrive.
    await openDrawer([machine({ model_3d_path: MACHINE_PATH }), lane({ model_3d_path: LANE_PATH })], 'Assembly Device (replay)')
    fireEvent.click(modelAction())

    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    expect(viewer.getAttribute('src')).toContain(MACHINE_PATH)
    expect(viewer.getAttribute('src')).not.toContain(LANE_PATH)
  })

  it('stays viewable on an archived lane, which follows its archived machine', async () => {
    await openDrawer([machine({ model_3d_path: MACHINE_PATH, is_archived: true }), lane({ is_archived: true })],
      'Assembly Device (replay)', operator)
    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    expect(modelAction()).not.toBeDisabled()
  })
})

describe("a replay lane's drawer, when its machine has none", () => {
  it.each([['a role that may manage devices', manager], ['a role that may not', operator]])(
    'offers neither View nor Add to %s', async (_, role) => {
      await openDrawer([machine(), lane()], 'Assembly Device (replay)', role)

      expect(modelAction()).toBeUndefined()
      expect(actionButtons().map(b => b.textContent).join('|')).not.toMatch(/3D model/i)
      // The rest of the drawer is there.
      expect(actionButtons().length).toBeGreaterThan(0)
    })

  it("offers nothing for a path on the lane's own row", async () => {
    await openDrawer([machine(), lane({ model_3d_path: LANE_PATH })], 'Assembly Device (replay)')
    expect(modelAction()).toBeUndefined()
  })

  it('offers nothing when the machine is not in the list', async () => {
    await openDrawer([lane()], 'Assembly Device (replay)')
    expect(modelAction()).toBeUndefined()
  })
})

describe("the machine's own drawer, beside its lane", () => {
  it('still reads Add 3D Model… with none, and opens the drop zone', async () => {
    await openDrawer([machine(), lane()], 'Assembly Device')

    expect(modelAction().textContent.trim()).toBe('Add 3D Model…')
    fireEvent.click(modelAction())
    expect(within(dialog()).getByText(/Drop a 3D model here/i)).toBeInTheDocument()
  })

  it('still reads View 3D Model with one, with Replace, Remove and Public', async () => {
    await openDrawer([machine({ model_3d_path: MACHINE_PATH }), lane()], 'Assembly Device')

    expect(modelAction().textContent.trim()).toBe('View 3D Model')
    fireEvent.click(modelAction())
    await within(dialog()).findByTestId('model-3d-viewer')
    expect(within(dialog()).getByRole('button', { name: /Replace/ })).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: /Remove/ })).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Public' })).toBeInTheDocument()
    expect(within(dialog()).queryByText("Assembly Device's model")).toBeNull()
  })

  it("shows a machine's model that is stored under its lane's id as any other", async () => {
    // What the migration leaves where a lane held the upload and its machine had none.
    await openDrawer([machine({ model_3d_path: LANE_PATH }), lane()], 'Assembly Device')
    fireEvent.click(modelAction())

    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    expect(viewer.getAttribute('src')).toContain(LANE_PATH)
    expect(within(dialog()).getByRole('link', { name: /Download/ })).toHaveAttribute('href', expect.stringContaining(LANE_PATH))
    expect(within(dialog()).getByRole('button', { name: 'Public' })).toBeInTheDocument()
  })
})

describe('the model dialog, given a model that is another device\'s', () => {
  it('draws nothing when that device has no model, rather than a drop zone', () => {
    render(<Model3DUploader device={lane()} modelOf={machine()} canManage showToast={vi.fn()} onClose={vi.fn()} />)
    expect(dialog()).toBeNull()
    expect(screen.queryByTestId('model-3d-input')).toBeNull()
  })

  it('is read-only whoever asks', async () => {
    render(<Model3DUploader device={lane()} modelOf={machine({ model_3d_path: MACHINE_PATH })} canManage showToast={vi.fn()} onClose={vi.fn()} />)
    await within(dialog()).findByTestId('model-3d-viewer')
    expect(within(dialog()).queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(within(dialog()).getByText("Assembly Device's model")).toBeInTheDocument()
  })
})
