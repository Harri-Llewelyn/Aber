import React, { useCallback, useEffect, useState } from 'react'
import { api, model3dPublicUrl, model3dDownloadUrl } from '../../api'
import {
  MODEL_3D_EXTENSIONS,
  formatFileSize,
  isAcceptedModelFile,
  modelFileName
} from '../../utils/model3d'
import { IconCube, IconUpload, IconTrash, IconDownload, IconGlobe } from './Icons'
import { ActionButton } from './ActionButton'
import { DropZone, useFilePicker } from './DropZone'
import { Model3DViewer } from './Model3DViewer'
import { HelpTip } from './HelpTip'
import { Modal } from './Modal'
import { Tooltip } from './Tooltip'
import { ConfirmModal } from '../modals/ConfirmModal'
import { deviceUrl } from '../../routes'
import { STORED_FILE_DELETED, STORED_FILE_REPLACED } from '../../utils/storedFile'

/** Where an attached model is kept, and so who can read it. */
export const MODEL_STORAGE_NOTE =
  'Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.'

// The bucket's own limit, mirrored. Kept as a constant rather than read from the bucket because
// fetching it would be a round trip per render for a value that changes once a deployment.
const MAX_BYTES = 50 * 1024 * 1024
const ACCEPT = MODEL_3D_EXTENSIONS.join(',')
const KINDS = MODEL_3D_EXTENSIONS.join(', ')

/** Why a file given as a model is refused before the upload, or null. */
const modelProblem = (file) => {
  if (!isAcceptedModelFile(file.name)) return `"${file.name}" is not a supported format. Accepted: ${KINDS}`
  return file.size > MAX_BYTES ? `"${file.name}" is ${formatFileSize(file.size)}; the limit is ${formatFileSize(MAX_BYTES)}.` : null
}

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
 * @param {object} [modelOf]  The device whose model is shown when it is not `device`'s own: a replay
 *                         lane shows its machine's. The dialog is then read-only, whoever asks, and
 *                         says whose model it is in place of the Public marker.
 * @param {boolean} canManage  May attach, replace and remove. Download and viewing need nothing.
 * @param {Function} onChange  Called with the new path after an upload, and null after a removal.
 * @param {Function} onClose   Closes the dialog; also called once a removal has finished.
 */
export function Model3DUploader({ device, modelOf, canManage: mayManage, showToast, onChange, onClose }) {
  // A model that is another device's is never changed from here.
  const canManage = mayManage && !modelOf
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [size, setSize] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // The file chosen in place of the attached one, until Replace's dialog is answered.
  const [replacement, setReplacement] = useState(null)

  const path = (modelOf || device)?.model_3d_path || null
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

  // Uploads a checked file and attaches it. A refusal is thrown, for whoever asked to show.
  const attach = useCallback(async (file) => {
    setBusy(true)
    setError(null)
    try {
      const { path: uploaded } = await api.uploadDeviceModel(deviceId, file)
      setReplacement(null)
      setSize(file.size)
      showToast?.(`3D model attached${deviceName ? ` to '${deviceName}'` : ''}: ${modelFileName(uploaded)}`, 'success', { to: deviceUrl(deviceId) })
      onChange?.(uploaded)
    } finally {
      setBusy(false)
    }
  }, [deviceId, deviceName, onChange, showToast])

  // The device's first model, from the drop zone. A refused upload is the dialog's error; a refused file
  // is said at the zone, and in a toast as that is.
  const handleFile = useCallback(async (file) => {
    setError(null)
    try {
      await attach(file)
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    }
  }, [attach, showToast])
  const handleRefused = (why) => { setError(null); showToast?.(why, 'error') }

  // Asked once the file has passed its checks, so a person who cancels the picker is asked nothing.
  const askToReplace = (file) => {
    const why = modelProblem(file)
    setError(why)
    if (why) showToast?.(why, 'error')
    else setReplacement(file)
  }
  const replace = useFilePicker({ accept: ACCEPT, onFile: askToReplace, testId: 'model-3d-input' })

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

  // `?download=` rather than the bare public URL -- see model3dDownloadUrl() for why the
  // `download` attribute alone cannot do this across origins.
  const downloadUrl = path ? model3dDownloadUrl(path) : null

  // The machine's model went while a lane's dialog was open: the parent closes it, and until then
  // there is no drop zone to offer.
  if (modelOf && !path) return null

  return (
    <>
      <Modal
        title={modelName || '3D Model'}
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
                {modelOf ? (
                  <span>{`${modelOf.asset_name || modelOf.name}'s model`}</span>
                ) : (
                  <HelpTip text={MODEL_STORAGE_NOTE}>
                    <IconGlobe size={11} /> Public
                  </HelpTip>
                )}
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
                        onClick={replace.open}
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
            {/* Not drawn for another device's model: nothing here may attach a file to it. */}
            {!modelOf && replace.picker}
          </>
        ) : (
          /* The whole note is in the zone, where the decision to upload is made. */
          <DropZone
            className="modal-fill"
            label="Upload a 3D model"
            prompt={canManage ? 'Drop a 3D model here, or click to choose one' : 'No 3D model attached'}
            hint={`${KINDS} · up to ${formatFileSize(MAX_BYTES)}`}
            note={canManage ? `Attached models are exported as an AAS VisualRepresentation submodel. ${MODEL_STORAGE_NOTE}` : null}
            accept={ACCEPT}
            kinds={`one of ${KINDS}`}
            refuse={modelProblem}
            onRefuse={handleRefused}
            onFile={handleFile}
            busy={busy && 'Uploading…'}
            disabled={!canManage}
            testId="model-3d-input"
          />
        )}
      </Modal>
      {path && replacement && (
        <ConfirmModal
          title="Replace 3D Model"
          icon={<IconUpload size={18} />}
          message={`Replace the 3D model of ${modelName || 'this device'} with "${replacement.name}"? ${STORED_FILE_REPLACED}`}
          confirmLabel="Replace Model"
          pendingLabel="Replacing…"
          onConfirm={() => attach(replacement)}
          onCancel={() => setReplacement(null)}
        />
      )}
      {path && confirmRemove && (
        <ConfirmModal
          title="Remove 3D Model"
          icon={<IconTrash size={18} />}
          message={`Remove the 3D model from ${modelName || 'this device'}? The device keeps its other details. ${STORED_FILE_DELETED}`}
          confirmLabel="Remove Model"
          pendingLabel="Removing…"
          onConfirm={handleRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  )
}
