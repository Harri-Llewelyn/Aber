import React, { useMemo, useState } from 'react'
import { api } from '../../api'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { ApplyResults } from '../common/ApplyResults'
import { IconClipboardList } from '../common/Icons'
import { describeApply, useApplyPreview } from '../../hooks/useApplyPreview'
import { useFormCheck } from '../../hooks/useFormCheck'
import { parseAutomationsYaml } from '../../utils/automationYaml'
import { plural } from '../../utils/format'
import { schemaUrl, tabUrl } from '../../routes'
import { refusedCount } from '../../utils/automations'
import {
  appliedSchemaWords, schemaResultName, schemaResultNote, writtenSchemas,
} from '../../utils/deviceSchemas'

/**
 * What a file of schemas would do, before it does anything: each schema as new, changed (a new draft
 * version), unchanged or refused, with every reason and the line it is on. The text is parsed here, and
 * a syntax error is shown with its line without asking the database. Otherwise the check is
 * `apply_device_schemas(doc, true)`, and confirming is the same call with `false`: all of it applies or
 * none of it does. It deletes nothing and never edits a published version. A refusal from the second
 * call, such as the second-factor switch's, is shown in the dialog as it was worded. The preview and its
 * list are the ones the Automations page's dialog draws (useApplyPreview, ApplyResults).
 *
 * @param {string} text The YAML to check and apply.
 * @param {string} [source] Where it came from, "device-schemas.yaml", for the title.
 * @param {Function} showToast Says the act once it is applied: an applied file writes Audit Trail rows, so it ends in a success toast that links to what it made.
 * @param {Function} onApplied Called with the results once everything is applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function ApplySchemasModal({ text, source = null, showToast, onApplied, onClose }) {
  const parsed = useMemo(() => parseAutomationsYaml(text), [text])
  const [preview, setPreview] = useApplyPreview(parsed, () => api.applyDeviceSchemas(parsed.document, true))
  const [applyError, setApplyError] = useState(null)
  const [applying, setApplying] = useState(false)
  const { results, refused, written, unread, checking, problem, held, unchanged, count } = describeApply(preview, parsed, 'schema')
  const check = useFormCheck({}, { unchanged })

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
      title={`Apply ${source ? source : 'Schemas'}`}
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
          {`Apply ${plural(written, 'Schema')}`}
        </ActionButton>
      )}
    >
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
