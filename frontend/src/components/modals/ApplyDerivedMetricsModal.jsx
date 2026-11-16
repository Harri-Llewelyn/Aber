import React, { useMemo, useState } from 'react'
import { api } from '../../api'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { ApplyResults } from '../common/ApplyResults'
import { IconTag } from '../common/Icons'
import { describeApply, useApplyPreview } from '../../hooks/useApplyPreview'
import { parseAutomationsYaml } from '../../utils/automationYaml'
import { plural } from '../../utils/format'
import { metricUrl, tabUrl } from '../../routes'
import { refusedCount } from '../../utils/automations'
import {
  appliedDerivedWords, derivedResultName, derivedResultNote, writtenDerived,
} from '../../utils/derivedMetricsFile'

/**
 * What a file of derived metrics would do, before it does anything: each metric as new, unchanged or
 * refused, with every reason and the line it is on. The text is parsed here, and a syntax error is
 * shown with its line without asking the database. Otherwise the check is
 * `apply_derived_metrics(doc, true)`, and confirming is the same call with `false`: all of it is added
 * or none of it is. It edits and deletes nothing, so a definition that changed is refused, never
 * applied. A refusal from the second call, such as the second-factor switch's, is shown in the dialog
 * as it was worded. The preview and its list are the ones the Automations page's dialog draws
 * (useApplyPreview, ApplyResults).
 *
 * @param {string} text The YAML to check and add.
 * @param {string} [source] Where it came from, "derived-metrics.yaml", for the title; the editor's own text has none.
 * @param {Function} showToast Says the act once it is applied: an added metric writes an Audit Trail row, so it ends in a success toast that links to what it made.
 * @param {Function} [onChecked] Called with each preview's refusals, so the editor can mark them on their lines.
 * @param {Function} onApplied Called with the results once everything is added; the caller closes the dialogs.
 * @param {Function} onClose
 */
export function ApplyDerivedMetricsModal({ text, source = null, showToast, onChecked, onApplied, onClose }) {
  const parsed = useMemo(() => parseAutomationsYaml(text), [text])
  const [preview, setPreview] = useApplyPreview(parsed, () => api.applyDerivedMetrics(parsed.document, true), onChecked)
  const [applyError, setApplyError] = useState(null)
  const [applying, setApplying] = useState(false)
  const { results, refused, written, unread, problem, held, heldTitle, count } = describeApply(preview, parsed, 'derived metric')

  const confirm = async () => {
    setApplyError(null)
    setApplying(true)
    try {
      const done = await api.applyDerivedMetrics(parsed.document, false)
      // Another writer may have changed what the file refers to since the preview.
      if (refusedCount(done) > 0) {
        setPreview({ phase: 'ready', results: done, error: null })
        onChecked?.(done.flatMap(r => r.reasons || []))
        return
      }
      const made = writtenDerived(done)
      showToast(appliedDerivedWords(done, source), 'success', { to: made.length === 1 ? metricUrl(made[0].id, false, true) : tabUrl('metrics', 'derived') })
      onApplied(done)
    } catch (e) {
      setApplyError(e.message || 'The derived metrics could not be added.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={`Add ${source ? source : 'derived metrics'}`}
      icon={<IconTag size={18} />}
      size="lg"
      lead="Adds the whole file, all of it or none. A derived metric that exists is never edited, since a definition is fixed once saved. It deletes nothing."
      problem={problem}
      touched
      error={applyError}
      onClose={applying ? () => {} : onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={applying}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={applying}
            pendingLabel="Adding…"
            disabled={held}
            title={heldTitle}
            onClick={confirm}
          >
            {`Add ${plural(written, 'Derived Metric')}`}
          </ActionButton>
        </>
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
            {count.map(s => `${s.n} ${s.label.toLowerCase()}`).join(', ') || 'The file holds no derived metric.'}
          </p>
          {written === 0 && refused === 0 && results.length > 0 && (
            <p className="apply-note">Every derived metric here is already as the file says. Nothing would be added.</p>
          )}
          <ApplyResults
            results={results}
            parsed={parsed}
            label="What each derived metric would become"
            nameOf={derivedResultName}
            noteOf={derivedResultNote}
          />
        </>
      )}
    </Modal>
  )
}
