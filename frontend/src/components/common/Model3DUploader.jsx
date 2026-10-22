import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, model3dPublicUrl, model3dDownloadUrl } from '../../api'
import {
  MODEL_3D_EXTENSIONS,
  formatFileSize,
  isAcceptedModelFile,
  modelFileName
} from '../../utils/model3d'
import { IconCube, IconUpload, IconTrash, IconDownload, IconAlertTriangle, IconGlobe } from './Icons'
import { ActionButton } from './ActionButton'
import { Model3DViewer } from './Model3DViewer'
import { ExpandButton } from './ExpandButton'
import { HelpTip } from './HelpTip'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'
import { deviceUrl } from '../../routes'

/** Where an attached model is kept, and so who can read it. */
export const MODEL_STORAGE_NOTE =
  'Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.'

/**
 * Attach one 3D visual model to a device. The model becomes an AAS `File` element in a
 * `VisualRepresentation` submodel on export, so the bucket is public-read: the empty drop zone says
 * so in full to someone who may upload, and with a model attached the section's label
 * (Model3DLabel) carries a "Public" marker whose tip says it. Size is checked here as well as on the
 * bucket, so an oversized file is refused before the upload rather than after. Drawn in the device
 * drawer's 3D Model section (`.model-section`), the drawer's width, above the actions.
 */
