import React, { useEffect, useRef, useState } from 'react'
import { model3dPublicUrl } from '../../api'
import { IconAlertTriangle } from './Icons'

/**
 * An interactive preview of a device's attached 3D model.
 *
 * WHY THE VIEWER IS BUNDLED RATHER THAN LOADED FROM A CDN. `<model-viewer>` is normally dropped in
 * as a <script> tag from ajax.googleapis.com, and that is the wrong shape for this application. It
 * is deployed onto factory networks that are frequently air-gapped or egress-filtered: a CDN tag
 * turns "the drawer shows a model" into "the drawer shows a model IF the site can reach Google",
 * with no failure the operator can act on. It also makes every dashboard render a request to a
 * third party carrying the referring URL, which is the same objection that keeps `cells.icon` a
 * key rather than a URL. So it is an npm dependency, served from our own origin.
 *
 * DYNAMICALLY IMPORTED, which is what makes that affordable. The package carries a WebGL renderer
 * and is by a wide margin the largest thing in this bundle -- several times the rest of the
 * application. A static import would put it in the entry chunk and make every page load pay for it,
 * including the many sessions that never open a device with a model attached. `import()` gives Vite
 * a split point, so the cost is paid on first use and not before.
 *
 * The module is remembered at MODULE scope, not in component state: the import defines a custom
 * element, which is a global, one-time side effect. Flicking between five devices must not re-enter
 * it five times.
 */
let modelViewerModule = null

function loadModelViewer() {
  // Failures are not cached -- the promise is cleared by the caller on rejection, so re-opening the
  // drawer retries. A single transient chunk-load failure should not disable the preview for the
  // rest of the session.
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
 *                       stored -- see migration 0035.
 * @param {string} name  Device name, used for the accessible description.
 */
export function Model3DViewer({ path, name }) {
  // 'loading' covers fetching the viewer module; 'ready' means the custom element is defined;
  // 'unavailable' means it could not be loaded and 'broken' means it loaded and the MODEL failed.
  // The last two are separate states because they have different causes and different advice: one
  // is a delivery problem with the application, the other is a bad or missing object in the bucket.
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

  // The element reports a failed load through an `error` event, not through anything React can see
  // -- a custom element's internal fetch is invisible to the component that rendered it. Without
  // this, a deleted object or an unreachable storage endpoint renders as a permanently empty grey
  // box, which is indistinguishable from a model that is still loading.
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

  /*
    THE FRAME IS A WRAPPER DIV, and the custom element fills it. The obvious shape -- putting
    `className` straight on <model-viewer> -- does not work: React 18 maps `className` to `class`
    only for elements it knows, and passes props through verbatim on a custom one, so the styles
    landed on an attribute named `classname` and the element rendered unstyled at zero height. That
    failed loudly here and would have failed silently in the drawer, as a model that never appeared.

    Wrapping also makes the three states share one box by construction rather than by three
    selectors agreeing, which is what keeps the panel from resizing as the viewer loads.

    THE BOOLEAN ATTRIBUTES ARE EMPTY STRINGS, not `true`. <model-viewer> reads them by presence,
    and a boolean prop on an unknown element stringifies to the literal "true" -- which happens to
    work today and would stop working the day one of them is inverted to a `no-` form.

    `loading="eager"` because this only ever renders inside an already-open drawer for an
    already-selected device; the default lazy reveal would leave it blank until scrolled into view,
    in a panel short enough that it usually already is.
  */
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
