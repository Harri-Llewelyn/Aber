import React, { useEffect, useRef, useState } from 'react'
import { model3dPublicUrl } from '../../api'
import { IconAlertTriangle, IconScan } from './Icons'

/**
 * An interactive preview of a device's attached 3D model. `<model-viewer>` is bundled rather than
 * loaded from a CDN, because deployments are often air-gapped and a third-party request would carry
 * the referring URL. Dynamically imported: it is by far the largest thing in the bundle, and most
 * sessions never open a device with a model. The module is remembered at module scope because the
 * import defines a custom element once.
 */
let modelViewerModule = null

/** Where the viewer fetches its Draco and KTX2 decoders: served by the dashboard itself
 *  (frontend/modelViewerDecoders.js) instead of the viewer's default, www.gstatic.com. The Lottie
 *  loader is not served: the dashboard creates no Lottie texture, and a local path makes one fail
 *  here instead of fetching from cdn.jsdelivr.net. */
export const DECODER_LOCATIONS = {
  dracoDecoderLocation: `${import.meta.env.BASE_URL}decoders/draco/`,
  ktx2TranscoderLocation: `${import.meta.env.BASE_URL}decoders/basis/`,
  lottieLoaderLocation: `${import.meta.env.BASE_URL}decoders/lottie/LottieLoader.js`,
}

function loadModelViewer() {
  // Failures are not cached: the caller clears the promise on rejection, so re-opening the drawer
  // retries.
  if (!modelViewerModule) {
    // The viewer reads this global config each time it constructs an element and falls back to
    // its CDN defaults, so it is set here rather than on the class after the import.
    self.ModelViewerElement = { ...self.ModelViewerElement, ...DECODER_LOCATIONS }
    modelViewerModule = import('@google/model-viewer')
  }
  return modelViewerModule
}

/** Exported for tests: forget the loaded module so each case starts from a known state. */
export function __resetModelViewerLoader() {
  modelViewerModule = null
}

/** Where the expanded viewer's camera starts, and where Reset view takes it: the viewer's defaults. */
export const START_VIEW = { orbit: '0deg 75deg 105%', target: 'auto auto auto', fov: 'auto' }
const START_VIEW_ATTRIBUTES = {
  'camera-orbit': START_VIEW.orbit,
  'camera-target': START_VIEW.target,
  'field-of-view': START_VIEW.fov,
}

/**
 * @param {string} path  Object key in the `asset-3d-models` bucket, as stored in
 *                       `devices.model_3d_path`. The public URL is composed here rather than
 *                       stored -- see archived migration 20260101000035_asset_3d_models.sql.
 * @param {string} name  Device name, used for the accessible description.
 * @param {boolean} [expanded]  The window-sized dialog's viewer: it fills the height it is given,
 *                       keeps still until turned, and has a Reset view button and a line on how
 *                       to move it. Without it, the drawer's 200px preview, turning on its own.
 */
export function Model3DViewer({ path, name, expanded = false }) {
  // 'loading' covers fetching the viewer module; 'ready' means the element is defined;
  // 'unavailable' means it could not be loaded; 'broken' means the model failed. The last two have
  // different causes and different advice.
  const [state, setState] = useState('loading')
  const elementRef = useRef(null)

  const url = path ? model3dPublicUrl(path) : null

  useEffect(() => {
    if (!url) return undefined

    let cancelled = false
    setState('loading')

    loadModelViewer().then(
      () => { if (!cancelled) setState('ready') },
      () => {
        modelViewerModule = null
        if (!cancelled) setState('unavailable')
      }
    )

    return () => { cancelled = true }
  }, [url])

  // The element reports a failed load through an `error` event; without listening, a missing object
  // renders as a permanently empty box.
  useEffect(() => {
    const element = elementRef.current
    if (state !== 'ready' || !element) return undefined

    const onError = () => setState('broken')
    element.addEventListener('error', onError)
    return () => element.removeEventListener('error', onError)
  }, [state, url])

  if (!url) return null

  const frame = `model-viewer-frame${expanded ? ' model-viewer-frame-full' : ''}`

  if (state === 'loading') {
    return (
      <div className={`${frame} model-viewer-message`} data-testid="model-3d-viewer-loading">
        <span className="spinner spinner-sm" /> Loading viewer…
      </div>
    )
  }

  if (state === 'unavailable' || state === 'broken') {
    return (
      <div className={`${frame} model-viewer-message`} data-testid="model-3d-viewer-error">
        <IconAlertTriangle size={14} />
        <span>
          {state === 'broken'
            ? 'This model could not be displayed. The file may be corrupt, or an unsupported variant of its format.'
            : 'The 3D viewer could not be loaded.'}
        </span>
      </div>
    )
  }

  /* A wrapper div, because React 18 passes `className` through verbatim on a custom element, and
     the three states share one box. Boolean attributes are empty strings, read by presence.
     `loading="eager"` because this renders inside an already-open drawer. */
  const viewer = (
    <div className={frame}>
      <model-viewer
        ref={elementRef}
        src={url}
        alt={name ? `Interactive 3D model of ${name}` : 'Interactive 3D model'}
        camera-controls=""
        auto-rotate={expanded ? undefined : ''}
        {...(expanded ? START_VIEW_ATTRIBUTES : {})}
        shadow-intensity="1"
        loading="eager"
        data-testid="model-3d-viewer"
      />
    </div>
  )
  if (!expanded) return viewer

  // Each camera property animates to whatever it is set to, even its own value again.
  const resetView = () => {
    const element = elementRef.current
    if (!element) return
    element.cameraOrbit = START_VIEW.orbit
    element.cameraTarget = START_VIEW.target
    element.fieldOfView = START_VIEW.fov
  }

  return (
    <>
      {viewer}
      <div className="expanded-view-foot">
        <p className="expanded-view-hint">Drag to turn · scroll to zoom · right-drag to pan</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={resetView}>
          <IconScan size={13} /> Reset view
        </button>
      </div>
    </>
  )
}
