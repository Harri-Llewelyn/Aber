import React, { useState } from 'react'
import { captureManifest, CAPTURE_VERSION } from '../../api'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconShieldAlert } from '../common/Icons'

/**
 * Take a capture file and file it against a subject.
 *
 * WHY A DIALOG RATHER THAN A BARE FILE PICKER. A capture is stored PER SUBJECT -- one per gateway,
 * one per device -- so a file on its own is not enough to store it: something has to say which
 * subject it belongs to. The old path answered that by hiding a file input behind a per-row button,
 * which works and is invisible; this asks the question out loud, which also makes a page-level drop
 * zone possible.
 *
 * IT VALIDATES BEFORE IT ASKS ANYTHING. `uploadCapture()` checks the same things again on the way
 * out -- it has to, because it is also reachable from elsewhere -- but a file that is not a capture
 * should be refused before the operator has chosen a subject for it, not after.
 *
 * THE REPLACE WARNING IS THE SAME DECISION `StartCaptureModal` GUARDS, and it names the same facts:
 * a stored capture of a rare fault can be destroyed by an upload just as easily as by a re-record.
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

        {parsed && manifest && !manifest.birth_captured && (
          <div className="callout callout-warning" style={{ marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              This capture contains no <code>NBIRTH</code> or <code>DBIRTH</code>. If the recorded
              gateway used metric aliases, a playback will drop every metric and still report success.
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
