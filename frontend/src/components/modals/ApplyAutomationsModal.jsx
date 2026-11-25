import React, { useId, useMemo, useState } from 'react'
import { api } from '../../api'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { ApplyResults } from '../common/ApplyResults'
import { DropZone } from '../common/DropZone'
import { IconZap } from '../common/Icons'
import { RequiredMark } from '../common/RequiredMark'
import { describeApply, useApplyPreview } from '../../hooks/useApplyPreview'
import { useFormCheck } from '../../hooks/useFormCheck'
import { useYamlFile } from '../../hooks/useYamlFile'
import { AUTOMATION_FILE_MAX_BYTES, parseAutomationsYaml } from '../../utils/automationYaml'
import { plural } from '../../utils/format'
import { automationUrl, automationsUrl } from '../../routes'
import { appliedWords, changeWords, refusedCount } from '../../utils/automations'

/**
 * What a file, or the editor's text, would do, before it does anything: each automation as new,
 * changed, unchanged or refused, with every reason and the line it is on. The text is parsed here,
 * and a syntax error is shown with its line without asking the database. Otherwise the check is
 * `apply_automations(doc, true)`, and confirming is the same call with `false`: all of it applies or
 * none of it does, and nothing is deleted. A refusal from the second call, such as the second-factor
 * switch's, is shown in the dialog as it was worded. The preview and its list are shared with the
 * dialog that applies a file of schemas (useApplyPreview, ApplyResults).
 *
 * Given no text it is the upload's dialog: its first step is the file, in a drop zone, and another file
 * chosen there is checked in place of the one before.
 *
 * @param {string|null} [text] The editor's YAML, to check and apply. Null for an upload, which asks for a file.
 * @param {'Save'|'Apply'} verb The act, which the confirm button repeats with the count: "Apply 3 Automations".
 * @param {Function} showToast Says the act once it is applied: an applied file writes Audit Trail rows, so it ends in a success toast that links to what it made.
 * @param {Function} onChecked Called with each preview's results, so the editor can mark the refusals on their lines.
 * @param {Function} onApplied Called with the results once everything is applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function ApplyAutomationsModal({ text = null, verb = 'Apply', showToast, onChecked, onApplied, onClose }) {
  const uid = useId()
  const uploads = text === null
  const upload = useYamlFile({ maxBytes: AUTOMATION_FILE_MAX_BYTES, holds: 'a file of automations' })
  const source = upload.file?.name ?? null
  const parsed = useMemo(
    () => (text === null ? upload.file && parseAutomationsYaml(upload.file.text) : parseAutomationsYaml(text)),
    [text, upload.file]
  )
  // `checking` until the preview is in; then the results, or the reason the check failed.
  const [preview, setPreview] = useApplyPreview(parsed, () => api.applyAutomations(parsed.document, true), onChecked)
  const [applyError, setApplyError] = useState(null)
  const [applying, setApplying] = useState(false)
  const { results, refused, written, unread, checking, problem, held, unchanged, count } = describeApply(preview, parsed, 'automation')
  const check = useFormCheck(uploads ? { file: { id: `${uid}-file`, missing: upload.missing } } : {}, { unchanged })

  const confirm = async () => {
    setApplyError(null)
    setApplying(true)
    try {
      const done = await api.applyAutomations(parsed.document, false)
      // Another writer may have changed what the file refers to since the preview.
      if (refusedCount(done) > 0) {
        setPreview({ phase: 'ready', results: done, error: null })
        onChecked?.(done.flatMap(r => r.reasons || []))
        return
      }
      const written = done.filter(r => r.status === 'new' || r.status === 'changed')
      showToast(appliedWords(done, source), 'success', { to: written.length === 1 ? automationUrl(written[0].key) : automationsUrl() })
      onApplied(done)
    } catch (e) {
      setApplyError(e.message || 'The automations could not be applied.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={uploads && !source ? 'Upload Automations' : `${verb} ${source ? source : 'Automations'}`}
      icon={<IconZap size={18} />}
      size="lg"
      lead={verb === 'Save'
        ? 'Saves what the editor holds, all of it or none. An automation saved under a new id is a new one: the old one stays as it is.'
        : 'Applies the whole file, all of it or none. It deletes nothing: an automation the file leaves out stays as it is.'}
      problem={problem ?? check.problem}
      error={applyError}
      busy={applying}
      onClose={onClose}
      dismiss="Cancel"
      footer={(
        <ActionButton
          className="btn btn-primary"
          pending={applying || checking}
          pendingLabel={checking ? 'Checking…' : verb === 'Save' ? 'Saving…' : 'Applying…'}
          disabled={held}
          onClick={() => check.press(confirm)}
        >
          {parsed ? `${verb} ${plural(written, 'Automation')}` : 'Apply Automations'}
        </ActionButton>
      )}
    >
      {uploads && (
        <div className="form-group">
          <label className="form-label" id={`${uid}-file-label`} htmlFor={`${uid}-file`}>File <RequiredMark /></label>
          <DropZone
            id={`${uid}-file`}
            labelledBy={`${uid}-file-label`}
            required
            prompt="Drop a file of automations here, or click to choose one"
            {...upload.zone}
            error={upload.zone.error ?? check.errors.file}
            disabled={applying}
            testId="automations-file"
          />
        </div>
      )}

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
            {count.map(s => `${s.n} ${s.label.toLowerCase()}`).join(', ') || 'The file holds no automation.'}
          </p>
          {written === 0 && refused === 0 && results.length > 0 && (
            <p className="apply-note">Every automation here is already as the file says. Nothing would change.</p>
          )}
          <ApplyResults
            results={results}
            parsed={parsed}
            label="What each automation would become"
            nameOf={r => r.key ?? (r.index === null || r.index === undefined ? 'The file' : `Automation ${r.index + 1}`)}
            noteOf={r => (r.status === 'changed' && r.changes?.length > 0 ? `changes ${changeWords(r.changes)}` : null)}
          />
        </>
      )}
    </Modal>
  )
}
