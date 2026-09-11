import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { api } from '../api'

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
  SUPABASE_ANON_KEY: 'anon'
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

describe('Model3DUploader', () => {
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
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('cnc.glb'), 'success')
  })

  it('refuses an unsupported format without calling the API at all', async () => {
    const showToast = vi.fn()
    render(<Model3DUploader device={device()} canManage showToast={showToast} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('drawing.step'))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('not a supported format'), 'error'))
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
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
  })

  it('shows the attached model with its name and size', async () => {
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc_machine.glb`)} canManage showToast={vi.fn()} />)

    expect(screen.getByText(/Model attached: cnc_machine\.glb/)).toBeInTheDocument()
    // Fetched by HEAD so a 40 MB model is not downloaded merely to be labelled.
    await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())
    expect(global.fetch.mock.calls[0][1]).toEqual({ method: 'HEAD' })
  })

  it('still reports the attachment when the size cannot be read', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)

    expect(screen.getByText(/Model attached: cnc\.glb/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/size unavailable/)).toBeInTheDocument())
  })

  it('removes an attached model', async () => {
    const onChange = vi.fn()
    api.removeDeviceModel.mockResolvedValue(undefined)

    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} onChange={onChange} />)
    fireEvent.click(screen.getByTitle(/Detach this model/i))

    await waitFor(() => expect(api.removeDeviceModel).toHaveBeenCalledWith(DEVICE_ID, `${DEVICE_ID}/cnc.glb`))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it('hides every write control from a role that cannot manage devices', async () => {
    render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage={false} showToast={vi.fn()} />)

    expect(screen.getByText(/Model attached: cnc\.glb/)).toBeInTheDocument()
    // Let the size HEAD settle before asserting, so its state update lands inside the test.
    await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())
    expect(screen.queryByTitle(/Detach this model/i)).not.toBeInTheDocument()
    expect(screen.queryByTitle(/Upload a different model/i)).not.toBeInTheDocument()
  })

  it('does not upload on a drop when the user cannot manage devices', async () => {
    render(<Model3DUploader device={device()} canManage={false} showToast={vi.fn()} />)
    drop(screen.getByRole('button', { name: /Upload a 3D model/i }), makeFile('cnc.glb'))

    await new Promise(r => setTimeout(r, 0))
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
  })

  it('warns that the bucket is public, since an export publishes the URL', () => {
    render(<Model3DUploader device={device()} canManage showToast={vi.fn()} />)
    expect(screen.getByText(/anyone with the link can read it/i)).toBeInTheDocument()
  })

  /* Getting the file out: a Download button beside Replace and Remove, not a small link beside the
     file size. */
  describe('downloading the attached model', () => {
    it('offers Download as a button rather than a label beside the size', async () => {
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())

      expect(screen.getByTitle(/Download this model file/i)).toBeInTheDocument()
      // The old affordance is gone, not merely demoted -- two ways to fetch the same file, one of
      // them 11px, is the state being fixed.
      expect(screen.queryByText(/^Open$/)).not.toBeInTheDocument()
    })

    it('asks storage for an attachment, not a navigation', async () => {
      /* `?download=` is the load-bearing part: the bucket is a different origin and browsers ignore
         the `download` attribute cross-origin, so without it a .gltf, being JSON, would open in the
         tab. */
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())

      const link = screen.getByTitle(/Download this model file/i)
      expect(link).toHaveAttribute('href', expect.stringContaining('?download=cnc.glb'))
    })

    it('is the first of the three controls', async () => {
      // The issue asks for it first and visually strongest, because it is the one most used.
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())

      const download = screen.getByTitle(/Download this model file/i)
      const row = download.parentElement
      expect(row.firstElementChild).toBe(download)
      expect(download).toHaveClass('btn-primary')
      expect(screen.getByTitle(/Upload a different model/i)).toHaveClass('btn-ghost')
      expect(screen.getByTitle(/Detach this model/i)).toHaveClass('btn-ghost')
    })

    it('stays available to a role that cannot manage devices', async () => {
      /* Download sits outside the `canManage` gate: reading a public-read object is not a write,
         and Operators and Auditors are the roles most likely to want a model. */
      render(<Model3DUploader device={device(`${DEVICE_ID}/cnc.glb`)} canManage={false} showToast={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/12\.4 MB/)).toBeInTheDocument())

      expect(screen.getByTitle(/Download this model file/i)).toBeInTheDocument()
      expect(screen.queryByTitle(/Upload a different model/i)).not.toBeInTheDocument()
      expect(screen.queryByTitle(/Detach this model/i)).not.toBeInTheDocument()
    })
  })
})
