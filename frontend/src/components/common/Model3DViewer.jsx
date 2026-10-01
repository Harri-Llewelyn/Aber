import React, { useEffect, useRef, useState } from 'react'
import { model3dPublicUrl } from '../../api'
import { IconAlertTriangle } from './Icons'

/**
 * An interactive preview of a device's attached 3D model. `<model-viewer>` is bundled rather than
 * loaded from a CDN, because deployments are often air-gapped and a third-party request would carry
 * the referring URL. Dynamically imported: it is by far the largest thing in the bundle, and most
 * sessions never open a device with a model. The module is remembered at module scope because the
 * import defines a custom element once.
 */
let modelViewerModule = null

function loadModelViewer() {
  // Failures are not cached: the caller clears the promise on rejection, so re-opening the drawer
  // retries.
  if (!modelViewerModule) modelViewerModule = import('@google/model-viewer')
  return modelViewerModule
}

/** Exported for tests: forget the loaded module so each case starts from a known state. */
export function __resetModelViewerLoader() {
  modelViewerModule = null
}

/**
 * @param {string} path  Object key in the `asset-3d-models` bucket, as stored in
 *                       `devices.model_3d_path`. The public URL is composed here rather than
 *                       stored -- see archived migration 20260101000035_asset_3d_models.sql.
 * @param {string} name  Device name, used for the accessible description.
 */
export function Model3DViewer({ path, name }) {
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

  if (state === 'loading') {
    return (
      <div className="model-viewer-frame model-viewer-message" data-testid="model-3d-viewer-loading">
        <span className="spinner spinner-sm" /> Loading viewer…
      </div>
    )
  }

  if (state === 'unavailable' || state === 'broken') {
    return (
      <div className="model-viewer-frame model-viewer-message" data-testid="model-3d-viewer-error">
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
  return (
    <div className="model-viewer-frame">
      <model-viewer
        ref={elementRef}
        src={url}
        alt={name ? `Interactive 3D model of ${name}` : 'Interactive 3D model'}
        camera-controls=""
        auto-rotate=""
        shadow-intensity="1"
        loading="eager"
        data-testid="model-3d-viewer"
      />
    </div>
  )
}
