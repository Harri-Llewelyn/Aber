import React from 'react'
import { locateReasons } from '../../utils/automationYaml'
import { RESULT_STATUSES, resultStatus } from '../../utils/automations'

/** A value a change shows: its text, or the word None where there is nothing. */
function changeValue(value) {
  if (value === null || value === undefined || value === '') return <span className="apply-none">None</span>
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * What each item of a file would become, in an apply dialog: its status, its name, a note that says
 * what the apply would do to it, and for a refusal every reason with the line it is on. The refused
 * come first, then the new, the changed and the unchanged. Shared by the dialogs that apply a file
 * of automations, of schemas and of derived metrics.
 *
 * @param {Array} results The database's results, `{ index, status, reasons, ... }` each.
 * @param {object} parsed What parseAutomationsYaml() gave for the text, which places a reason on its line.
 * @param {string} label Names the list for a screen reader: "What each automation would become".
 * @param {Function} nameOf A result's name: the key it is shown under.
 * @param {Function} noteOf What the apply would do, in words, or null for nothing to add.
 * @param {Function} [changesOf] What a changed result differs in, `[{ key, label, before, after }]`
 *   (resultChanges() reads it from a result): each key is drawn under the result's head with its old
 *   and new value in words, "Before" and "After", and None for an empty one. Without it nothing is drawn.
 */
export function ApplyResults({ results, parsed, label, nameOf, noteOf, changesOf }) {
  return (
    <ul className="apply-results" aria-label={label}>
      {[...results]
        .sort((a, b) => RESULT_STATUSES.findIndex(s => s.value === a.status) - RESULT_STATUSES.findIndex(s => s.value === b.status))
        .map((r, i) => {
          const status = resultStatus(r.status)
          const reasons = locateReasons(parsed, r.reasons)
          const note = noteOf?.(r)
          const changes = changesOf?.(r) ?? []
          return (
            <li key={`${r.index}-${i}`} className="apply-result apply-result-block">
              <div className="apply-result-head">
                <span className={`badge badge-sm badge-${status.tone}`}>{status.label}</span>
                <strong className="mono">{nameOf(r)}</strong>
                {note && <span className="apply-changes">{note}</span>}
              </div>
              {changes.length > 0 && (
                <ul className="apply-diffs" aria-label={`What changes in ${nameOf(r)}`}>
                  {changes.map(c => (
                    <li key={c.key} className="apply-diff">
                      <span className="apply-diff-key">{c.label}</span>
                      <dl className="apply-diff-pair">
                        <dt>Before</dt>
                        <dd>{changeValue(c.before)}</dd>
                        <dt>After</dt>
                        <dd>{changeValue(c.after)}</dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
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
  )
}
