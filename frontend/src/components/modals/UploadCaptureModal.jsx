import React, { useState } from 'react'
import { captureManifest, captureFileProblem } from '../../api'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconShieldAlert, IconUpload } from '../common/Icons'
import { plural } from '../../utils/format'
import { deviceIdKey } from '../../utils/sparkplugId'

/**
 * Take a capture file and file it against a subject. A capture is stored per subject, so the dialog
 * asks which one; that also makes a page-level drop zone possible. It validates the file before
 * asking with the rules playback applies (`captureFileProblem`), though `uploadCapture()` checks
 * again on the way out since it is reachable from elsewhere. The replace warning guards the same
 * decision StartCaptureModal does, and the server makes it again before anything is written.
 *
 * `forPlayback` is the "Play a file…" path: the file is stored to be played back at once, so a
 * file naming a device this site does not have (`knownDeviceIds`) is refused here, before it can
 * replace a stored capture with one that cannot play.
 */
export function UploadCaptureModal({ file, subjects, presetSubject, forPlayback = false, knownDeviceIds = null, onConfirm, onCancel }) {
  const [subjectKey, setSubjectKey] = useState(
    presetSubject ? `${presetSubject.kind}:${presetSubject.id}` : ''
  )
  const [parsed, setParsed] = useState(undefined)   // undefined = still reading
  const [readError, setReadError] = useState(null)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  // Read once, here, so the summary below and the manifest sent on submit come from the same parse.
  React.useEffect(() => {
    let cancelled = false
    file.text()
      .then(text => {
        const doc = JSON.parse(text)
        const problem = captureFileProblem(doc)
        if (problem) throw new Error(problem)
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
  // A replay lane stands in for a device that exists here, under any id it publishes; one with no
  // original cannot be made.
  const unknownDevices = forPlayback && manifest && knownDeviceIds
    ? manifest.device_ids.filter(id => !knownDeviceIds.has(deviceIdKey(id)))
    : []
  const ready = !!parsed && !!subject && unknownDevices.length === 0

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ subject, replace: !!subject.capture, expectedCaptureId: subject.capture?.id || null })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Upload capture"
      icon={<IconUpload size={18} />}
      size="sm"
      onClose={pending ? () => {} : onCancel}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className={subject?.capture ? 'btn btn-danger' : 'btn btn-primary'}
            pending={pending}
            pendingLabel="Uploading…"
            disabled={!ready}
            title={ready ? undefined : (
              readError ? 'This file is not a capture'
                : unknownDevices.length > 0 ? 'This file records devices this site does not have'
                  : 'Choose a subject'
            )}
            onClick={submit}
          >
            {subject?.capture ? 'Replace and upload' : 'Upload'}
          </ActionButton>
        </>
      }
    >
      <p className="mono form-hint">{file.name}</p>

      {parsed === undefined && <p className="form-hint">Reading…</p>}

      {readError && (
        <div className="callout callout-danger">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>{readError}</div>
        </div>
      )}

      {parsed && (
        <p className="form-hint">
          {plural(parsed.messages.length, 'message')}
          {manifest?.device_ids?.length
            ? `, ${plural(manifest.device_ids.length, 'device id')}`
            : ', no device-level traffic'}
          {manifest && !manifest.birth_captured && ' — no birth certificate'}
        </p>
      )}

      {forPlayback && parsed && unknownDevices.length === 0 && (
        <p className="form-hint">
          Every device the file recorded must exist on this site. A playback stands each one in
          with a replay lane of that device.
        </p>
      )}

      {unknownDevices.length > 0 && (
        <div className="callout callout-danger">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            This file records {plural(unknownDevices.length, 'device')} this site does not have:{' '}
            <span className="mono">{unknownDevices.join(', ')}</span>. It cannot be played back
            here. A playback stands each recorded device in with a replay lane of the same device on
            this site, so a capture from another site has nothing to stand in for. Nothing has been
            stored.
          </div>
        </div>
      )}

      {/* A birthless file stores; playback refuses it (plan_playback()). */}
      {parsed && manifest && !manifest.birth_captured && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            This capture contains no <code>NBIRTH</code>, so a playback refuses it: a replay opens
            with the edge node&apos;s birth certificate. It can still be stored.
          </div>
        </div>
      )}

      {parsed && unknownDevices.length === 0 && (
        <div className="form-group">
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
          <p className="form-hint">
            A capture is stored per subject, under that subject&apos;s own prefix. A subject being
            recorded cannot take an upload until the recording ends.
          </p>
        </div>
      )}

      {/* The same decision StartCaptureModal guards: an upload destroys a stored capture exactly as
          a re-record does. */}
      {subject?.capture && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            This replaces the capture of <strong>{subject.name}</strong>
            {subject.capture.note ? <> — <strong>{subject.capture.note}</strong></> : null}.
            That recording is destroyed and cannot be recovered.
          </div>
        </div>
      )}
    </Modal>
  )
}
