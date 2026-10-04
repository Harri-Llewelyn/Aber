import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { Model3DViewer, DECODER_LOCATIONS, __resetModelViewerLoader } from '../components/common/Model3DViewer'
import { DECODER_FILES, decoderSource } from '../../modelViewerDecoders.js'

/**
 * The viewer is a thin wrapper around a custom element jsdom cannot render, so what is pinned is
 * the wrapper's responsibilities: the URL is composed from the stored object key; the element
 * carries the interaction attributes; a failed viewer module and a failed model are reported
 * differently; nothing renders without a path; the decoders come from the dashboard, not a CDN.
 * `@google/model-viewer` is stubbed globally in
 * src/test/setup.js.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    model3dPublicUrl: (path) =>
      path ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${path}` : null
  }
})

const DEVICE_ID = '22000000-0000-4000-8000-000000000001'
const PATH = `${DEVICE_ID}/cnc_mill.glb`

beforeEach(() => {
  __resetModelViewerLoader()
})

describe('Model3DViewer', () => {
  it('renders nothing at all when the device has no model', () => {
    const { container } = render(<Model3DViewer path={null} name="Sim_CNC_Mill_01" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('composes the public storage URL from the stored object key', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    const el = await screen.findByTestId('model-3d-viewer')
    expect(el.getAttribute('src')).toBe(
      `http://localhost:54321/storage/v1/object/public/asset-3d-models/${PATH}`
    )
  })

  it('carries the interaction attributes, not a static render', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    const el = await screen.findByTestId('model-3d-viewer')
    // Present-but-empty, which is how <model-viewer> reads a boolean attribute. `toBe('')` rather
    // than truthiness, because React stringifying a boolean prop into "true" would also pass a
    // loose check.
    expect(el.getAttribute('camera-controls')).toBe('')
    expect(el.getAttribute('auto-rotate')).toBe('')
    expect(el.getAttribute('shadow-intensity')).toBe('1')
  })

  it('describes the model for assistive tech by the device it belongs to', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    const el = await screen.findByTestId('model-3d-viewer')
    expect(el.getAttribute('alt')).toContain('Sim_CNC_Mill_01')
  })

  it('shows a loading state before the viewer module resolves', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)
    // Synchronously, before the dynamic import's microtask settles.
    expect(screen.getByTestId('model-3d-viewer-loading')).toBeInTheDocument()
    // Then let it settle inside the test. Without this the state update lands after the test has
    // returned, which React reports as an un-acted update against the NEXT test in the file.
    await screen.findByTestId('model-3d-viewer')
  })

  it('reports a failed MODEL load separately from a failed viewer load', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    const el = await screen.findByTestId('model-3d-viewer')
    // The element reports a bad object through an event, invisible to React; unhandled, a dead
    // object renders as a blank box indistinguishable from one still loading. In act(), because the
    // listener sets state from a DOM-dispatched event.
    act(() => { el.dispatchEvent(new Event('error')) })

    await waitFor(() => expect(screen.getByTestId('model-3d-viewer-error')).toBeInTheDocument())
    expect(screen.getByTestId('model-3d-viewer-error')).toHaveTextContent(/could not be displayed/i)
    expect(screen.queryByTestId('model-3d-viewer')).not.toBeInTheDocument()
  })

  it('points the viewer at the decoders the dashboard serves, not www.gstatic.com', async () => {
    delete self.ModelViewerElement
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)
    await screen.findByTestId('model-3d-viewer')

    // Set as the global config before any element is constructed: the viewer re-reads it per
    // element and falls back to its CDN.
    expect(self.ModelViewerElement).toMatchObject(DECODER_LOCATIONS)
    expect(DECODER_LOCATIONS.dracoDecoderLocation).toBe('/decoders/draco/')
    expect(DECODER_LOCATIONS.ktx2TranscoderLocation).toBe('/decoders/basis/')
    // Not served, and never used: a local path so a Lottie texture cannot reach cdn.jsdelivr.net.
    expect(DECODER_LOCATIONS.lottieLoaderLocation).toMatch(/^\/decoders\//)
  })

  it('serves every file three.js fetches from those locations, from the installed three', () => {
    // The fixed names DRACOLoader and KTX2Loader request under the directory they are given.
    const wanted = [
      `${DECODER_LOCATIONS.dracoDecoderLocation}draco_wasm_wrapper.js`,
      `${DECODER_LOCATIONS.dracoDecoderLocation}draco_decoder.wasm`,
      `${DECODER_LOCATIONS.ktx2TranscoderLocation}basis_transcoder.js`,
      `${DECODER_LOCATIONS.ktx2TranscoderLocation}basis_transcoder.wasm`,
    ].map((url) => url.replace(/^\//, ''))
    expect(Object.keys(DECODER_FILES).sort()).toEqual(wanted.sort())
    for (const fileName of wanted) expect(existsSync(decoderSource(fileName))).toBe(true)
  })

  it('keeps its box in every state, so the panel does not resize under the cursor', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    expect(screen.getByTestId('model-3d-viewer-loading')).toHaveClass('model-viewer-frame')
    // React 18 will not map `className` onto a custom element, so the frame is its parent. Getting
    // this wrong renders an unstyled element at zero height.
    const el = await screen.findByTestId('model-3d-viewer')
    expect(el.parentElement).toHaveClass('model-viewer-frame')

    // In act(), because the listener sets state and the event is dispatched on a DOM node rather
    // than through fireEvent -- React has no way to batch it otherwise.
    act(() => { el.dispatchEvent(new Event('error')) })
    await waitFor(() =>
      expect(screen.getByTestId('model-3d-viewer-error')).toHaveClass('model-viewer-frame')
    )
  })
})
