import React from 'react'
import { locateReasons } from '../../utils/automationYaml'
import { RESULT_STATUSES, resultStatus } from '../../utils/automations'

/**
 * What each item of a file would become, in an apply dialog: its status, its name, a note that says
 * what the apply would do to it, and for a refusal every reason with the line it is on. The refused
 * come first, then the new, the changed and the unchanged. Shared by the dialogs that apply a file
 * of automations and a file of schemas.
 *
 * @param {Array} results The database's results, `{ index, status, reasons, ... }` each.
 * @param {object} parsed What parseAutomationsYaml() gave for the text, which places a reason on its line.
 * @param {string} label Names the list for a screen reader: "What each automation would become".
 * @param {Function} nameOf A result's name: the key it is shown under.
 * @param {Function} noteOf What the apply would do, in words, or null for nothing to add.
 */
export function ApplyResults({ results, parsed, label, nameOf, noteOf }) {
  return (
    <ul className="apply-results" aria-label={label}>
      {[...results]
        .sort((a, b) => RESULT_STATUSES.findIndex(s => s.value === a.status) - RESULT_STATUSES.findIndex(s => s.value === b.status))
        .map((r, i) => {
          const status = resultStatus(r.status)
          const reasons = locateReasons(parsed, r.reasons)
          const note = noteOf?.(r)
          return (
            <li key={`${r.index}-${i}`} className="apply-result apply-result-block">
              <div className="apply-result-head">
                <span className={`badge badge-sm badge-${status.tone}`}>{status.label}</span>
                <strong className="mono">{nameOf(r)}</strong>
                {note && <span className="apply-changes">{note}</span>}
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
  )
}