export function Model3DUploader({ device, canManage, showToast, onChange }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const [size, setSize] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef(null)

  const path = device?.model_3d_path || null
  const deviceId = device?.asset_id || device?.id
  const deviceName = device?.asset_name
  const modelName = device?.asset_name || device?.name

  // The bucket's own limit, mirrored. Kept as a constant rather than read from the bucket because
  // fetching it would be a round trip per render for a value that changes once a deployment.
  const MAX_BYTES = 50 * 1024 * 1024

  /**
   * The stored size, fetched rather than remembered from the upload, so a model attached in an
   * earlier session or by another user reports the same way.
   */
  useEffect(() => {
    let cancelled = false
    if (!path) { setSize(null); return }

    const url = model3dPublicUrl(path)
    if (!url) return

    // HEAD, so a 40 MB model is not downloaded just to label it. A failure here is silent by
    // design: the size is decoration, and the attachment is still real without it.
    fetch(url, { method: 'HEAD' })
      .then(res => {
        if (cancelled || !res.ok) return
        const length = Number.parseInt(res.headers.get('content-length') || '', 10)
        if (Number.isFinite(length)) setSize(length)
      })
      .catch(() => { /* size is decoration */ })

    return () => { cancelled = true }
  }, [path])

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setError(null)

    if (!isAcceptedModelFile(file.name)) {
      const message = `"${file.name}" is not a supported format. Accepted: ${MODEL_3D_EXTENSIONS.join(', ')}`
      setError(message)
      showToast?.(message, 'error')
      return
    }
    if (file.size > MAX_BYTES) {
      const message = `"${file.name}" is ${formatFileSize(file.size)}; the limit is ${formatFileSize(MAX_BYTES)}.`
      setError(message)
      showToast?.(message, 'error')
      return
    }

    setBusy(true)
    try {
      const { path: uploaded } = await api.uploadDeviceModel(deviceId, file)
      setSize(file.size)
      showToast?.(`3D model attached${deviceName ? ` to '${deviceName}'` : ''}: ${modelFileName(uploaded)}`, 'success', { to: deviceUrl(deviceId) })
      onChange?.(uploaded)
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
      // Cleared so re-picking the SAME file fires a change event again -- otherwise a failed
      // upload cannot be retried from the picker without choosing something else first.
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [deviceId, deviceName, onChange, showToast])

  const handleRemove = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.removeDeviceModel(deviceId, path)
      setSize(null)
      showToast?.(`3D model removed${deviceName ? ` from '${deviceName}'` : ''}`, 'success', { to: deviceUrl(deviceId) })
      onChange?.(null)
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [deviceId, deviceName, path, onChange, showToast])

  const onDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    if (!canManage || busy) return
    handleFile(event.dataTransfer?.files?.[0])
  }

  const onDragOver = (event) => {
    // preventDefault on BOTH dragover and drop, or the browser navigates to the dropped file and
    // the page is simply gone.
    event.preventDefault()
    if (canManage && !busy) setDragging(true)
  }

  // `?download=` rather than the bare public URL -- see model3dDownloadUrl() for why the
  // `download` attribute alone cannot do this across origins.
  const downloadUrl = path ? model3dDownloadUrl(path) : null

  return (
    /* No heading of its own: the container prints the section label (Model3DLabel). */
    <div>
      {/* The model itself, above the controls. Only rendered when something is attached; the
          dropzone is the empty state. Expand sits in its top-right corner, as the section has no
          heading row of its own. */}
      {path && (
        <div className="expand-frame">
          <Model3DViewer path={path} name={modelName} />
          <ExpandButton kind="model" name={modelName} onClick={() => setExpanded(true)} />
        </div>
      )}
      {path && expanded && (
        <Modal title={modelName || '3D model'} icon={<IconCube size={18} />} size="full" fill onClose={() => setExpanded(false)}>
          <div className="model-viewer-expanded modal-fill">
            <Model3DViewer path={path} name={modelName} expanded />
          </div>
        </Modal>
      )}

      {path ? (
        <div className="model-file">
          {/* One line under the viewer. A long name is cut short; Download's tooltip names it
              whole. */}
          <div className="model-file-name">
            <span className="model-file-name-text">{modelFileName(path)}</span>
            <span className="model-file-size">{size !== null ? formatFileSize(size) : 'size unavailable'}</span>
          </div>
          {/* Outside the `canManage` gate: reading a public-read object is not a write, and
              Operators and Auditors are the roles most likely to open a model. A row of their own,
              in equal columns across the section; in a drawer too narrow for three words they show
              their icons only, the word kept as each button's name. */}
          <div className="model-file-actions">
            {downloadUrl && (
              <Tooltip text={`Save ${modelFileName(path)} to this computer`}>
                <a
                  className="btn btn-sm btn-primary"
                  href={downloadUrl}
                  /* `download` is ignored cross-origin, so `?download=` on the URL is what sets
                     Content-Disposition; the attribute applies if the bucket is ever served
                     same-origin. */
                  download={modelFileName(path)}
                >
                  <IconDownload size={12} /> <span className="model-file-action-word">Download</span>
                </a>
              </Tooltip>
            )}
            {canManage && (
              <>
                <Tooltip text="Upload a different model in place of this one">
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => inputRef.current?.click()}
                  >
                    <IconUpload size={12} /> <span className="model-file-action-word">Replace</span>
                  </button>
                </Tooltip>
                {/* `busy` covers upload AND removal -- both write to the same device row -- but
                    only Remove can report, because Replace merely opens the file picker. */}
                <ActionButton
                  className="btn btn-sm btn-ghost"
                  pending={busy}
                  pendingLabel="Removing…"
                  onClick={handleRemove}
                  title="Detach this model and delete it from storage"
                >
                  <IconTrash size={12} /> <span className="model-file-action-word">Remove</span>
                </ActionButton>
              </>
            )}
          </div>
        </div>
      ) : (
        /* The AAS consequence, as context for the gesture, is the tooltip; the storage sentence is
           in the zone itself, where the decision to upload is made. */
        <Tooltip text="Attached models are exported as an AAS VisualRepresentation submodel">
          <div
            className="model-drop"
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={() => setDragging(false)}
            onClick={() => canManage && !busy && inputRef.current?.click()}
            role="button"
            tabIndex={canManage ? 0 : -1}
            aria-label="Upload a 3D model"
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && canManage && !busy) {
                e.preventDefault()
                inputRef.current?.click()
              }
            }}
            style={{
              borderColor: dragging ? 'var(--accent)' : 'var(--border)',
              background: dragging ? 'var(--bg-surface)' : 'transparent',
              cursor: canManage && !busy ? 'pointer' : 'not-allowed',
              opacity: canManage ? 1 : 0.6
            }}
          >
            <IconUpload size={22} />
            <div className="model-drop-prompt">
              {busy
                ? 'Uploading…'
                : canManage
                  ? 'Drop a 3D model here, or click to browse'
                  : 'No 3D model attached'}
            </div>
            <div className="model-drop-limits">
              {MODEL_3D_EXTENSIONS.join(', ')} · up to {formatFileSize(MAX_BYTES)}
            </div>
            {canManage && <div className="model-drop-note">{MODEL_STORAGE_NOTE}</div>}
          </div>
        </Tooltip>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--warning-text)', marginTop: '8px' }}>
          <IconAlertTriangle size={13} /> {error}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={MODEL_3D_EXTENSIONS.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0])}
        data-testid="model-3d-input"
      />
    </div>
  )
}

/**
 * The section label a page prints above Model3DUploader. With a model `attached`, a "Public" marker
 * at its right whose tip is the storage note, for every role; without one, the drop zone says it.
 */
export function Model3DLabel({ attached = false }) {
  return (
    <div className="context-panel-section-label context-panel-section-label-icon">
      <IconCube size={13} /> 3D Model
      {attached && (
        <HelpTip text={MODEL_STORAGE_NOTE}>
          <IconGlobe size={11} /> Public
        </HelpTip>
      )}
    </div>
  )
}
