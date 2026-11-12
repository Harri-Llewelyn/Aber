import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deviceUrl } from '../routes'
import { Model3DUploader, MODEL_STORAGE_NOTE } from '../components/common/Model3DUploader'
import { api } from '../api'
import { getByTooltip, queryByTooltip } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { uploadDeviceModel: vi.fn(), removeDeviceModel: vi.fn() },
    model3dPublicUrl: (path) =>
      path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}` : null,
    // The download variant carries `?download=<filename>`, which makes storage answer with
    // `Content-Disposition: attachment`. Mocked separately from the plain URL, which is used for
    // the size HEAD.
    model3dDownloadUrl: (path) =>
      path
        ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}` +
          `?download=${path.split('/').pop()}`
        : null
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({}) } },
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_GATEWAY_KEY: 'anon'
}))

const DEVICE_ID = '20000000-0000-4000-8000-000000000002'
const device = (path = null) => ({ asset_id: DEVICE_ID, asset_name: 'CNC_01', model_3d_path: path })

const makeFile = (name, size = 1024, type = 'model/gltf-binary') => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const drop = (zone, file) =>
  fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } })

beforeEach(() => {
  vi.clearAllMocks()
  // The component HEADs the public URL to label the attached model's size.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: (k) => (k === 'content-length' ? '13002342' : null) }
  })
})

