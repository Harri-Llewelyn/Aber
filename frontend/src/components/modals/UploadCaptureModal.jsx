import React, { useState } from 'react'
import { captureManifest, CAPTURE_VERSION } from '../../api'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconShieldAlert } from '../common/Icons'

/**
 * Take a capture file and file it against a subject. A capture is stored per subject, so the dialog
 * asks which one; that also makes a page-level drop zone possible. It validates the file before
 * asking, though `uploadCapture()` checks again on the way out since it is reachable from
 * elsewhere. The replace warning guards the same decision StartCaptureModal does.
 */
export function UploadCaptureModal({ file, subjects, presetSubject, onConfirm, onCancel }) {
  const [subjectKey, setSubjectKey] = useState(
    presetSubject ? `${presetSubject.kind}:${presetSubject.id}` : ''
  )
  const [parsed, setParsed] = useState(undefined)   // undefined = still reading
  const [readError, setReadError] = useState(null)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  useEscapeKey(pending ? () => {} : onCancel)

  // Read once, here, so the summary below and the manifest sent on submit come from the same parse.
  React.useEffect(() => {
    let cancelled = false
    file.text()
      .then(text => {
        const doc = JSON.parse(text)
        if (doc?.acs_capture_version === undefined) {
          throw new Error('That file carries no acs_capture_version, so it is not a broker capture.')
        }
        if (doc.acs_capture_version !== CAPTURE_VERSION) {
          throw new Error(
            `That capture is version ${doc.acs_capture_version} and this stack reads version ` +
            `${CAPTURE_VERSION}. capture.py refuses a version it does not know rather than ` +
            'guessing at the difference.'
          )
        }
        if (!Array.isArray(doc.messages) || doc.messages.length === 0) {
          throw new Error('That capture contains no messages, so there would be nothing to play back.')
        }
        if (!cancelled) setParsed(doc)
      })
      .catch(err => {
        if (cancelled) return
        setParsed(null)
        setReadError(
          err instanceof SyntaxError
            ? `"${file.name}" is not valid JSON. Record one with: python ingestion/capture.py record --out <file>`
            : err.message
        )
      })
    return () => { cancelled = true }
  }, [file])

  const subject = subjects.find(s => `${s.kind}:${s.id}` === subjectKey) || null
  const manifest = parsed ? captureManifest(parsed) : null
  const ready = !!parsed && !!subject

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ subject, replace: !!subject.capture })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <div className="modal-overlay">
      <div className="modal modal-sm">
        <div className="modal-title">Upload capture</div>

        <p className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '10px 0 0' }}>
          {file.name}
        </p>

        {parsed === undefined && (
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Reading…</p>
        )}

        {readError && (
          <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)', marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>{readError}</div>
          </div>
        )}

        {parsed && (
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {parsed.messages.length} message{parsed.messages.length === 1 ? '' : 's'}
            {manifest?.device_ids?.length
              ? `, ${manifest.device_ids.length} device id${manifest.device_ids.length === 1 ? '' : 's'}`
              : ', no device-level traffic'}
            {manifest && !manifest.birth_captured && ' — no birth certificate'}
          </p>
        )}

        {/* Only when the capture actually depends on the alias table -- see StartPlaybackModal. */}
        {parsed && manifest && !manifest.birth_captured && manifest.uses_aliases && (
          <div className="callout callout-warning" style={{ marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              This capture contains no <code>NBIRTH</code> or <code>DBIRTH</code> and its metrics are
              carried by <strong>alias</strong>. A playback will drop every one of them and still
              report success.
            </div>
          </div>
        )}

        {parsed && (
          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label" htmlFor="upload-subject">File it against</label>
            <select
              id="upload-subject"
              className="form-control"
              value={subjectKey}
              onChange={e => setSubjectKey(e.target.value)}
              disabled={pending}
            >
              <option value="">Choose a gateway or device…</option>
              <optgroup label="Gateways">
                {subjects.filter(s => s.kind === 'gateway').map(s => (
                  <option key={`gateway:${s.id}`} value={`gateway:${s.id}`}>
                    {s.name}{s.capture ? ' — replaces the stored capture' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Devices">
                {subjects.filter(s => s.kind === 'device').map(s => (
                  <option key={`device:${s.id}`} value={`device:${s.id}`}>
                    {s.name}{s.capture ? ' — replaces the stored capture' : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
              A capture is stored per subject, and the file is filed under that subject's own
              prefix — which is what the storage policy checks.
            </p>
          </div>
        )}

        {/* The same decision StartCaptureModal guards, naming the same facts: an upload destroys a
            stored capture exactly as a re-record does. */}
        {subject?.capture && (
          <div className="callout callout-warning" style={{ marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              This replaces the capture of <strong>{subject.name}</strong>
              {subject.capture.note ? <> — <strong>{subject.capture.note}</strong></> : null}.
              That recording is destroyed and cannot be recovered.
            </div>
          </div>
        )}

        {error && (
          <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)', marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>{error}</div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={subject?.capture ? 'btn btn-danger' : 'btn btn-primary'}
            pending={pending}
            pendingLabel="Uploading…"
            disabled={!ready}
            title={ready ? undefined : (readError ? 'This file is not a capture' : 'Choose a subject')}
            onClick={submit}
          >
            {subject?.capture ? 'Replace and upload' : 'Upload'}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
