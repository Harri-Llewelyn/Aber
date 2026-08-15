import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, model3dPublicUrl } from '../../api'
import {
  MODEL_3D_EXTENSIONS,
  formatFileSize,
  isAcceptedModelFile,
  modelFileName
} from '../../utils/model3d'
import { IconCube, IconUpload, IconTrash, IconExternalLink, IconAlertTriangle } from './Icons'
import { ActionButton } from './ActionButton'

/**
 * Attach one 3D visual model to a device.
 *
 * The model becomes an AAS `File` element in a `VisualRepresentation` submodel on export, so this
 * is a publishing action, not just a convenience upload: the bucket is public-read (an arbitrary
 * AAS viewer has to be able to dereference the URL), and the banner says so rather than leaving an
 * operator to discover it from the migration.
 *
 * SIZE IS CHECKED HERE AS WELL AS ON THE BUCKET, and neither check is redundant. The bucket's
 * limit is the control -- it cannot be bypassed. This one exists so a 200 MB file is refused
 * instantly instead of after the operator has waited out a doomed upload.
 */
export function Model3DUploader({ device, canManage, showToast, onChange }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const [size, setSize] = useState(null)
  const inputRef = useRef(null)

  const path = device?.model_3d_path || null
  const deviceId = device?.asset_id || device?.id

  // The bucket's own limit, mirrored. Kept as a constant rather than read from the bucket because
  // fetching it would be a round trip per render for a value that changes once a deployment.
  const MAX_BYTES = 50 * 1024 * 1024

  /**
   * The stored size, fetched rather than remembered from the upload. A model attached in an
   * earlier session -- or by another user -- has no size in this component's state, and reporting
   * "attached" with no size while reporting it with one for a fresh upload would be an
   * inconsistency the operator has to explain to themselves.
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
      showToast?.(`3D model attached: ${modelFileName(uploaded)}`, 'success')
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
  }, [deviceId, onChange, showToast])

  const handleRemove = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await api.removeDeviceModel(deviceId, path)
      setSize(null)
      showToast?.('3D model removed', 'success')
      onChange?.(null)
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [deviceId, path, onChange, showToast])

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

  const publicUrl = path ? model3dPublicUrl(path) : null

  return (
    /* NO HEADING OF ITS OWN. This used to carry "3D Visual Model" plus a line explaining that the
       file becomes an AAS VisualRepresentation submodel -- two rows of chrome above a dropzone, in
       a 360px column, restating the section label its container already prints beside the icon.
       The AAS fact has not been lost: it is on the dropzone's own title, and the public-read
       banner below still states the consequence that actually affects a decision. */
    <div>
      {path ? (
        <div
          className="card"
          style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}
        >
          <IconCube size={22} />
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            {/* The filename can be long and this sits in a modal that scrolls horizontally --
                constrain it, or the buttons are pushed off-screen. */}
            <div style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Model attached: {modelFileName(path)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {size !== null ? formatFileSize(size) : 'size unavailable'}
              {publicUrl && (
                <>
                  {' · '}
                  <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                    Open <IconExternalLink size={10} />
                  </a>
                </>
              )}
            </div>
          </div>
          {canManage && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                title="Upload a different model in place of this one"
              >
                <IconUpload size={12} /> Replace
              </button>
              {/* `busy` covers upload AND removal -- both write to the same device row -- but only
                  Remove can report, because Replace merely opens the file picker. */}
              <ActionButton
                className="btn btn-ghost"
                pending={busy}
                pendingLabel="Removing…"
                onClick={handleRemove}
                title="Detach this model and delete it from storage"
              >
                <IconTrash size={12} /> Remove
              </ActionButton>
            </div>
          )}
        </div>
      ) : (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onClick={() => canManage && !busy && inputRef.current?.click()}
          role="button"
          tabIndex={canManage ? 0 : -1}
          aria-label="Upload a 3D model"
          /* Where the removed heading's second line went. The AAS consequence still matters --
             this is a publishing action, not a convenience upload -- but it is context for the
             gesture rather than two permanent rows above it. */
          title="Attached models are exported as an AAS VisualRepresentation submodel"
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && canManage && !busy) {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          style={{
            border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
            background: dragging ? 'var(--bg-surface)' : 'transparent',
            borderRadius: '8px',
            padding: '20px',
            textAlign: 'center',
            cursor: canManage && !busy ? 'pointer' : 'not-allowed',
            opacity: canManage ? 1 : 0.6,
            transition: 'border-color 120ms, background 120ms'
          }}
        >
          <IconUpload size={22} />
          <div style={{ fontSize: '13px', marginTop: '6px' }}>
            {busy
              ? 'Uploading…'
              : canManage
                ? 'Drop a 3D model here, or click to browse'
                : 'No 3D model attached'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {MODEL_3D_EXTENSIONS.join(', ')} · up to {formatFileSize(MAX_BYTES)}
          </div>
        </div>
      )}

      {canManage && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Stored in the public <span className="mono">asset-3d-models</span> bucket so exported
          shells can be opened by any AAS viewer — anyone with the link can read it.
        </div>
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