/** The dialog the drawer's View 3D Model and Add 3D Model… open: a drop zone, or the model and its file. */
describe('Model3DUploader', () => {
  it('is one window-sized dialog, titled with the device', () => {
    render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'CNC_01' })
    expect(dialog.querySelector('.modal')).toHaveClass('modal-full')
  })

  it('offers a dropzone listing the accepted formats', () => {
    render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
    expect(screen.getByText(/Drop a 3D model here/i)).toBeInTheDocument()
    expect(screen.getByText(/\.glb, \.gltf, \.obj, \.stl/)).toBeInTheDocument()
  })

  it('uploads a dropped model and reports it', async () => {
    const showToast = vi.fn()
    const onChange = vi.fn()
    api.uploadDeviceModel.mockResolvedValue({ path: `${DEVICE_ID}/cnc.glb` })

    render(<Model3DUploader device={device()} canManage showToast={showToast} onChange={onChange} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('cnc.glb'))

    await waitFor(() => expect(api.uploadDeviceModel).toHaveBeenCalled())
    expect(api.uploadDeviceModel.mock.calls[0][0]).toBe(DEVICE_ID)
    expect(api.uploadDeviceModel.mock.calls[0][1].name).toBe('cnc.glb')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`${DEVICE_ID}/cnc.glb`))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('cnc.glb'), 'success', { to: deviceUrl(DEVICE_ID) })
  })

  it('refuses an unsupported format without calling the API at all', async () => {
    const showToast = vi.fn()
    render(<Model3DUploader device={device()} canManage showToast={showToast} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('drawing.step'))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('not a supported format'), 'error'))
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
    // Said in the dialog too, where a toast would be hidden behind it.
    expect(screen.getByRole('alert')).toHaveTextContent('"drawing.step" is not a supported format')
  })

  it('refuses an oversized file locally rather than after a doomed upload', async () => {
    const showToast = vi.fn()
    render(<Model3DUploader device={device()} canManage showToast={showToast} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('huge.glb', 200 * 1024 * 1024))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('the limit is'), 'error'))
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
  })

  it('surfaces an upload failure instead of reporting success', async () => {
    const showToast = vi.fn()
    const onChange = vi.fn()
    api.uploadDeviceModel.mockRejectedValue(new Error('You do not have permission to upload a 3D model for this device.'))

    render(<Model3DUploader device={device()} canManage showToast={showToast} onChange={onChange} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('cnc.glb'))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('do not have permission'), 'error'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission to upload a 3D model for this device.')
  })

  it('shows the attached model with its name and size', async () => {
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc_machine.glb`)} canManage showToast={vi.fn()} />)

    expect(screen.getByText('cnc_machine.glb')).toBeInTheDocument()
    // Fetched by HEAD so a 40 MB model is not downloaded merely to be labelled.
    await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())
    expect(global.fetch.mock.calls[0][1]).toEqual({ method: 'HEAD' })
  })

  it('still reports the attachment when the size cannot be read', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)

    expect(screen.getByText('cnc.glb')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/size unavailable/)).toBeInTheDocument())
  })

  /** Remove asks first, as Remove plan does on an area: the way back is another upload. */
  describe('removing the attached model', () => {
    const openRemove = async (props = {}) => {
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} {...props} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())
      fireEvent.click(getByTooltip(/Detach this model/i))
      return screen.getByRole('dialog', { name: 'Remove 3D model' })
    }
    const confirmDialog = () => screen.queryByRole('dialog', { name: 'Remove 3D model' })

    it('asks first, naming the device and saying the file is deleted', async () => {
      const dialog = await openRemove()

      expect(api.removeDeviceModel).not.toHaveBeenCalled()
      expect(dialog).toHaveAccessibleDescription(
        'Remove the 3D model from CNC_01? The device keeps its other details, and the file is deleted.')
      expect(within(dialog).getByRole('button', { name: 'Remove Model' })).toHaveClass('btn-danger')
    })

    it('removes nothing when cancelled', async () => {
      const onChange = vi.fn()
      const onClose = vi.fn()
      const dialog = await openRemove({ onChange, onClose })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      expect(confirmDialog()).toBeNull()
      // The model's own dialog is still open beneath.
      expect(screen.getByRole('dialog', { name: 'CNC_01' })).toBeInTheDocument()
      expect(api.removeDeviceModel).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('removes the model once, when confirmed, and closes the dialog so the toast is in view', async () => {
      const onChange = vi.fn()
      const onClose = vi.fn()
      const showToast = vi.fn()
      api.removeDeviceModel.mockResolvedValue(undefined)
      const dialog = await openRemove({ onChange, onClose, showToast })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Model' }))

      await waitFor(() => expect(api.removeDeviceModel).toHaveBeenCalledWith(DEVICE_ID, `${DEVICE_ID}/cnc.glb`))
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
      expect(api.removeDeviceModel).toHaveBeenCalledTimes(1)
      expect(showToast).toHaveBeenCalledWith("3D model removed from 'CNC_01'", 'success', { to: deviceUrl(DEVICE_ID) })
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(confirmDialog()).toBeNull())
    })

    it('stays open on a failure, which is said in the dialog', async () => {
      api.removeDeviceModel.mockRejectedValue(new Error('The model could not be deleted from storage.'))
      const dialog = await openRemove()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Model' }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('The model could not be deleted from storage.')
      expect(confirmDialog()).toBe(dialog)
    })

    it('stays open after a failure, so the dialog is not closed over an unchanged model', async () => {
      const onClose = vi.fn()
      api.removeDeviceModel.mockRejectedValue(new Error('The model could not be deleted from storage.'))
      const dialog = await openRemove({ onClose })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Model' }))
      await within(dialog).findByRole('alert')

      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('hides every write control from a role that cannot manage devices', async () => {
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage={false} showToast={vi.fn()} />)

    expect(screen.getByText('cnc.glb')).toBeInTheDocument()
    // Let the size HEAD settle before asserting, so its state update lands inside the test.
    await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())
    expect(queryByTooltip(/Detach this model/i)).toBeNull()
    expect(queryByTooltip(/Upload a different model/i)).toBeNull()
  })

  it('does not upload on a drop when the user cannot manage devices', async () => {
    render(<Model3DUploader device={device()} canManage={false} showToast={vi.fn()} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('cnc.glb'))

    await new Promise(r => setTimeout(r, 0))
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
  })

  // The warning is in the empty drop zone, where the decision to upload is made; with a model
  // attached it is the "Public" marker's tip, for every role.
  it('says the bucket is public on the empty drop zone', () => {
    render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
    expect(screen.getByText(/anyone with the link can read it/i)).toBeInTheDocument()
  })

  describe('the Public marker', () => {
    it.each([['may manage devices', true], ['may not', false]])('carries the storage note for a role that %s, and the keyboard reaches it', async (_, canManage) => {
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage={canManage} showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      // Its visible word is its name.
      const marker = screen.getByRole('button', { name: 'Public' })
      expect(marker).toHaveClass('help-tip-text')
      expect(marker).not.toHaveAttribute('title')
      fireEvent.focus(marker)
      expect(screen.getByRole('tooltip')).toHaveTextContent(MODEL_STORAGE_NOTE)
      expect(MODEL_STORAGE_NOTE).toBe('Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.')
    })

    it('is not printed in full beside an attached model: the marker carries it', async () => {
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      expect(screen.queryByText(/asset-3d-models/)).toBeNull()
      expect(screen.queryByText(/anyone with the link/)).toBeNull()
    })

    it('is not on the empty drop zone, which says it in full', () => {
      render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
      expect(screen.queryByRole('button', { name: 'Public' })).toBeNull()
    })
  })

  it('says nothing about storage on the empty drop zone to someone who may not upload', () => {
    render(<Model3DUploader device={device()} canManage={false} showToast={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Upload a 3D model/i })).not.toHaveTextContent(/anyone with the link/)
  })

  it('turns from the drop zone to the model when the device gains one, without closing', async () => {
    const { rerender } = render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Upload a 3D model/i })).toBeInTheDocument()

    rerender(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)

    expect(await screen.findByTestId('model-3d-viewer')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'CNC_01' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Upload a 3D model/i })).toBeNull()
  })

  it('offers Replace and Remove, but nothing to drop a file on, once a model is attached', async () => {
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: /Upload a 3D model/i })).toBeNull()
    expect(getByTooltip(/Upload a different model/i)).toHaveTextContent('Replace')
    expect(getByTooltip(/Detach this model/i)).toHaveTextContent('Remove')
  })

  // Download is a button beside Replace and Remove.
  describe('downloading the attached model', () => {
    it('offers Download as a button rather than a label beside the size', async () => {
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      expect(getByTooltip(/^Save cnc\.glb to this computer$/)).toBeInTheDocument()
      expect(screen.queryByText(/^Open$/)).not.toBeInTheDocument()
    })

    it('asks storage for an attachment, not a navigation', async () => {
      /* `?download=` is the load-bearing part: the bucket is a different origin and browsers ignore
         the `download` attribute cross-origin, so without it a .gltf, being JSON, would open in the
         tab. */
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      const link = getByTooltip(/^Save cnc\.glb to this computer$/)
      expect(link).toHaveAttribute('href', expect.stringContaining('?download=cnc.glb'))
    })

    it('is the first of the three controls', async () => {
      // First and strongest: it is the control most used.
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      const download = getByTooltip(/^Save cnc\.glb to this computer$/)
      const row = download.parentElement
      expect(row.firstElementChild).toBe(download)
      expect(download).toHaveClass('btn-primary')
      expect(getByTooltip(/Upload a different model/i)).toHaveClass('btn-ghost')
      expect(getByTooltip(/Detach this model/i)).toHaveClass('btn-ghost')
    })

    it('stays available to a role that cannot manage devices', async () => {
      /* Download sits outside the `canManage` gate: reading a public-read object is not a write,
         and Operators and Auditors are the roles most likely to want a model. */
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage={false} showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12.4 MiB/)).toBeInTheDocument())

      expect(getByTooltip(/^Save cnc\.glb to this computer$/)).toBeInTheDocument()
      expect(queryByTooltip(/Upload a different model/i)).toBeNull()
      expect(queryByTooltip(/Detach this model/i)).toBeNull()
    })
  })
})
