import React from 'react'
import { act, render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { START_VIEW, __resetModelViewerLoader } from '../components/common/Model3DViewer'

/**
 * A device's 3D model, expanded: Expand in the drawer's viewer opens the same element in a
 * window-sized dialog, still until turned, with Reset view and a line on how to move it. jsdom
 * cannot render the custom element (`@google/model-viewer` is stubbed in src/test/setup.js), so the
 * attributes and properties the element reads are what is checked.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { uploadDeviceModel: vi.fn(), removeDeviceModel: vi.fn() },
    model3dPublicUrl: (path) => (path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}` : null),
    model3dDownloadUrl: (path) => (path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}?download=x` : null)
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({}) } },
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_GATEWAY_KEY: 'anon'
}))

const DEVICE = { asset_id: 'dev-1', asset_name: 'CNC_01', model_3d_path: 'dev-1/cnc.glb' }
const dialog = () => document.querySelector('dialog[open]')

beforeEach(() => {
  __resetModelViewerLoader()
  global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
})

const openExpanded = async () => {
  render(<Model3DUploader device={DEVICE} canManage={false} showToast={vi.fn()} />)
  await screen.findByTestId('model-3d-viewer')
  const expand = screen.getByRole('button', { name: 'Expand model: CNC_01' })
  expand.focus()
  fireEvent.click(expand)
  return expand
}

describe('the expanded 3D model', () => {
  it('puts Expand over the drawer\'s viewer, and keeps the drawer\'s viewer turning', async () => {
    render(<Model3DUploader device={DEVICE} canManage={false} showToast={vi.fn()} />)
    const drawerViewer = await screen.findByTestId('model-3d-viewer')
    expect(drawerViewer.getAttribute('auto-rotate')).toBe('')
    const expand = screen.getByRole('button', { name: 'Expand model: CNC_01' })
    expect(expand.closest('.model-viewer-holder')).toBe(drawerViewer.closest('.model-viewer-holder'))
    expect(expand).not.toHaveAttribute('title')
  })

  it('opens the same element window-sized, titled with the device, without auto-rotate', async () => {
    await openExpanded()
    const open = dialog()
    expect(open.querySelector('.modal')).toHaveClass('modal-full')
    expect(within(open).getByRole('heading', { name: 'CNC_01' })).toBeInTheDocument()
    const viewer = await within(open).findByTestId('model-3d-viewer')
    expect(viewer.tagName).toBe('MODEL-VIEWER')
    expect(viewer.hasAttribute('auto-rotate')).toBe(false)
    expect(viewer.getAttribute('camera-controls')).toBe('')
    expect(viewer.getAttribute('src')).toBe('http://localhost:54321/storage/v1/object/public/asset-3d-models/dev-1/cnc.glb')
    expect(viewer.getAttribute('camera-orbit')).toBe(START_VIEW.orbit)
    expect(within(open).getByText('Drag to turn · scroll to zoom · right-drag to pan')).toBeInTheDocument()
  })

  it('returns the camera to where it started on Reset view', async () => {
    await openExpanded()
    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    viewer.cameraOrbit = '90deg 30deg 2m'
    viewer.cameraTarget = '1m 0m 0m'
    viewer.fieldOfView = '10deg'
    fireEvent.click(within(dialog()).getByRole('button', { name: /Reset view/ }))
    expect(viewer.cameraOrbit).toBe(START_VIEW.orbit)
    expect(viewer.cameraTarget).toBe(START_VIEW.target)
    expect(viewer.fieldOfView).toBe(START_VIEW.fov)
  })

  it('shows the drawer\'s own message when the model cannot be shown', async () => {
    await openExpanded()
    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    act(() => { viewer.dispatchEvent(new Event('error')) })
    const message = within(dialog()).getByTestId('model-3d-viewer-error')
    expect(message).toHaveTextContent('This model could not be displayed.')
    expect(within(dialog()).queryByRole('button', { name: /Reset view/ })).toBeNull()
  })

  it('closes on Escape and hands focus back to Expand', async () => {
    const expand = await openExpanded()
    await within(dialog()).findByTestId('model-3d-viewer')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(expand)
  })
})
