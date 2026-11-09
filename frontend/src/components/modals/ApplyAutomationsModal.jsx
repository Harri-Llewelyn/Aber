import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { Modal } from '../common/Modal'
import { ActionButton } from '../common/ActionButton'
import { IconZap } from '../common/Icons'
import { locateReasons, parseAutomationsYaml } from '../../utils/automationYaml'
import { plural } from '../../utils/format'
import { automationUrl, automationsUrl } from '../../routes'
import { RESULT_STATUSES, appliedWords, changeWords, refusedCount, resultStatus, writtenCount } from '../../utils/automations'

/**
 * What a file, or the editor's text, would do, before it does anything: each automation as new,
 * changed, unchanged or refused, with every reason and the line it is on. The text is parsed here,
 * and a syntax error is shown with its line without asking the database. Otherwise the check is
 * `apply_automations(doc, true)`, and confirming is the same call with `false`: all of it applies or
 * none of it does, and nothing is deleted. A refusal from the second call, such as the second-factor
 * switch's, is shown in the dialog as it was worded.
 *
 * @param {string} text The YAML to check and apply.
 * @param {string} [source] Where it came from, "automations.yaml", for the lead; the editor's own text has none.
 * @param {'Save'|'Apply'} verb The act, which the confirm button repeats with the count: "Apply 3 Automations".
 * @param {Function} showToast Says the act once it is applied: an applied file writes Audit Trail rows, so it ends in a success toast that links to what it made.
 * @param {Function} onChecked Called with each preview's results, so the editor can mark the refusals on their lines.
 * @param {Function} onApplied Called with the results once everything is applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function ApplyAutomationsModal({ text, source = null, verb = 'Apply', showToast, onChecked, onApplied, onClose }) {
  const parsed = useMemo(() => parseAutomationsYaml(text), [text])
  // `checking` until the preview is in; then the results, or the reason the check failed.
  const [preview, setPreview] = useState({ phase: 'checking', results: [], error: null })
  const [applyError, setApplyError] = useState(null)
  const [applying, setApplying] = useState(false)
  const checked = useRef(onChecked)
  checked.current = onChecked

  useEffect(() => {
    if (parsed.document === null) {
      setPreview({ phase: 'unread', results: [], error: null })
      return undefined
    }
    let live = true
    setPreview({ phase: 'checking', results: [], error: null })
    api.applyAutomations(parsed.document, true).then(
      results => {
        if (!live) return
        setPreview({ phase: 'ready', results, error: null })
        checked.current?.(results.flatMap(r => r.reasons || []))
      },
      e => { if (live) setPreview({ phase: 'failed', results: [], error: e.message || 'The check could not be made.' }) }
    )
    return () => { live = false }
  }, [parsed])

  const { results } = preview
  const refused = refusedCount(results)
  const written = writtenCount(results)
  const unread = preview.phase === 'unread'

  const problem = unread
    ? (parsed.empty ? 'The file is empty. Write at least one automation.' : 'The file is not YAML the page can read. Fix the lines below first.')
    : refused > 0 ? `${plural(refused, 'automation')} refused. Fix the lines named above, then try again.` : null

  const confirm = async () => {
    setApplyError(null)
    setApplying(true)
    try {
      const done = await api.applyAutomations(parsed.document, false)
      // Another writer may have changed what the file refers to since the preview.
      if (refusedCount(done) > 0) {
        setPreview({ phase: 'ready', results: done, error: null })
        checked.current?.(done.flatMap(r => r.reasons || []))
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

  const located = (result) => locateReasons(parsed, result.reasons)
  const count = RESULT_STATUSES
    .map(s => ({ ...s, n: results.filter(r => r.status === s.value).length }))
    .filter(s => s.n > 0)

  const held = unread || preview.phase !== 'ready' || refused > 0 || written === 0
  const heldTitle = unread ? problem
    : preview.phase === 'checking' ? 'Checking the file…'
      : preview.phase === 'failed' ? preview.error
        : refused > 0 ? problem
          : written === 0 ? 'Every automation here is already as the file says, so nothing would change.' : undefined

  return (
    <Modal
      title={`${verb} ${source ? source : 'automations'}`}
      icon={<IconZap size={18} />}
      size="lg"
      lead={verb === 'Save'
        ? 'Saves what the editor holds, all of it or none. An automation saved under a new id is a new one: the old one stays as it is.'
        : 'Applies the whole file, all of it or none. It deletes nothing: an automation the file leaves out stays as it is.'}
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
            pendingLabel={`${verb === 'Save' ? 'Saving' : 'Applying'}…`}
            disabled={held}
            title={heldTitle}
            onClick={confirm}
          >
            {`${verb} ${plural(written, 'Automation')}`}
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
            {count.map(s => `${s.n} ${s.label.toLowerCase()}`).join(', ') || 'The file holds no automation.'}
          </p>
          {written === 0 && refused === 0 && results.length > 0 && (
            <p className="apply-note">Every automation here is already as the file says. Nothing would change.</p>
          )}
          <ul className="apply-results" aria-label="What each automation would become">
            {[...results]
              .sort((a, b) => RESULT_STATUSES.findIndex(s => s.value === a.status) - RESULT_STATUSES.findIndex(s => s.value === b.status))
              .map((r, i) => {
                const status = resultStatus(r.status)
                const reasons = located(r)
                return (
                  <li key={`${r.index}-${i}`} className="apply-result apply-result-block">
                    <div className="apply-result-head">
                      <span className={`badge badge-sm badge-${status.tone}`}>{status.label}</span>
                      <strong className="mono">{r.key ?? (r.index === null || r.index === undefined ? 'The file' : `Automation ${r.index + 1}`)}</strong>
                      {r.status === 'changed' && r.changes?.length > 0 && (
                        <span className="apply-changes">changes {changeWords(r.changes)}</span>
                      )}
                    </div>
                    {reasons.length > 0 && (
                      <ul className="apply-reasons">
                        {reasons.map((reason, j) => (
                          <li key={j}>
                            <span className="apply-line mono">Line {reason.line}</span>
                            <span>{reason.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
          </ul>
        </>
      )}
    </Modal>
  )
}
