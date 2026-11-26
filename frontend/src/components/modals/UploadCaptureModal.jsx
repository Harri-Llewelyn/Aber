import React, { useEffect, useId, useState } from 'react'
import { captureManifest, captureFileProblem } from '../../api'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { DropZone } from '../common/DropZone'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { TypedGate, useTypedGate } from '../common/TypedGate'
import { IconPlay, IconUpload } from '../common/Icons'
import { CAPTURE_FILE, CAPTURE_FILE_LIMIT } from '../../utils/captureFile'
import { plural } from '../../utils/format'
import { deviceIdKey } from '../../utils/sparkplugId'

/** A subject's value in the list, '' for none. */
const keyOf = (subject) => (subject ? `${subject.kind}:${subject.id}` : '')

/**
 * The subject a file's own `identities` name, when this site has it, or null. A device is looked for
 * before its gateway. captureFileProblem() does not read `identities`, so each may be anything.
 */
const subjectNamedBy = (doc, subjects) => [doc?.identities?.devices, doc?.identities?.edge_nodes]
  .flatMap(ids => (Array.isArray(ids) ? ids : []))
  .map(id => subjects.find(s => s.sparkplugId === id)).find(Boolean) ?? null

/**
 * Take a capture file and file it against a subject. A capture is stored per subject, so the dialog
 * asks which one; that also makes a page-level drop zone possible. It validates the file before
 * asking with the rules playback applies (`captureFileProblem`), though `uploadCapture()` checks
 * again on the way out since it is reachable from elsewhere. The replace warning and its typed gate
 * guard the same decision StartCaptureModal's do, and the server makes it again before anything is
 * written.
 *
 * `file` is null until one is chosen in the dialog's own zone, which hands it to `onFile`. Another file
 * takes its place there. The subject offered is `presetSubject`, or else the one the file names.
 *
 * `forPlayback` is the "Play a File…" path: the file is stored to be played back at once, so a
 * file naming a device this site does not have (`knownDeviceIds`) is refused here, before it can
 * replace a stored capture with one that cannot play.
 */
