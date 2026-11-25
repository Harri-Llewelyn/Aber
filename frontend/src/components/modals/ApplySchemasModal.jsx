import React, { useId, useMemo, useState } from 'react'
import { api } from '../../api'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { ApplyResults } from '../common/ApplyResults'
import { DropZone } from '../common/DropZone'
import { IconAlertTriangle, IconClipboardList } from '../common/Icons'
import { RequiredMark } from '../common/RequiredMark'
import { describeApply, useApplyPreview } from '../../hooks/useApplyPreview'
import { useFormCheck } from '../../hooks/useFormCheck'
import { useYamlFile } from '../../hooks/useYamlFile'
import { parseAutomationsYaml } from '../../utils/automationYaml'
import { plural } from '../../utils/format'
import { schemaUrl, tabUrl } from '../../routes'
import { refusedCount } from '../../utils/automations'
import {
  DEVICE_SCHEMAS_FILE_MAX_BYTES, appliedSchemaWords, removedDerivedMetrics, schemaResultName, schemaResultNote, writtenSchemas,
} from '../../utils/deviceSchemas'

/**
 * Uploads a file of schemas. Its first step is the file, in a drop zone. Then it shows what the file would
 * do, before it does anything: each schema as new, changed (a new draft version), unchanged or refused,
 * with every reason and the line it is on. The text is parsed here, and a syntax error is shown with its
 * line without asking the database. Otherwise the check is
 * `apply_device_schemas(doc, true)`, and confirming is the same call with `false`: all of it applies or
 * none of it does. It deletes nothing and never edits a published version. A refusal from the second
 * call, such as the second-factor switch's, is shown in the dialog as it was worded. The preview and its
 * list are the ones the Automations page's dialog draws (useApplyPreview, ApplyResults). Another file
 * chosen in the zone is checked in place of the one before.
 *
 * @param {Function} showToast Says the act once it is applied: an applied file writes Audit Trail rows, so it ends in a success toast that links to what it made.
 * @param {Function} onApplied Called with the results once everything is applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function ApplySchemasModal({ showToast, onApplied, onClose }) {
  const uid = useId()
  const upload = useYamlFile({ maxBytes: DEVICE_SCHEMAS_FILE_MAX_BYTES, holds: 'a file of schemas' })
  const source = upload.file?.name ?? null
  const parsed = useMemo(() => upload.file && parseAutomationsYaml(upload.file.text), [upload.file])
  const [preview, setPreview] = useApplyPreview(parsed, () => api.applyDeviceSchemas(parsed.document, true))
  const [applyError, setApplyError] = useState(null)
  const [applying, setApplying] = useState(false)
  const { results, refused, written, unread, checking, problem, held, unchanged, count } = describeApply(preview, parsed, 'schema')
  const check = useFormCheck({ file: { id: `${uid}-file`, missing: upload.missing } }, { unchanged })
  const removed = preview.phase === 'ready' ? removedDerivedMetrics(results) : null

  const confirm = async () => {
    setApplyError(null)
    setApplying(true)
    try {
      const done = await api.applyDeviceSchemas(parsed.document, false)
      // Another writer may have changed what the file refers to since the preview.
      if (refusedCount(done) > 0) {
        setPreview({ phase: 'ready', results: done, error: null })
        return
      }
      const made = writtenSchemas(done)
      showToast(appliedSchemaWords(done, source), 'success', { to: made.length === 1 ? schemaUrl(made[0].id) : tabUrl('schemas') })
      onApplied(done)
    } catch (e) {
      setApplyError(e.message || 'The schemas could not be applied.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={source ? `Apply ${source}` : 'Upload Schemas'}
      icon={<IconClipboardList size={18} />}
      size="lg"
      lead="Applies the whole file, all of it or none. A schema that exists is never edited: a changed one becomes a new draft version to publish when you are ready. It deletes nothing."
      problem={problem ?? check.problem}
      error={applyError}
      busy={applying}
      onClose={onClose}
      dismiss="Cancel"
      footer={(
        <ActionButton
          className="btn btn-primary"
          pending={applying || checking}
          pendingLabel={checking ? 'Checking…' : 'Applying…'}
          disabled={held}
          onClick={() => check.press(confirm)}
        >
          {parsed ? `Apply ${plural(written, 'Schema')}` : 'Apply Schemas'}
        </ActionButton>
      )}
    >
      <div className="form-group">
        <label className="form-label" id={`${uid}-file-label`} htmlFor={`${uid}-file`}>File <RequiredMark /></label>
        <DropZone
          id={`${uid}-file`}
          labelledBy={`${uid}-file-label`}
          required
          prompt="Drop a file of schemas here, or click to choose one"
          {...upload.zone}
          error={check.errors.file}
          disabled={applying}
          testId="schemas-file"
        />
      </div>

      {preview.phase === 'checking' && <p className="apply-note" role="status">Checking the file…</p>}
      {preview.phase === 'failed' && <p className="apply-note apply-note-problem" role="alert">{preview.error}</p>}

      {unread && (
        <ul className="apply-results" aria-label="Problems in the file">
          {parsed.errors.map((e, i) => (
            <li key={i} className="apply-result">
              <span className="apply-line mono">Line {e.line}</span>
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
      )}

      {preview.phase === 'ready' && (
        <>
          <p className="apply-summary" role="status">
            {count.map(s => `${s.n} ${s.label.toLowerCase()}`).join(', ') || 'The file holds no schema.'}
          </p>
          {written === 0 && refused === 0 && results.length > 0 && (
            <p className="apply-note">Every schema here is already as the file says. Nothing would change.</p>
          )}
          {removed && (
            <div className="callout callout-warning" role="status">
              <IconAlertTriangle size={13} className="callout-icon" />
              <div>
                This file removes {plural(removed.count, 'derived metric')}. Once the drafts are published, the devices bound to them
                no longer have {removed.count === 1 ? 'it' : 'them'}. A file says what is saved, and a file exported before Aber 1.10 names none.
                <ul className="apply-reasons">
                  {removed.schemas.map(s => (
                    <li key={s.name}><strong className="mono">{s.name}</strong>: <span className="mono">{s.metrics.join(', ')}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <ApplyResults
            results={results}
            parsed={parsed}
            label="What each schema would become"
            nameOf={schemaResultName}
            noteOf={schemaResultNote}
          />
        </>
      )}
    </Modal>
  )
}
