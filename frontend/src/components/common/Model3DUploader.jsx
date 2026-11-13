import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, model3dPublicUrl, model3dDownloadUrl } from '../../api'
import {
  MODEL_3D_EXTENSIONS,
  formatFileSize,
  isAcceptedModelFile,
  modelFileName
} from '../../utils/model3d'
import { IconCube, IconUpload, IconTrash, IconDownload, IconGlobe } from './Icons'
import { ActionButton } from './ActionButton'
import { Model3DViewer } from './Model3DViewer'
import { HelpTip } from './HelpTip'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { deviceUrl } from '../../routes'

/** Where an attached model is kept, and so who can read it. */
export const MODEL_STORAGE_NOTE =
  'Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.'

// The bucket's own limit, mirrored. Kept as a constant rather than read from the bucket because
// fetching it would be a round trip per render for a value that changes once a deployment.
const MAX_BYTES = 50 * 1024 * 1024

/**
 * A device's 3D model in a window-sized dialog: the viewer and the attached file's controls, or,
 * with nothing attached, the drop zone. The device drawer's View 3D Model and Add 3D Model…
 * actions open it, and nothing here loads before that: the viewer, its module, the model file and
 * the size lookup all start when the dialog mounts, and stop when it unmounts.
 *
 * The model becomes an AAS `File` element in a `VisualRepresentation` submodel on export, so the
 * bucket is public-read: the empty drop zone says so in full to someone who may upload, and with a
 * model attached a "Public" marker carries the same note, for every role. Size is checked here as
 * well as on the bucket, so an oversized file is refused before the upload rather than after.
 *
 * @param {object} device  The device row; `model_3d_path` is read each render, so the dialog turns
 *                         from the drop zone to the viewer when the parent reloads after an upload.
 * @param {boolean} canManage  May attach, replace and remove. Download and viewing need nothing.
 * @param {Function} onChange  Called with the new path after an upload, and null after a removal.
 * @param {Function} onClose   Closes the dialog; also called once a removal has finished.
 */
export function Model3DUploader({ device, canManage, showToast, onChange, onClose }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const [size, setSize] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const inputRef = useRef(null)

  const path = device?.model_3d_path || null
  const deviceId = device?.asset_id || device?.id
  const deviceName = device?.asset_name
  const modelName = device?.asset_name || device?.name

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

  // Run from the Remove dialog, which shows a refusal and stays open. The dialog closes once the
  // model is gone, so the success toast, which a dialog would hide, is where the person is looking.
  const handleRemove = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.removeDeviceModel(deviceId, path)
      setConfirmRemove(false)
      setSize(null)
      showToast?.(`3D model removed${deviceName ? ` from '${deviceName}'` : ''}`, 'success', { to: deviceUrl(deviceId) })
      onChange?.(null)
      onClose?.()
    } finally {
      setBusy(false)
    }
  }, [deviceId, deviceName, path, onChange, onClose, showToast])

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
    <>
      <Modal
        title={modelName || '3D model'}
        icon={<IconCube size={18} />}
        size="full"
        fill
        error={error}
        onClose={onClose}
      >
        {path ? (
          <>
            <div className="model-file">
              {/* Wraps rather than cuts: the dialog has the width, and a name is what the buttons
                  beside it act on. */}
              <div className="model-file-name">
                <span className="model-file-name-text">{modelFileName(path)}</span>
                <span>{size !== null ? formatFileSize(size) : 'size unavailable'}</span>
                <HelpTip text={MODEL_STORAGE_NOTE}>
                  <IconGlobe size={11} /> Public
                </HelpTip>
              </div>
              {/* Outside the `canManage` gate: reading a public-read object is not a write, and
                  Operators and Auditors are the roles most likely to open a model. */}
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
                      <IconDownload size={12} /> Download
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
                        <IconUpload size={12} /> Replace
                      </button>
                    </Tooltip>
                    {/* `busy` covers upload AND removal -- both write to the same device row -- but
                        only Remove can report, because Replace merely opens the file picker. */}
                    <ActionButton
                      className="btn btn-sm btn-ghost"
                      pending={busy}
                      pendingLabel="Removing…"
                      onClick={() => setConfirmRemove(true)}
                      title="Detach this model and delete it from storage"
                    >
                      <IconTrash size={12} /> Remove
                    </ActionButton>
                  </>
                )}
              </div>
            </div>
            <div className="model-viewer-expanded modal-fill">
              <Model3DViewer path={path} name={modelName} />
            </div>
          </>
        ) : (
          /* The AAS consequence, as context for the gesture, is the tooltip; the storage sentence is
             in the zone itself, where the decision to upload is made. */
          <Tooltip text="Attached models are exported as an AAS VisualRepresentation submodel">
            <div
              className="model-drop modal-fill"
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

        <input
          ref={inputRef}
          type="file"
          accept={MODEL_3D_EXTENSIONS.join(',')}
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files?.[0])}
          data-testid="model-3d-input"
        />
      </Modal>
      {path && confirmRemove && (
        <ConfirmModal
          title="Remove 3D model"
          icon={<IconTrash size={18} />}
          message={`Remove the 3D model from ${modelName || 'this device'}? The device keeps its other details, and the file is deleted.`}
          confirmLabel="Remove Model"
          pendingLabel="Removing…"
          onConfirm={handleRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  )
}