export function UploadCaptureModal({ file, subjects, presetSubject, forPlayback = false, knownDeviceIds = null, onFile, onConfirm, onCancel }) {
  const uid = useId()
  // What was read, and the file it was read from: nothing is known of a later file until it is read.
  const [read, setRead] = useState({ file: null, doc: null, problem: null })
  // The subject chosen by hand, and the one it was chosen over.
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()

  // Read once, here, so the summary below and the manifest sent on submit come from the same parse.
  useEffect(() => {
    if (!file) return undefined
    let cancelled = false
    const done = (doc, problem) => { if (!cancelled) setRead({ file, doc, problem }) }
    file.text()
      .then(text => {
        const doc = JSON.parse(text)
        const problem = captureFileProblem(doc)
        if (problem) throw new Error(problem)
        done(doc, null)
      })
      .catch(err => done(null, err instanceof SyntaxError
        ? `"${file.name}" is not valid JSON. Record one with: python ingestion/capture.py record --out <file>`
        : err.message))
    return () => { cancelled = true }
  }, [file])

  const reading = Boolean(file) && read.file !== file
  const parsed = file && !reading ? read.doc : null
  // A choice made by hand stands until a file names a subject of its own, which is then offered.
  const offered = keyOf(presetSubject ?? subjectNamedBy(parsed, subjects))
  const subjectKey = picked && (!offered || picked.over === offered) ? picked.key : offered
  const subject = subjects.find(s => keyOf(s) === subjectKey) || null
  const manifest = parsed ? captureManifest(parsed) : null
  // A replay lane stands in for a device that exists here, under any id it publishes; one with no
  // original cannot be made.
  const unknownDevices = forPlayback && manifest && knownDeviceIds
    ? manifest.device_ids.filter(id => !knownDeviceIds.has(deviceIdKey(id)))
    : []
  const ready = !!parsed && !!subject && unknownDevices.length === 0
  const gate = useTypedGate(ready && subject.capture ? subject.name : null, `${subject?.kind} name`)
  const check = useFormCheck({
    file: {
      id: `${uid}-file`,
      missing: !file ? 'Choose a file to play.'
        : reading ? 'Reading the file…'
          : unknownDevices.length > 0 && 'This file records devices this site does not have.',
      wrong: file && !reading && read.problem,
    },
    subject: { id: 'upload-subject', missing: !subject && 'Choose a gateway or device to file it against' },
  })

  // What was typed and refused were about the file before this one.
  const choose = (next) => {
    gate.setTyped('')
    setError(null)
    onFile(next)
  }

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
      title={forPlayback ? 'Play a File' : 'Upload Capture'}
      icon={forPlayback ? <IconPlay size={18} /> : <IconUpload size={18} />}
      busy={pending}
      onClose={onCancel}
      lead={forPlayback
        ? 'Stores the file as a capture, then goes on to play it back. Every device the file recorded must exist on this site: a playback stands each one in with a replay lane of that device.'
        : null}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton
          className={subject?.capture ? 'btn btn-danger' : 'btn btn-primary'}
          pending={pending}
          pendingLabel="Uploading…"
          disabled={!gate.open}
          title={gate.reason}
          onClick={() => check.press(submit)}
        >
          {subject?.capture ? 'Replace and Upload' : 'Upload Capture'}
        </ActionButton>
      }
    >
      <div className="form-group">
        <label className="form-label" id={`${uid}-file-label`} htmlFor={`${uid}-file`}>File <RequiredMark /></label>
        <DropZone
          {...CAPTURE_FILE}
          id={`${uid}-file`}
          labelledBy={`${uid}-file-label`}
          required
          hint={`A .json file, up to ${CAPTURE_FILE_LIMIT}`}
          onFile={choose}
          fileName={file?.name ?? null}
          busy={reading && 'Reading the file…'}
          error={check.errors.file}
          disabled={pending}
          testId="capture-upload-file"
        />
        {parsed && (
          <p className="form-hint">
            {plural(parsed.messages.length, 'message')}
            {manifest?.device_ids?.length
              ? `, ${plural(manifest.device_ids.length, 'device id')}`
              : ', no device-level traffic'}
            {manifest && !manifest.birth_captured && ' — no birth certificate'}
          </p>
        )}
      </div>

      {unknownDevices.length > 0 && (
        <Callout tone="danger">
          This file records {plural(unknownDevices.length, 'device')} this site does not have:{' '}
          <span className="mono">{unknownDevices.join(', ')}</span>. It cannot be played back
          here. A playback stands each recorded device in with a replay lane of the same device on
          this site, so a capture from another site has nothing to stand in for. Nothing has been
          stored.
        </Callout>
      )}

      {/* A birthless file stores; playback refuses it (plan_playback()). */}
      {parsed && manifest && !manifest.birth_captured && (
        <Callout tone="warning">
          This capture contains no <code>NBIRTH</code>, so a playback refuses it: a replay opens
          with the edge node&apos;s birth certificate. It can still be stored.
        </Callout>
      )}

      {parsed && unknownDevices.length === 0 && (
        <div className="form-group">
          <label className="form-label" htmlFor="upload-subject">File It Against <RequiredMark /></label>
          <select
            id="upload-subject"
            className="form-control"
            value={subjectKey}
            onChange={e => { setPicked({ key: e.target.value, over: offered }); gate.setTyped('') }}
            disabled={pending}
            aria-required="true"
            {...fieldErrorProps(check.errors.subject, 'upload-subject-error', 'upload-subject-hint')}
          >
            <option value="">Choose a gateway or device…</option>
            <optgroup label="Gateways">
              {subjects.filter(s => s.kind === 'gateway').map(s => (
                <option key={keyOf(s)} value={keyOf(s)}>
                  {s.name}{s.capture ? ' — replaces the stored capture' : ''}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {subjects.filter(s => s.kind === 'device').map(s => (
                <option key={keyOf(s)} value={keyOf(s)}>
                  {s.name}{s.capture ? ' — replaces the stored capture' : ''}
                </option>
              ))}
            </optgroup>
          </select>
          <p id="upload-subject-hint" className="form-hint">
            A capture is stored per subject, under that subject&apos;s own prefix. A subject being
            recorded cannot take an upload until the recording ends.
          </p>
          <FieldError id="upload-subject-error" error={check.errors.subject} />
        </div>
      )}

      {/* The same decision StartCaptureModal guards: an upload destroys a stored capture exactly as
          a re-record does. */}
      {subject?.capture && (
        <Callout tone="warning">
          This replaces the capture of <strong>{subject.name}</strong>
          {subject.capture.note ? <> — <strong>{subject.capture.note}</strong></> : null}.
          That recording is destroyed and cannot be recovered.
        </Callout>
      )}

      <TypedGate gate={gate} disabled={pending} />
    </Modal>
  )
}
