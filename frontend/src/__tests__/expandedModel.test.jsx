import React, { useState } from 'react'
import { act, render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { START_VIEW, __resetModelViewerLoader } from '../components/common/Model3DViewer'

/**
 * A device's 3D model in its dialog: the window-sized view the drawer's View 3D Model opens, still
 * until turned, with Reset view and a line on how to move it. jsdom cannot render the custom
 * element (`@google/model-viewer` is stubbed in src/test/setup.js), so the attributes and
 * properties the element reads are what is checked.
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
  delete self.ModelViewerElement
  global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
})

/** The drawer's action and the dialog it opens: closed until the button is pressed. */
function Opener() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>View 3D Model</button>
      {open && <Model3DUploader device={DEVICE} canManage={false} showToast={vi.fn()} onClose={() => setOpen(false)} />}
    </>
  )
}

const openView = async () => {
  render(<Opener />)
  const opener = screen.getByRole('button', { name: 'View 3D Model' })
  opener.focus()
  fireEvent.click(opener)
  return opener
}

describe('the 3D model view', () => {
  it('loads nothing until it is opened: no viewer module, no element, no request for the file', async () => {
    render(<Opener />)
    await act(async () => { await Promise.resolve() })

    expect(self.ModelViewerElement).toBeUndefined()
    expect(document.querySelector('model-viewer')).toBeNull()
    expect(screen.queryByTestId('model-3d-viewer-loading')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'View 3D Model' }))
    await within(dialog()).findByTestId('model-3d-viewer')

    // The viewer's module was asked for, and its decoders pointed at the dashboard's own.
    expect(self.ModelViewerElement).toBeDefined()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][1]).toEqual({ method: 'HEAD' })
  })

  it('opens the element window-sized, titled with the device, still until turned', async () => {
    await openView()
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
    await openView()
    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    viewer.cameraOrbit = '90deg 30deg 2m'
    viewer.cameraTarget = '1m 0m 0m'
    viewer.fieldOfView = '10deg'
    fireEvent.click(within(dialog()).getByRole('button', { name: /Reset view/ }))
    expect(viewer.cameraOrbit).toBe(START_VIEW.orbit)
    expect(viewer.cameraTarget).toBe(START_VIEW.target)
    expect(viewer.fieldOfView).toBe(START_VIEW.fov)
  })

  it('says so when the model cannot be shown', async () => {
    await openView()
    const viewer = await within(dialog()).findByTestId('model-3d-viewer')
    act(() => { viewer.dispatchEvent(new Event('error')) })
    const message = within(dialog()).getByTestId('model-3d-viewer-error')
    expect(message).toHaveTextContent('This model could not be displayed.')
    expect(within(dialog()).queryByRole('button', { name: /Reset view/ })).toBeNull()
  })

  it('closes on Escape, takes the viewer with it, and hands focus back to the action', async () => {
    const opener = await openView()
    await within(dialog()).findByTestId('model-3d-viewer')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(document.querySelector('model-viewer')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('closes from its own close button', async () => {
    await openView()
    await within(dialog()).findByTestId('model-3d-viewer')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(dialog()).toBeNull()
  })
})
