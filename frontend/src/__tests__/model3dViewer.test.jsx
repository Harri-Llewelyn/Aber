import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Model3DViewer, __resetModelViewerLoader } from '../components/common/Model3DViewer'

/**
 * The viewer is a thin wrapper around a custom element, so what is worth pinning is not the
 * rendering -- jsdom cannot render it -- but the four things the wrapper is responsible for:
 *
 *   * the URL is COMPOSED from the stored object key, never read from the row;
 *   * the element carries the interaction attributes, since a static canvas of a machine is
 *     strictly worse than the filename it replaced;
 *   * a failure to load the viewer module and a failure to load the MODEL are reported
 *     differently, because they have different causes and different fixes;
 *   * nothing is rendered at all without a path.
 *
 * `@google/model-viewer` is stubbed globally in src/test/setup.js -- see the note there.
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
    // than a truthiness check: React stringifying a boolean prop into "true" would also pass a
    // loose assertion, and that is the specific thing this pins.
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
    // The element reports a bad object through an event, which is invisible to React -- the
    // regression this guards is the one where that goes unhandled and a dead object renders as a
    // permanently blank box indistinguishable from one still loading.
    // In act(), because the listener sets state and the event is dispatched on a DOM node rather
    // than through fireEvent -- React has no way to batch it otherwise.
    act(() => { el.dispatchEvent(new Event('error')) })

    await waitFor(() => expect(screen.getByTestId('model-3d-viewer-error')).toBeInTheDocument())
    expect(screen.getByTestId('model-3d-viewer-error')).toHaveTextContent(/could not be displayed/i)
    expect(screen.queryByTestId('model-3d-viewer')).not.toBeInTheDocument()
  })

  it('keeps its box in every state, so the panel does not resize under the cursor', async () => {
    render(<Model3DViewer path={PATH} name="Sim_CNC_Mill_01" />)

    expect(screen.getByTestId('model-3d-viewer-loading')).toHaveClass('model-viewer-frame')
    // The element does not carry the class itself -- React 18 will not map `className` onto a
    // custom element -- so the frame is its PARENT. Asserted here because getting this wrong
    // renders an unstyled element at zero height, which looks identical to no model at all.
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
